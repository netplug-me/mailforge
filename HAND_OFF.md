# cf-mail-tui / switchboard.llc mail — Hand-off

**Date:** September 23, 2026 (updated October 5, 2026: `rcpsolutions.net`, `netplug.org`, `clank.pub`, `pinpoint.host` verified in Postmark, see §10)
**Status:** Inbound mail for `switchboard.llc` and `rcpsolutions.net` is live and has been tested from the public internet into the mailbox.
Outbound mail is relayed through Postmark (see `outbound/README.md`); tested to Yahoo and Gmail.
**Host:** this workstation (Docker). The home IP is not published anywhere and port 25 does not need to be reachable.

---

## 1. Architecture

```
Sender ─SMTP─▶ Cloudflare Email Routing (MX: route{1,2,3}.mx.cloudflare.net)
                   │ catch-all rule: *@switchboard.llc
                   ▼
            Email Worker  switchboard-llc-inbound
                   │ HTTPS POST, HMAC-signed (BRIDGE_SECRET), ±5 min timestamp
                   ▼
            mail-ingest.switchboard.llc  (proxied CNAME → Cloudflare Tunnel)
                   │
   Docker network: cloudflared ─▶ inbound-bridge:8025 ─SMTP─▶ mailserver:25 (docker-mailserver)
```

- The message is passed through byte-for-byte, so the sender's DKIM signatures stay valid.
- Unknown mailbox → the mail server answers `550`, and the Worker calls `setReject` → the sender gets a bounce.
- Bridge or tunnel down, or a `4xx` → the Worker throws, so mail is never accepted and then silently dropped.
- Requests without a valid signature get `401` at the bridge and never reach the mail server.

## 2. What runs where

| Component | Location | Notes |
|---|---|---|
| docker-mailserver | container `mailserver` | `mail.switchboard.llc`, TLS via Let's Encrypt, `PERMIT_DOCKER=connected-networks` |
| inbound-bridge | container `cf-mail-tui-inbound-bridge-1` | `inbound/bridge/server.mjs`, node:22-alpine, no deps |
| cloudflared | container `cf-mail-tui-cloudflared-1` | tunnel `switchboard-llc-inbound` (`e8226319-3580-4d88-a40d-3ce094d91d92`) |
| Email Worker | Cloudflare, `switchboard-llc-inbound` | `inbound/worker/worker.js`, vars `BRIDGE_URL`, secret `BRIDGE_SECRET` |
| Cert renewal | user crontab, 03:17 & 15:17 daily | `scripts/renew-cert.sh`, log in `logs/renew-cert.log` |

Start/stop the stack (from `~/dev/cf-mail-tui`):
```bash
docker compose -f compose.yaml -f inbound/compose.inbound.yaml up -d
docker compose -f compose.yaml -f inbound/compose.inbound.yaml ps
docker compose -f compose.yaml -f inbound/compose.inbound.yaml logs -f inbound-bridge
```
All services use `restart: always` or `unless-stopped`, so they come back after a reboot.

## 3. Secrets and where they live (never commit these)

| Secret | File | Mode |
|---|---|---|
| Cloudflare API token, account id, NetPlug tunnel tokens | `~/cloudflare-api-key` | 600 |
| `CF_API_TOKEN`, `BRIDGE_SECRET`, `CF_TUNNEL_TOKEN` | `~/dev/cf-mail-tui/.env` (git-ignored) | 600 |
| postmaster mailbox password | `~/switchboard-mail-credentials` | 600 |
| Mailbox password hashes | `docker-data/dms/config/postfix-accounts.cf` | 600 |
| TLS cert + key | `/etc/letsencrypt/live/mail.switchboard.llc/` (root-only) | |

The Cloudflare token is an **account** token for NetPlug.me LLC (it expires 2027-05-29). Verify it with
`/accounts/{id}/tokens/verify`; the `/user/tokens/verify` endpoint rejects it.
Permissions in use: Zone DNS Edit, Zone Email Routing Rules Edit, Account Workers Scripts Edit, Account Cloudflare Tunnel Edit.

