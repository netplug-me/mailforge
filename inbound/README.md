# Inbound mail without a public IP

Receives mail for `PRIMARY_DOMAIN` without exposing this machine's IP or opening port 25.

```
Sender ─SMTP─▶ Cloudflare Email Routing (MX) ─▶ Email Worker
                                                   │ HTTPS POST, HMAC-signed
                                                   ▼
                    Cloudflare Tunnel (mail-ingest.<domain>)
                                                   │
         docker network:  cloudflared ─▶ inbound-bridge ─SMTP─▶ docker-mailserver

```

- **worker/worker.js**: Email Worker. Posts the raw message plus envelope to the bridge. A permanent
  rejection from the mail server (e.g. unknown mailbox) becomes a bounce via `setReject`. Any other
  failure throws, so mail is never silently accepted and then dropped.
- **bridge/server.mjs**: no-dependency Node service. Verifies the HMAC and a ±5 min timestamp,
  then delivers over SMTP to `mailserver:25`. The message is passed through unmodified, so the
  sender's DKIM signatures stay valid.
- **compose.inbound.yaml**: adds `inbound-bridge` and `cloudflared` to the stack and sets
  `PERMIT_DOCKER=connected-networks` on the mail server so it accepts the bridge's handoff.
- **setup_cloudflare.py**: creates the tunnel, DNS records, Worker, and Email Routing catch-all,
  then writes `CF_TUNNEL_TOKEN` to `.env`. Idempotent; run with `--dry-run` first.
- **setup.sh**: runs `docker exec mailserver setup` (or a throwaway container).

## Setup (from the project directory containing `.env`)

1. The token in `.env` needs: Zone DNS Edit, Zone Email Routing Rules Edit,
   Account Workers Scripts Edit, Account Cloudflare Tunnel Edit.
2. `BRIDGE_SECRET` must be in `.env` (64 hex chars).
3. `python3 inbound/setup_cloudflare.py --dry-run`, then run it again without `--dry-run`.
4. `docker compose -f compose.yaml -f inbound/compose.inbound.yaml up -d`
5. Send a test message to a mailbox on the domain and check `docker compose logs inbound-bridge`.

## Remote client access (IMAP/SMTP)

Cloudflare's proxy carries only HTTP(S), so mail clients can't use the tunnel directly. Instead a small
AWS box (HAProxy, TCP passthrough) forwards 993/465/587 over a WARP private-network route to the
mailserver, so clients need nothing installed. Runbook, scripts and the security rules (never port 25/143,
fail2ban blind spot, open-relay test) are in `../aws-proxy/README.md`.

This directory's part: `setup_cloudflare.py` enables `warp-routing` on the tunnel and adds the
`172.25.0.10/32` route (and, once `MAIL_PUBLIC_IP` is set in `.env`, the DNS-only A record `mail.<domain>`
→ the proxy's Elastic IP). `compose.yaml` pins the network (`172.25.0.0/16`) and mailserver (`172.25.0.10`);
`compose.inbound.yaml` pins cloudflared at `172.25.0.11`, which `fail2ban-jail.cf` ignores.

Outbound mail is separate: see `../outbound/README.md` (Postmark relay).
