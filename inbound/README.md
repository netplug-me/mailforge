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
- **setup_cloudflare.py**: creates the tunnel, DNS record, Worker, and Email Routing catch-all,
  then writes `CF_TUNNEL_TOKEN` to `.env`. Idempotent; run with `--dry-run` first.

## Setup (from the project directory containing `.env`)

1. The token in `.env` needs: Zone DNS Edit, Zone Email Routing Rules Edit,
   Account Workers Scripts Edit, Account Cloudflare Tunnel Edit.
2. `BRIDGE_SECRET` must be in `.env` (64 hex chars).
3. `python3 inbound/setup_cloudflare.py --dry-run`, then run it again without `--dry-run`.
4. `docker compose -f compose.yaml -f inbound/compose.inbound.yaml up -d`
5. Send a test message to a mailbox on the domain and check `docker compose logs inbound-bridge`.

Outbound mail is separate: see `../outbound/README.md` (Postmark relay).
