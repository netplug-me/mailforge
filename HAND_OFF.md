# cf-mail-tui / switchboard.llc mail — Hand-off

**Date:** September 23, 2026
**Status:** Inbound mail for `switchboard.llc` is live and has been tested from the public internet into the mailbox.
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

## 8. Open items / next steps

1. **Inbound from the public internet:** DONE (2026-10-01). A real Gmail message to `postmaster@` went Email Routing → Worker →
   bridge → DMS and landed in the INBOX (amavis `Passed CLEAN`).
2. **Outbound mail:** DONE via Postmark (`outbound/compose.outbound.yaml`, token in `.env` as `POSTMARK_SERVER_TOKEN`).
   SPF now `v=spf1 include:_spf.mx.cloudflare.net include:spf.mtasv.net mx ~all` (applied 2026-10-01 with
   `inbound/setup_cloudflare.py`). DNS checked 2026-10-01: SPF record correct, `pm-bounces` CNAME → `pm.mtasv.net`, DMARC `p=none; aspf=r`.
   Remaining: open the Postmark-relayed test in Gmail (Show original) and confirm SPF/DKIM/DMARC all `PASS`
   (the messages in the mailboxes are inbound from Gmail, so they don't prove this), then consider DMARC
   `p=quarantine` after a week or two of clean reports.
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
