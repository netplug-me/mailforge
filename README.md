# cf-mail-tui (mailctl)

A TypeScript CLI and Interactive Terminal User Interface (TUI) for managing **Docker Mailserver (DMS)** with automated **Cloudflare DNS** synchronization (MX, SPF, DKIM, and DMARC).

Replaces fragmented bash scripts (`list-domains.sh`, `add-domain.sh`, `remove-domain.sh`, `mailctl`) with a single typed, self-contained TypeScript solution.

---

## Features

- **Interactive TUI (`mailctl`)**, built on [Ink](https://github.com/vadimdemedes/ink) as three screens:
  - **Mailboxes** (the home screen): every mailbox and alias grouped by domain, with live quota bars from Dovecot.
    Add several mailboxes in one dialog (generated passwords are shown once), change a password, set or remove a
    quota, add or delete forwarders, and filter by domain. The side panel shows the mail-app settings for the
    selected mailbox (and the webmail URL when `WEBMAIL_HOSTNAME` is set).
  - **Domains**: health matrix (mailboxes, DKIM, live MX / SPF / DKIM / DMARC), the found-vs-expected DNS detail for the
    selected domain, and the Cloudflare zone list. Add or remove a domain, publish DNS, view or regenerate DKIM.
  - **Tools**: mail queue (retry / purge deferred), colour-coded delivery log, mailbox quota bars,
    connected IMAP clients, fail2ban bans + unban, TLS certificate countdown, inbound/outbound path check,
    Postmark 7-day stats and recent bounces (needs `POSTMARK_SERVER_TOKEN`), a send-test-email action and
    container start / stop / logs.
  - Every action is one dialog with all its fields, not a chain of prompts; results appear as a toast or, when you
    need to read or copy something (passwords, DKIM value), a dialog. The status bar always shows container,
    bridge / tunnel / relay, Cloudflare and certificate days left.
- **Webmail (optional)**: a Roundcube overlay in `webmail/compose.webmail.yaml`, attached to `mailctl`'s compose commands when
  `WEBMAIL_HOSTNAME` is set in `.env`. It uses IMAPS 993 and authenticated submission 587 only. Publish it through the Cloudflare
  Tunnel behind a Cloudflare Access policy; it is not exposed on the host.
- **Automated Cloudflare DNS Management**:
  - Automatic zone detection (apex and sub-domains).
  - Automatically provisions or updates MX, SPF (`v=spf1`), DKIM (`mail._domainkey`), and DMARC (`_dmarc`) records.
  - Automatic DNS record cleanup upon domain removal.
- **Docker Mailserver Integration**:
  - Scaffolds `compose.yaml`, `mailserver.env`, directory hierarchy, and `setup.sh`.
  - Manages `POSTFIX_VIRTUAL_DOMAINS` in `mailserver.env`.
  - 2048-bit DKIM key generation via OpenDKIM/Rspamd with automatic public key extraction for DNS TXT records.
  - Mailbox accounts, password hashing, forwarders/aliases, and quota configuration.
- **Live DNS Diagnostics**:
  - Direct asynchronous DNS queries (`node:dns/promises`) validating published records against expected mailserver configurations.

---

## Quick Start

### 1. Install & Build

```bash
cd /home/lham/dev/cf-mail-tui
npm install
npm run build
```

### 2. Configure Environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env`:

```ini
PRIMARY_DOMAIN=example.com
MX_HOST=mail.example.com
DKIM_SELECTOR=mail
CF_API_TOKEN=your_cloudflare_api_token
```

> **Note on Cloudflare Token**: Needs `Zone:DNS:Edit` and `Zone:Zone:Read` permissions.

---

## Usage

### Interactive TUI Mode

Launch the full interactive TUI by running without arguments or via the `mailctl` wrapper:

```bash
./mailctl
# or
npm start
# or
node dist/index.js
```

Keys: `1` `2` `3` or `tab` switch screens, `↑↓` move, `enter` opens the actions for the selected row,
`r` refreshes, `esc` cancels a dialog, `ctrl+c` quits. Each screen shows its own shortcuts in the footer.
Press `a` to add (a mailbox or a domain), `d` / `x` to delete, `p` for a password, `q` for a quota, `f` to filter by domain.

### CLI Commands

```bash
# 1. Initialize / Scaffold project structure & compose.yaml
cf-mail init [path] --domain example.com --mx mail.example.com

# 2. List all domains and their live DNS health
cf-mail list
cf-mail list --no-dns

# 3. Add a virtual domain (with optional accounts, quota, and Cloudflare DNS sync)
cf-mail add shop.example.com sales support --quota 1G --dns

# 4. Remove a virtual domain
cf-mail remove shop.example.com --yes --data --dns

# 5. Inspect or regenerate DKIM keys
cf-mail dkim shop.example.com
cf-mail dkim shop.example.com --generate

# 6. Live DNS health checks
cf-mail dns check shop.example.com

# 7. Push / Sync DNS records to Cloudflare
cf-mail dns sync shop.example.com

# 8. Manage Docker Mailserver container
cf-mail docker status
cf-mail docker up
cf-mail docker down
cf-mail docker logs
```

---

## Architecture

```
src/
├── config.ts              # Environment & path configuration
├── types.ts               # Data types & interfaces
├── index.ts               # Entrypoint (CLI / TUI router)
├── utils/
│   ├── env-file.ts        # Parser & manager for mailserver.env
│   ├── logger.ts          # Terminal logging & badges
│   ├── table.ts           # Terminal table rendering
│   └── validator.ts       # Domain & email format validation
├── services/
│   ├── docker.ts          # Docker container & compose lifecycle
│   ├── dms.ts             # Docker Mailserver setup & account management
│   ├── dkim.ts            # DKIM key reader & TXT record parser
│   ├── dns.ts             # Live DNS querying (node:dns/promises)
│   ├── cloudflare.ts      # Cloudflare REST API client (zone & records)
│   └── domain-manager.ts  # Domain orchestration
└── tui/
    ├── app.tsx            # Starts Ink (alternate screen) and the first refresh
    ├── view.tsx           # App shell: status bar, tabs, footer, dialog/dock routing, key lock
    ├── screens.tsx        # Mailboxes, Domains and Tools screens
    ├── widgets.tsx        # Panel, status bar, form / confirm / notice dialogs, select dock
    ├── flows.ts           # One function per user task (add mailbox, remove domain, …)
    ├── actions.ts         # The Tools screen's tools (queue, logs, fail2ban, container, …)
    ├── dashboard.ts       # Refresh: fast local state first, then live DNS, zones, usage
    ├── ui.ts              # State store and prompt bridge (select, text, confirm, form, notice, toast)
    └── theme.ts           # Palette, truncate/fit helpers, password generator
```

---

## Sub-systems

Three related components handle mail delivery beyond the mailserver itself. Each has its own README and setup scripts.

| Component | Purpose | Key files |
|---|---|---|
| **AWS proxy box** (`aws-proxy/`) | Gives mail clients remote IMAP/SMTP (993/465/587) over a WARP private-network route — nothing installed on the client. HAProxy on a small AWS box forwards TCP to the mailserver through Cloudflare Tunnel with PROXY protocol v2, so the mailserver sees real client IPs. TLS passthrough means the existing Let's Encrypt cert matches unchanged. | `provision.sh` (AWS CLI scaffold), `user-data.sh`, `haproxy.cfg`, `setup_zero_trust.py`, `dms/` |
| **Inbound mail** (`inbound/`) | Receives mail without exposing a public IP or opening port 25. Cloudflare Email Routing (MX) → Email Worker (HMAC-signed HTTPS POST) → bridge (verifies + SMTP handoff) → docker-mailserver. | `worker/worker.js`, `bridge/server.mjs`, `compose.inbound.yaml`, `setup_cloudflare.py` |
| **Outbound relay** (`outbound/`) | Relays all outbound mail through Postmark's SMTP (`smtp.postmarkapp.com:587`, STARTTLS) for deliverability. Applied per-sender-domain via `relayhost_map`. | `compose.outbound.yaml` |

### AWS proxy box

Scaffold an AWS box (t3.micro + Elastic IP) that proxies IMAP/SMTP to the mailserver over WARP:

```bash
# 1. Zero Trust setup (idempotent, --dry-run first)
python3 aws-proxy/setup_zero_trust.py --dry-run
python3 aws-proxy/setup_zero_trust.py

# 2. Provision the box (prints plan by default)
REGION=<region> MY_IP=<your-ip> ./aws-proxy/provision.sh
REGION=<region> MY_IP=<your-ip> ./aws-proxy/provision.sh --apply

# 3-6. Enrol WARP, connect, reachability test, open-relay test — see aws-proxy/README.md
# 7. Point DNS at the Elastic IP
echo "MAIL_PUBLIC_IP=<eip>" >> .env
python3 inbound/setup_cloudflare.py
```

See [`aws-proxy/README.md`](aws-proxy/README.md) for the full runbook, security rules (never proxy port 25/143, fail2ban blind spot, mandatory open-relay test), and teardown steps.

### Inbound mail (no public IP)

```bash
python3 inbound/setup_cloudflare.py --dry-run   # creates tunnel, Worker, Email Routing catch-all
python3 inbound/setup_cloudflare.py             # writes CF_TUNNEL_TOKEN to .env
docker compose -f compose.yaml -f inbound/compose.inbound.yaml up -d
```

See [`inbound/README.md`](inbound/README.md).

### Outbound relay (Postmark)

```bash
# Add POSTMARK_SERVER_TOKEN to .env, then:
python3 inbound/setup_cloudflare.py             # adds include:spf.mtasv.net to SPF
docker compose -f compose.yaml -f inbound/compose.inbound.yaml -f outbound/compose.outbound.yaml up -d
```

See [`outbound/README.md`](outbound/README.md).
