# cf-mail-tui / switchboard.llc mail — Hand-off

**Date:** September 23, 2026 (updated October 5, 2026: `rcpsolutions.net`, `netplug.org`, `clank.pub`, `pinpoint.host`, `scarletmoon.org` verified in Postmark, see §10)
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

Client ─IMAPS/SMTPS─▶ mail.switchboard.llc:993/465/587 (proxied CNAME → Cloudflare Tunnel)
                   │ TCP tunnel rules for IMAP 993, SMTPS 465, Submission 587
                   ▼
   Docker network: cloudflared ─TCP─▶ mailserver:993/465/587 (docker-mailserver)
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
5. **FIXED 2026-10-05 — `serviceState` matched on `com.docker.compose.project.working_dir`**, so the health header reported bridge/tunnel "not deployed" once the project moved to `~/dev/cli/cf-mail-tui` (the containers were created from `~/dev/cf-mail-tui`). It now matches the compose *project name* (the directory's basename). `OpsService` still builds `new DockerService()` with no projectDir (cwd-dependent).
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
3. **Remote client access:** IN PROGRESS (2026-10-08). Design: AWS proxy box (HAProxy TCP passthrough on 993/465/587) →
   WARP (headless, service token) → tunnel private route `172.25.0.10/32` → mailserver. Clients need no agent. Runbook and
   scripts: `aws-proxy/README.md` (provision.sh is dry-run by default; nothing has been created on AWS yet).
   Earlier dead ends, removed: public-hostname `tcp://` ingress rules (one hostname per port needed anyway, and clients
   would need `cloudflared access tcp`), per-client WARP, and a Tailscale idea.
   - **Done (live):** `compose.yaml` pins network `172.25.0.0/16` + mailserver `172.25.0.10`; cloudflared pinned at
     `172.25.0.11` (`compose.inbound.yaml`) and added to fail2ban `ignoreip` (loaded in the running container);
     `setup_cloudflare.py` set `warp-routing` on the tunnel and created the `172.25.0.10/32` route; the old proxied `mail.`
     CNAME is deleted, so **`mail.switchboard.llc` has no DNS record until runbook step 7**.
   - **Done (Zero Trust, via `aws-proxy/setup_zero_trust.py`):** service token `mail-proxy-warp` (creds in gitignored
     `aws-proxy/mdm.xml`), Service Auth policy on "Warp Login App", device profile for the service-token identity
     (Include `172.25.0.10/32`), Gateway TCP proxy on, Gateway allow 993/465/587 + block-rest rules for `172.25.0.10`.
     Left in place on purpose (owner's call, 2026-10-08): token `switchboard-token` and reusable policy
     `sb-service-token-policy`; the policy is App Launcher's only policy (also on Warp Login App). Don't edit App Launcher.
   - **AWS box LIVE (2026-10-08):** `i-0930027a55fdf4f6b` (t3.small, Ubuntu 24.04, us-west-1, account rcp-midway), Elastic IP
     `50.18.195.200`, SG `mail-proxy` (SSH only from 76.127.41.236/32, 993/465/587 open), key `~/.ssh/mail-proxy.pem` on nerdland.
     HAProxy + WARP enrolled via service token; both enabled at boot, WARP reconnects after `warp-svc` restart.
     Verified from the box: cert chain for mail.switchboard.llc over WARP; unauthenticated RCPT rejected on 587 and 465
     (`554 5.7.1 Client host rejected`, source 172.25.0.11); 25 and 143 give no banner (Gateway block).
     DNS: `mail.switchboard.llc` A (DNS only) -> 50.18.195.200 (`MAIL_PUBLIC_IP` in `.env`, via `setup_cloudflare.py`);
     public `openssl s_client -connect mail.switchboard.llc:993` verifies OK.
   - **Confirmed working by the owner (2026-10-08).** Old instance `i-00d6de85c70fb02ec` terminated, and its leftover
     security group `launch-wizard-7` and key pair `mailserver-key` were deleted.
   - **Todo (optional):** PROXY protocol so fail2ban sees real client IPs (today only the HAProxy rate limit protects remote logins).
   Constraints:
   - **Never route 25 or 143 to remote clients.** `PERMIT_DOCKER=connected-networks` trusts the compose network incl.
     cloudflared. 465/587 are safe by Postfix config (`permit_sasl_authenticated,reject`), verified in `master.cf` and to be
     re-proved by the runbook's swaks test.
   - **fail2ban is blind for remote logins** (all arrive from cloudflared, which is ignored). Rate limits live in
     `aws-proxy/haproxy.cfg`; PROXY protocol to dedicated ports is the better follow-up.
   - **Tunnel config is remotely managed:** the PUT replaces everything; the script GETs and merges.
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

**Postmark sender verification — netplug.org, clank.pub, pinpoint.host, scarletmoon.org — 2026-10-05** (all show verified in Postmark)
- Each zone got, DNS-only: TXT `<selector>pm._domainkey` (Postmark 1024-bit key) and CNAME `pm-bounces` → `pm.mtasv.net` (return-path).
  `netplug.org` selector `20261005171320pm`; `clank.pub` selector `20261005171719pm`; `pinpoint.host` selector `20261005171907pm`; `scarletmoon.org` selector `20261005172119pm`.
- SPF now includes `spf.mtasv.net`: `netplug.org` → `v=spf1 include:spf.mtasv.net include:_spf.mx.cloudflare.net ~all`;
  `clank.pub` → `v=spf1 mx include:spf.mtasv.net ~all`; `pinpoint.host` → same as `netplug.org`; `scarletmoon.org` → same as `clank.pub`. DMARC unchanged (`p=none`; `pinpoint.host` keeps its `p=quarantine`). `cf2024-1._domainkey` (netplug.org, pinpoint.host) and `mail._domainkey` (clank.pub, scarletmoon.org) untouched; pinpoint.host's proxied A/CNAME records untouched.
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

## 11. TUI redesign — 2026-10-05

`mailctl` was rebuilt on Ink as three persistent screens (Mailboxes, Domains, Tools) instead of a menu that chains one prompt at a time; see the README for the layout and keys.
- **Mailboxes is the home screen** and is where accounts are added and removed: one dialog adds several mailboxes at once (generated 16-character passwords are shown once and never stored), plus password change, quota set/remove, aliases, per-domain filter, and the mail-app settings for the selected mailbox.
- **New in `DmsService`:** `runSetupAsync` (non-blocking `docker exec … setup`, so the spinner keeps moving) and `updateAccount` (password change). The TUI flows call `runSetupAsync` directly; `DomainManager` is unchanged and still uses the blocking calls.
- **Tests:** `npm test` now includes `test:flows` (flows driven against a fake `setup` runner, so nothing is created or deleted; the post-action refresh still runs read-only `docker inspect` / `doveadm quota get` against the live container) and a rewritten `test:tui` (every screen and dialog at 7 terminal sizes: no overflow, boxes aligned, frame shorter than the terminal; plus the cursor staying visible when scrolling to the end of a long mailbox list).
- **Live check (2026-10-05, throwaway `tuitest…@switchboard.llc`, fully removed afterwards):** add (generated password), password change, quota, alias add/remove and delete all work against the real mail server. Findings: Dovecot only accepts a new or changed login ~7 s after `setup` returns, so the flows now poll `doveadm auth test` and report "test login accepted" (or warn); `setup email del` keeps the mailbox's files, so delete has a "Delete stored mail" toggle (default off) that removes `/var/mail/<domain>/<user>` inside the container (the files belong to uid 5000, so the host cannot remove them; this also means `removeDomain`'s `fs.rmSync` of mail data likely fails on the host, not yet addressed).
- **Cron fixed (2026-10-05):** the cert-renewal crontab entry now points at `~/dev/cli/cf-mail-tui/scripts/renew-cert.sh` (previous crontab saved in the session scratchpad only).
- **Form defaults:** "Publish DNS" (add domain) and "Delete DNS records" (remove domain) now default to **off**. Publishing would point the MX at `mail.switchboard.llc`, which has no reachable port 25 (domains here use Email Routing), and `deleteDomainDns` (§8 item 3) removes every MX and any `v=spf1` TXT named exactly the domain, which on a zone apex includes Email Routing's MX and the Postmark SPF.
- **OPEN, found while testing — the project directory moved but two things still use the old path `/home/lham/dev/cf-mail-tui` (it no longer exists):**
  1. ~~The cert-renewal cron entry~~ **fixed**, see above. The certificate expires **2026-12-22**.
  2. The running `mailserver` container's bind mounts (`docker-data/dms/{config,mail-data,mail-state,mail-logs}`) were created from the old path. They follow the moved directory while the container keeps running, but the next `compose up --force-recreate` or reboot should be done from `~/dev/cli/cf-mail-tui`, and `renew-cert.sh` / the cron line should be checked for the old path. Not changed; needs your go-ahead.

## 12. Webmail (Roundcube) — 2026-10-05

**State: PUBLISHED 2026-10-05 at `https://webmail.switchboard.llc/`**, behind Cloudflare Access (team `netplugme`, one-time PIN, Allow policy for the owner's external email). Log in to Roundcube with the **full mailbox address** and its password; there is no separate Roundcube account. Verified: unauthenticated requests get `302` to `netplugme.cloudflareaccess.com`; the Access PIN then Roundcube login works; the signed-POST inbound test still returns `250 queued` after the tunnel change.
- **Published how:** (1) Access app (self-hosted, created in the Zero Trust dashboard; the API token has no Access permission, so it cannot be read back from here); (2) proxied CNAME `webmail.switchboard.llc → e8226319-3580-4d88-a40d-3ce094d91d92.cfargotunnel.com` (added before the ingress rule and the gate tested first); (3) tunnel ingress is now `mail-ingest.switchboard.llc → http://inbound-bridge:8025`, `webmail.switchboard.llc → http://webmail:80`, then the `404` catch-all (tunnel config version 2); (4) `WEBMAIL_HOSTNAME=webmail.switchboard.llc` in `.env`, so `composeArgs()` now attaches the webmail overlay and the TUI shows the webmail dot and URL.
- **Credentials:** `lham@switchboard.llc` was reset 2026-10-05; the new password is in `~/switchboard-lham-credentials` (mode 600, not in the repo; it was also displayed in a Claude Code session, so change it if that matters).
- **Files:** `webmail/compose.webmail.yaml` (Roundcube `1.6.19-apache`, pinned), `webmail/custom.inc.php`, `webmail/https-behind-proxy.conf`; data in `docker-data/webmail/db` (SQLite, git-ignored). `composeArgs()` attaches the overlay only when `WEBMAIL_HOSTNAME` is set in `.env`; it is **not set yet**, so the TUI's own compose commands do not include webmail. When it is set, the status bar shows a webmail dot and the Mailboxes detail panel shows the URL.
- **Started with** (only the webmail service; the mailserver container was not touched):
  `docker compose -f compose.yaml -f inbound/compose.inbound.yaml -f outbound/compose.outbound.yaml -f webmail/compose.webmail.yaml up -d --no-deps webmail`.
  Use `--no-deps`: this container was created from the old project path, so a plain `up` from here would recreate `mailserver`.
- **How it talks to the mail server:** IMAPS 993 and authenticated submission 587 only, never port 25 (`PERMIT_DOCKER` trusts the whole compose network). It resolves `MX_HOST` to the host gateway (`extra_hosts: host-gateway`) and uses the published ports, so the Let's Encrypt name matches and certificate verification stays on (verified from inside the container with `openssl s_client`). No change to `mailserver`.
- **Verified (throwaway mailbox, removed afterwards):** Roundcube login over IMAPS succeeds; a message composed in Roundcube is accepted by submission with SASL auth and delivered to the mailbox; behind `X-Forwarded-Proto: https` the session cookie is `Secure; HttpOnly`.
- **fail2ban — DONE (found in place 2026-10-05):** `docker-data/dms/config/fail2ban-jail.cf` has `ignoreip = 127.0.0.1/8 172.25.0.1` and the `dovecot`, `postfix` and `custom` jails all report it live. The subnet is now pinned in `compose.yaml` (172.25.0.0/16, gateway 172.25.0.1); cloudflared (172.25.0.11) is ignored too, see §9.3 item 3. Original reasoning: the mail server sees every webmail login from the compose network's gateway `172.25.0.1`. DMS's fail2ban uses `maxretry = 6`, `bantime = 1w`, `nftables-allports`, and `ignoreip = 127.0.0.1/8` only, so six wrong passwords typed into webmail would ban `172.25.0.1` for a week (webmail and any client on this host would lose IMAP/SMTP; inbound mail through cloudflared/bridge uses container addresses and would not be affected). I tried to add an `ignoreip` entry and the permission classifier blocked it, so it was **not** done. Options: add `ignoreip = 127.0.0.1/8 172.25.0.1` in `docker-data/dms/config/fail2ban-jail.cf` (then `docker restart mailserver`, or load it live), or leave fail2ban alone and rely on Cloudflare Access to keep strangers off the login page. The subnet is pinned in `compose.yaml`.
- **Publishing steps (all DONE 2026-10-05; kept as the runbook for re-doing it):**
  1. Create a Cloudflare Access application + policy for the webmail hostname *first* (the token has no Access permission: either add "Access: Apps and Policies Edit" to the token, or create it in the Zero Trust dashboard).
  2. Tunnel ingress: GET the current config of tunnel `switchboard-llc-inbound`, insert `<hostname> → http://webmail:80` before the final `404` rule, keep the `mail-ingest.switchboard.llc → http://inbound-bridge:8025` rule, PUT it back, and re-run the signed POST test from §7.
  3. Proxied CNAME `<hostname> → e8226319-3580-4d88-a40d-3ce094d91d92.cfargotunnel.com`.
  4. Set `WEBMAIL_HOSTNAME` in `.env`.
