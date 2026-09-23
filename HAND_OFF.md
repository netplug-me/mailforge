# cf-mail-tui / switchboard.llc mail — Hand-off

**Date:** September 23, 2026
**Status:** Inbound mail for `switchboard.llc` is live and has been tested from the public internet into the mailbox.
Outbound mail is not set up yet.
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
4. Originals of the edited files were backed up under the Claude scratchpad. **This directory is not a git repo,
   so these edits are unversioned.** Run `git init` here. `.gitignore` already excludes `.env` and `docker-data/`.

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

1. **Send a real email** from Gmail or a phone to `postmaster@switchboard.llc`. That is the only hop not exercised yet
   (Email Routing → Worker). Check it with `docker compose ... logs inbound-bridge` and the Worker logs in the dashboard.
2. **Outbound mail:** choose a relay (Amazon SES, Mailgun, Postmark), configure DMS relay on 587, and add it to SPF.
   Until then, mail sent from this box will likely be refused or spam-foldered.
3. **Remote client access:** IMAP 993 and submission 587 are only reachable on the LAN. Plan: Cloudflare Tunnel + WARP.
4. **More mailboxes and aliases:** use the TUI (`./mailctl`) or `docker exec mailserver setup email add …`.
   Only `postmaster@` exists now.
5. **DKIM for outbound** is not set up yet (the TUI can generate keys; publish the TXT record when outbound is ready).
6. **Container warnings:** docker-mailserver warns that running Rspamd alongside Amavis/SpamAssassin/OpenDKIM/OpenDMARC
   is discouraged. It isn't a problem, but consider slimming the enabled services later.