## 4. Cloudflare changes made on switchboard.llc

- Email Routing **enabled** (status `ready`). Cloudflare added its three MX records.
- Removed the MX record `switchboard.llc → mail.switchboard.llc`. No A record existed for that host, so it never received mail.
- SPF changed from `v=spf1 mx ~all` to `v=spf1 include:_spf.mx.cloudflare.net mx ~all`.
- Added a proxied CNAME `mail-ingest.switchboard.llc → <tunnel-id>.cfargotunnel.com`.
- Catch-all rule → Worker `switchboard-llc-inbound`.
- `_dmarc` (`p=none`), the apex A records and `www` are untouched.

The TUI's DNS check accepts Cloudflare Email Routing MX hosts as valid, and "Sync records" skips the MX and SPF when
they are already Email Routing / Postmark-managed (so it can't re-add the mail-host MX or overwrite the SPF).

`inbound/setup_cloudflare.py` recreates all of this idempotently (`--dry-run` first).

## 5. Fixes made to cf-mail-tui tonight

1. **Container crash loop.** The old `mailserver` container was a leftover opencode test (`/tmp/opencode/test-dms`,
   hostname `mail.mycorp.com`, `SSL_TYPE=letsencrypt` with no cert), restarting every ~15 s. It has been removed.
2. **Compose template** (`src/services/dms.ts`):
   - Now mounts `/etc/letsencrypt:ro`. Without it, a valid cert was invisible to the container.
   - Adds `env_file` for `docker-data/dms/config/mailserver.env`, which was being written but never loaded.
   - `SSL_TYPE` is configurable in `.env` (default `letsencrypt`).
   - `init` warns when the cert is missing, and says "cannot verify" instead when `/etc/letsencrypt` is root-only.
3. **TUI** (`src/tui/app.ts`, `dashboard.ts`): action results no longer vanish. There's a "Press Enter to return to the menu"
   pause after each action, and the redraw no longer uses `console.clear()`, which wiped scrollback.
4. This directory is now a git repo; the edits above are committed. `.gitignore` excludes `.env`, `docker-data/` and `postmark.api.key.*`.

## 6. Certificate

- Issued via DNS-01 (Cloudflare), with nothing exposed. ECDSA, issuer Let's Encrypt YE1, **expires 2026-12-22**.
- `scripts/renew-cert.sh` runs certbot in Docker (`certbot/dns-cloudflare`) and writes the token to a temp file
  that is always deleted. If the cert fingerprint changes, it restarts postfix and dovecot.
  Tested: a real run (correctly "not due") and a `--dry-run` against staging (simulated renewal succeeded).
- Manual: `scripts/renew-cert.sh --dry-run` then `tail logs/renew-cert.log`.

## 7. Verification done

| Test | Result |
|---|---|
| Signed POST to `https://mail-ingest.switchboard.llc/ingest` for postmaster | `250 queued`, message in postmaster INBOX |
| Unsigned POST | `401 bad signature` |
| Signed POST for a non-existent mailbox | `550 User unknown` → Worker bounces |
| Worker code run locally against the bridge | signatures match, reject/throw paths correct |
| Public MX (1.1.1.1, 8.8.8.8) | Cloudflare `route1-3.mx.cloudflare.net` |

## 8. Code review — 2026-10-02

Full read-through of `src/`, the inbound/outbound pipelines, and the tests (typecheck clean, all three test suites pass, tree clean).

**What holds up:** the inbound pipeline (HMAC over `ts\nfrom\nto\nsha256(body)`, `timingSafeEqual`, 300 s skew, 26 MiB cap, `ADDR` regex blocking CRLF injection into SMTP commands, dot-stuffing, Worker 422→`setReject` / else throw so mail is never silently accepted-and-dropped); the TUI (single-prompt invariant, fixed-height panels, Esc-as-back); the TXT upsert fix with regression tests; the conditional compose overrides that keep a plain `compose up` from dropping `PERMIT_DOCKER` or the Postmark relay.

**Issues found (in priority order):**

1. **FIXED 2026-10-02 — `domain-manager.ts` reports success on failure.** `addDomain` never checks the `ExecResult` of `addAccount`/`setQuota`/`addAlias` — the TUI prints `Accounts: …` even when `setup email add` failed; DKIM generation errors are swallowed (`catch {}`). `removeDomain` swallows `delAccount` errors.
2. **FIXED 2026-10-02 (see §10) — `removeDomain` takes the whole stack down** (`composeDown` → `composeUp`): inbound bounces for the window, and a failed `composeUp` leaves the server stopped with no rollback. `addDomain` runs a sync `composeUp(true)` (30 s+ force-recreate) inside the TUI, freezing rendering; the async variants exist but aren't used on this path. Both also race DMS init (`compose up -d` returns before the container is ready, so `setup email add` right after is flaky).
3. **The delete side is careless where the sync side is careful.** `syncDomainDns` skips CF Email Routing MX and preserves managed SPF, but `deleteDomainDns` deletes *all* MX records on the domain (including CF's) and *any* TXT containing `v=spf1` (including the Postmark-included one). It also lists only the first 100 zone records (no pagination), so on a busy zone deletion silently misses records.
4. **`any` leaks**: `syncDns(): Promise<any>`, `dnsSyncResult?: any`, `postmark(): Promise<any>`, `parsePostmarkStats(json: any)`, and `err: any` throughout.
5. **`OpsService` builds `new DockerService()` with no projectDir** → cwd-dependent; `serviceState` filters on `com.docker.compose.project.working_dir`, so the health header silently reports "not deployed" when run from anywhere but the project root.
6. **Config side effects**: `composeArgs()` calls `getAppConfig()` purely to load `.env` into `process.env`; `dotenv.config({ override: true })` lets the project `.env` override real environment variables.
7. **README drift**: architecture section lists `app.ts` (it's `app.tsx`), omits `ops.ts`/`ui.ts`/`view.tsx`, the Toolbox, and the inbound/outbound pipeline; the token-permission note contradicts the account token in §3.

**Minor:** mutable image tags (`docker-mailserver:latest`, `cloudflared:latest` — DMS majors have breaking config changes); `checkSpf`/`checkDmarc` don't strip surrounding quotes, so a quoted record reads "missing"; `getZoneForDomain` fallback lists only 50 zones while `listZones()` paginates; `cert()` hardcodes the letsencrypt path regardless of `SSL_TYPE`; stray `postmark.api.key.curl.tzt` in the repo root.

**Suggested order of attack:** (1) and (2) are done; remaining: (3) align `deleteDomainDns` with the sync side (skip CF routing MX, delete only the managed SPF tag, paginate `listRecords`); (4) typing pass + README refresh.

## 9. Open items / next steps

1. **Inbound from the public internet:** DONE (2026-10-01). A real Gmail message to `postmaster@` went Email Routing → Worker →
   bridge → DMS and landed in the INBOX (amavis `Passed CLEAN`).
2. **Outbound mail:** DONE via Postmark (`outbound/compose.outbound.yaml`, token in `.env` as `POSTMARK_SERVER_TOKEN`).
   SPF now `v=spf1 include:_spf.mx.cloudflare.net include:spf.mtasv.net mx ~all` (applied 2026-10-01 with
   `inbound/setup_cloudflare.py`). DNS checked 2026-10-01: SPF record correct, `pm-bounces` CNAME → `pm.mtasv.net`, DMARC `p=none; aspf=r`.
   **Verified 2026-10-01:** a relayed test to Gmail landed in the inbox with `dkim=pass` (`d=switchboard.llc`, selector
   `20261002040946pm`, plus Postmark's own `pm.mtasv.net`), `spf=pass` via `pm-bounces.switchboard.llc`, and `dmarc=pass`.
   Remaining: consider DMARC `p=quarantine` after a week or two of clean reports.
3. **Remote client access:** NOT DONE — needs Zero Trust permissions the API token doesn't list, plus a WARP client on each device.
   Runbook (do it in the Cloudflare dashboard, Zero Trust):
   1. Settings → WARP Client → enable device enrolment; add a device-enrolment policy for your email.
   2. Networks → Tunnels → `switchboard-llc-inbound` → Private networks: route the Docker subnet of this compose project
      (`docker network inspect cf-mail-tui_default`) through the tunnel. Remove that CIDR from the Split Tunnels *exclude* list
      (or switch to "include" mode) so WARP sends it through.
   2b. **Pin the addresses first.** WARP routes a fixed CIDR and clients point at a fixed IP, but `compose down` (a TUI menu item)
      removes the default network and the next `up` may pick a different subnet. In `compose.yaml` add a `networks:` block with
      `ipam.config.subnet` (e.g. `172.28.0.0/24`) and give `mailserver` a fixed `ipv4_address` (e.g. `172.28.0.10`);
      then route exactly that CIDR in step 2.
   3. Install WARP on the phone/laptop, enrol, then point the mail client at the mailserver's container IP
      (or add a Local DNS / hosts entry `mail.switchboard.llc` → container IP) on ports **993** (IMAPS) and **587/465** (submission).
   Constraints:
   - **Never route port 25.** `PERMIT_DOCKER=connected-networks` treats traffic arriving from cloudflared's network as trusted;
     port 25 through the tunnel would be an open relay for anyone in the WARP org.
   - **Tunnel config is remotely managed:** a PUT to `/cfd_tunnel/{id}/configurations` replaces the whole ingress list.
     GET it first and keep the `mail-ingest.switchboard.llc → http://inbound-bridge:8025` rule and the final `404` catch-all;
     then re-run the signed POST test in §7.
   - **fail2ban:** remote clients all appear as cloudflared's container IP, so a few failed logins would ban everyone.
     Add that IP to `fail2ban-jail.cf` `ignoreip` (or leave `ENABLE_FAIL2BAN` off for those ports).
3b. **TUI Toolbox** (`./mailctl` ▸ Toolbox): mail queue, delivery log, mailbox usage, connected clients, fail2ban, TLS expiry,
   mail-path check, Postmark stats, send-test-email. The header shows cert days left and bridge/tunnel/relay state.
4. **More mailboxes and aliases:** use the TUI (`./mailctl`) or `docker exec mailserver setup email add …`.
   Mailboxes now: `postmaster@switchboard.llc`, `lham@switchboard.llc`, `law@ham.switchboard.llc`.
5. **DKIM for outbound** is handled by Postmark (verified domain), so DMS's own DKIM keys are not needed for relayed mail.
6. **Container warnings (still present 2026-10-01; left alone because the server works):** docker-mailserver warns that running Rspamd alongside Amavis/SpamAssassin/OpenDKIM/OpenDMARC
   is discouraged. It isn't a problem, but consider slimming the enabled services later.
7. **Code-review fixes:** see §8 (2026-10-02) — items 1–2 are fixed; items 3–7 remain (next: `deleteDomainDns` alignment with the sync side).
8. **`rcpsolutions.net` follow-ups:** see §10 (WorkMail org retirement, `scarletmoon.org` mail, `whitetower.us`).

## 10. Domain migration and TUI domain changes — 2026-10-02

**TUI changes**
- **Zones box hide-list:** `TUI_HIDE_ZONES` in `.env` (comma separated; documented in `.env.example`) hides Cloudflare zones from the TUI.
  Display only: nothing is changed in Cloudflare. Currently `netplug.me,elite-athelete.com` (both still active zones, DNS untouched).
  Implemented in `config.ts` (`hiddenZones`) and filtered in `tui/dashboard.ts`.
- **Mail domains now registered** (`POSTFIX_VIRTUAL_DOMAINS`): `ham.switchboard.llc`, `rcpsolutions.net` (3 mailboxes), `scarletmoon.org` (0 mailboxes), `clank.pub`, `netplug.org` (2 mailboxes), `pinpoint.host` (2 mailboxes); see "netplug.org and pinpoint.host added" below.
  Added with `mailctl add <domain>` and *without* `--dns`, so Cloudflare DNS and Email Routing records were not touched.
- **`POSTFIX_VIRTUAL_DOMAINS` is TUI-only.** docker-mailserver never reads it; Postfix's `virtual_mailbox_domains` is `/etc/postfix/vhost`,
  generated from the mailboxes/aliases in DMS. A domain only accepts mail once it has a mailbox or alias.
- **`domain-manager.ts`:** `addDomain`/`removeDomain` no longer recreate or take down the container. They return an `errors: string[]`
  (failed mailbox/alias/quota/DKIM/delete operations; existing mailboxes are skipped), shown by the TUI and CLI (`mailctl` exits non-zero).

**rcpsolutions.net moved from AWS WorkMail onto this stack**
- **DNS:** was Wix-hosted nameservers at the AWS Route 53 Domains registrar. Now a Cloudflare zone (active) with registrar nameservers
  `rosa`/`santino.ns.cloudflare.com`. Registrar stays at AWS (DNS management only was moved). The Wix site is kept: apex A records
  `185.230.63.171/.186/.107` and `www` CNAME `cdn3.wixdns.net` (DNS-only, copied from what resolves publicly; Wix panel not inspected, so
  other subdomains, if any, were not copied). Checked after cutover: apex 301, `www` 200.
- **Inbound:** Cloudflare Email Routing enabled; catch-all → the existing Worker `switchboard-llc-inbound` (the Worker has no domain
  filtering, so it serves any domain; unknown mailboxes are rejected by DMS). WorkMail MX removed. SPF
  `v=spf1 include:spf.mtasv.net include:_spf.mx.cloudflare.net ~all`; DMARC `p=none`.
  **Do not run `inbound/setup_cloudflare.py` for additional domains** — it creates a new tunnel/Worker and overwrites `CF_TUNNEL_TOKEN` in `.env`,
  which would break `switchboard.llc` inbound. For a new domain: create the zone, enable Email Routing, and PUT a catch-all rule with
  `actions: [{type: worker, value: [switchboard-llc-inbound]}]`.
- **Mailboxes:** `payments@`, `lham@`, `no-reply@rcpsolutions.net`. Generated passwords are in `~/rcpsolutions-mail-credentials` (mode 600, not in the repo).
- **Verified:** a Gmail message to `payments@rcpsolutions.net` was delivered into its INBOX (amavis `Passed CLEAN`, LMTP `Saved`);
  `./mailctl list` shows MX valid.
- **Other registrar change:** `scarletmoon.org` nameservers also moved to Cloudflare (zone active; no mail configured). `staffsetter.io` ignored.

**netplug.org and pinpoint.host added — 2026-10-02**
- Registered with `mailctl add <domain>` (no `--dns`); DKIM keys generated (selector `mail`). Both were already active Cloudflare zones
  (`rosa`/`santino.ns.cloudflare.com`) with no MX records, so no live mail was affected.
- Inbound: Email Routing enabled on both (Cloudflare added its MX and SPF) and a catch-all rule → Worker `switchboard-llc-inbound`, same recipe as `rcpsolutions.net`.
- `netplug.org` was an empty zone; added DMARC `v=DMARC1; p=none; aspf=r`. `pinpoint.host` kept its existing records
  (Wix-style A records, `partners` tunnel CNAME, `www`, GoDaddy `_domainconnect`, DMARC `p=quarantine`).
- **Mailboxes:** `postmaster@` and `lham@` on each domain. Generated passwords are in `~/netplug-pinpoint-mail-credentials` (mode 600, not in the repo).
- **Verified:** a signed POST to `https://mail-ingest.switchboard.llc/ingest` for `postmaster@` on each domain returned `250 queued` and the message
  is in the INBOX (bridge → DMS path only; the Cloudflare Email Routing → Worker leg has not been tested with a real external message).
  Note: Cloudflare's edge returns `403 error code: 1010` for the default Python `urllib` user-agent, so send a `curl/...` user-agent when scripting this test.
- Postmark sender verification: **`netplug.org` DONE 2026-10-05** (see "Postmark sender verification" below); `pinpoint.host` **DONE 2026-10-05** too (same section).

**Postmark sender verification — netplug.org, clank.pub, pinpoint.host — 2026-10-05** (all show verified in Postmark)
- Each zone got, DNS-only: TXT `<selector>pm._domainkey` (Postmark 1024-bit key) and CNAME `pm-bounces` → `pm.mtasv.net` (return-path).
  `netplug.org` selector `20261005171320pm`; `clank.pub` selector `20261005171719pm`; `pinpoint.host` selector `20261005171907pm`.
- SPF now includes `spf.mtasv.net`: `netplug.org` → `v=spf1 include:spf.mtasv.net include:_spf.mx.cloudflare.net ~all`;
  `clank.pub` → `v=spf1 mx include:spf.mtasv.net ~all`; `pinpoint.host` → same as `netplug.org`. DMARC unchanged (`p=none`; `pinpoint.host` keeps its `p=quarantine`). `cf2024-1._domainkey` (netplug.org, pinpoint.host) and `mail._domainkey` (clank.pub) untouched; pinpoint.host's proxied A/CNAME records untouched.
- Scripting note: an authoritative `dig` against the zone was denied by the permission classifier; records were confirmed through the Cloudflare API and Postmark's own check.

**Open follow-ups**
1. **DONE 2026-10-05 — Postmark sender verification for `rcpsolutions.net`.** Added in the Cloudflare zone (DNS-only): TXT `20261005165032pm._domainkey`
   (`k=rsa;p=MIGfMA0G…`, Postmark's 1024-bit key) and CNAME `pm-bounces` → `pm.mtasv.net` (return-path). Both show verified in the Postmark dashboard, so
   `@rcpsolutions.net` can send. SPF already has `include:spf.mtasv.net`; DMARC is still `p=none`. The Cloudflare Email Routing key `cf2024-1._domainkey` is untouched.
   Postmark's first check said "couldn't find your DKIM record" although the record was already live on the authoritative servers; it passed on retry.
2. **WorkMail:** the `rcpsolutions` org (m-a3c2c9ee1ab444c2acd420f2d145fc80, us-east-1) is still alive. Keep it for several days because resolvers
   that cached the old Wix nameservers can take up to ~48 h to see the change, and check its mailboxes for stragglers before deleting it (needs explicit approval).
   The `patterson-ham` org (whitetower.us) is untouched.
3. **`scarletmoon.org`:** needs mailboxes/aliases, Email Routing + catch-all (same recipe as above) before it can receive mail.
4. **`whitetower.us` (do last):** add a Cloudflare zone, create mailboxes for `lawrence@` and `cortnee@` (plus `cindy`, `ebay`, `subs` if wanted), export/import
   existing WorkMail mail, flip nameservers, enable Email Routing, then retire the WorkMail org.
5. **Unused Route 53 hosted zones** (`rcpsolutions.net`, `scarletmoon.org`, `netplug.me`) can be deleted to save the monthly fee; nothing delegates to them any more.
6. Local Claude Code permission rules in `.claude/settings.local.json` (git-ignored) are scoped to the rcpsolutions.net/scarletmoon.org work and can be removed.
