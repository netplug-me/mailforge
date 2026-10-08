# Outbound mail via Postmark

docker-mailserver relays everything it sends from `@switchboard.llc` through Postmark's SMTP service
(`smtp.postmarkapp.com:587`, STARTTLS). Postmark uses the Server API Token as both SMTP username and password.

## Setup (from the project directory containing `.env`)

1. In Postmark, verify the sending domain (DKIM + Return-Path) and create a server.
2. Put the token in `.env` as `POSTMARK_SERVER_TOKEN=...` (git-ignored; keep the file mode 600).
3. SPF must include Postmark. With the token set, `python3 inbound/setup_cloudflare.py --dry-run`
   shows the SPF change (adds `include:spf.mtasv.net`); run it again without `--dry-run` to apply.
4. `docker compose -f compose.yaml -f inbound/compose.inbound.yaml -f outbound/compose.outbound.yaml up -d`
   (`mailforge` / the TUI add these `-f` flags automatically, based on which files and `.env` variables exist.)
5. Send a test: `docker exec -i mailserver sendmail -t -f you@switchboard.llc` with From/To/Subject headers
   on stdin, then `docker exec mailserver grep status= /var/log/mail/mail.log | tail`. Look for `status=sent` from
   `relay=smtp.postmarkapp.com`.

The relay is applied per sender domain (`relayhost_map`), so `relayhost` itself shows empty in `postconf`.
The sender's domain must be verified in Postmark.
