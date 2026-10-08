# cf-mail-tui / switchboard.llc — Handoff Plan

**Date:** 2026-10-08
**Status:** Live: AWS proxy box 50.18.195.200 -> WARP -> mailserver, DNS set. Remaining: real-mailbox login test, old instance cleanup

---

## 1. Project Overview

`cf-mail-tui` — Docker Mailserver Manager + Cloudflare DNS Sync with interactive TUI (React/Ink, ESM TypeScript).

**Architecture:**
- `compose.yaml` — Docker Mailserver (ports 25, 465, 587, 993, 143)
- `inbound/` — Cloudflare Email Routing → Worker → Tunnel → inbound-bridge → mailserver
- `outbound/` — Postmark SMTP relay for outbound mail
- `src/` — TUI + services (Cloudflare, DKIM, DMS, Docker, DomainManager, Ops)

All 8 PLAN.md bugs fixed and verified (tests pass).

---

## 2. What Was Done

### Remote client access (2026-10-08) — decision: AWS proxy box over WARP

Cloudflare's proxy can't carry IMAP/SMTP, and per-client WARP/Tailscale is too much. So: AWS box (HAProxy TCP passthrough on
993/465/587, Elastic IP, DNS-only `mail.` A record) → headless WARP → tunnel private route `172.25.0.10/32` → mailserver.
nerdland itself needs neither WARP nor the proxy. Full runbook: `aws-proxy/README.md`.

### Done (live)

- `compose.yaml`: pinned network `172.25.0.0/16`, mailserver `172.25.0.10`. `compose.inbound.yaml`: cloudflared pinned `172.25.0.11`.
- `docker-data/dms/config/fail2ban-jail.cf`: `ignoreip` += `172.25.0.11` (loaded in the running container; DMS copies it at startup).
- `inbound/setup_cloudflare.py`: GET-merge-PUT of tunnel config (keeps webmail rule), `warp-routing` on, route `172.25.0.10/32`
  created, optional `MAIL_PUBLIC_IP` → DNS-only A record. Next-step hint lists every overlay.
- No `mail.switchboard.llc` DNS record exists until the end of the runbook.

### Written, not run

- `aws-proxy/`: `provision.sh` (dry run by default), `user-data.sh`, `haproxy.cfg` (validated with `haproxy -c`), `mdm.xml.example`, README.

## Next steps

1. Zero Trust dashboard (service token, Service Auth enrolment, Include `172.25.0.10/32`, Gateway allow 993/465/587 then block rest, TCP proxy on).
2. `REGION=... MY_IP=... ./aws-proxy/provision.sh` (review), then `--apply`.
3. Enrol WARP on the box, connect with the safety timer, run the open-relay test (hard stop), then `MAIL_PUBLIC_IP=<EIP>` + `setup_cloudflare.py`.
4. Follow-ups: PROXY protocol for real client IPs in fail2ban; the TUI scaffold (`src/services/dms.ts`) still generates a compose.yaml without the pinned network.
