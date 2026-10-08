```
  __  __       _ _   ___
 |  \/  | __ _| | | / __|_ _  ___ ___  _ __ ___
 | |\/| |/ _` | | || |_ | '_/ _ \/ _ \ '_ ` _ \
 | |  | | (_| | | ||  _|| |  __/  __/ | | | | | |
 |_|  |_|\__,_|_|_||_|  |_|___|\___|_| |_| |_| |_|

```

# 🔥 mailforge

> **Full-stack mail server orchestrator.** Docker Mailserver + Cloudflare DNS + AWS proxy + inbound routing + Postmark relay — all from one typed, self-contained TypeScript CLI and interactive TUI.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-20+-green?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Mailserver-blue?logo=docker&logoColor=white)](https://docker-mailserver.github.io/docker-mailserver/)
[![Cloudflare](https://img.shields.io/badge/Cloudflare-DNS-orange?logo=cloudflare&logoColor=white)](https://www.cloudflare.com/)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

---

## ✨ Features

### 🖥️ Interactive TUI (`mailctl`)
Built on [Ink](https://github.com/vadimdemedes/ink) — three powerful screens at your fingertips:

| Screen | What it does |
|---|---|
| **📬 Mailboxes** | Every mailbox & alias grouped by domain, live quota bars, add/remove/change passwords, forwarders, filter by domain. Side panel shows mail-app settings + webmail URL. |
| **🌐 Domains** | Health matrix (mailboxes, DKIM, live MX/SPF/DKIM/DMARC), found-vs-expected DNS detail, Cloudflare zone list. Add/remove domain, publish DNS, regenerate DKIM. |
| **🔧 Tools** | Mail queue (retry/purge deferred), delivery log, quota bars, IMAP clients, fail2ban bans + unban, TLS cert countdown, inbound/outbound check, Postmark stats, send-test-email, container start/stop/logs. |

Every action is one dialog with all its fields. Results appear as toasts or dialogs. The status bar always shows container, bridge/tunnel/relay, Cloudflare, and certificate days left.

### 🌍 Webmail (optional)
Roundcube overlay attached to `mailctl`'s compose commands when `WEBMAIL_HOSTNAME` is set. IMAPS 993 + authenticated submission 587 only. Published through Cloudflare Tunnel behind Access policy — never exposed on the host.

### ⚡ Automated Cloudflare DNS
- **Auto zone detection** (apex + sub-domains)
- **Auto provisions** MX, SPF (`v=spf1`), DKIM (`mail._domainkey`), DMARC (`_dmarc`)
- **Auto cleanup** on domain removal

### 🐳 Docker Mailserver Integration
- Scaffolds `compose.yaml`, `mailserver.env`, directory hierarchy, `setup.sh`
- Manages `POSTFIX_VIRTUAL_DOMAINS` in `mailserver.env`
- 2048-bit DKIM key generation via OpenDKIM/Rspamd with automatic public key extraction
- Mailbox accounts, password hashing, forwarders/aliases, quota configuration

### 🔍 Live DNS Diagnostics
Direct async DNS queries (`node:dns/promises`) validating published records against expected mailserver configuration.

---

## 📦 Sub-systems

Three related components handle mail delivery beyond the mailserver itself:

| Component | Purpose | Key files |
|---|---|---|
| **☁️ AWS proxy box** (`aws-proxy/`) | Remote IMAP/SMTP (993/465/587) over WARP — nothing installed on client. HAProxy TCP passthrough + PROXY protocol v2. TLS passthrough keeps existing Let's Encrypt cert valid. | `provision.sh`, `user-data.sh`, `haproxy.cfg`, `setup_zero_trust.py`, `dms/` |
| **📥 Inbound mail** (`inbound/`) | Receive mail without public IP or port 25. Cloudflare Email Routing → Email Worker (HMAC-signed) → bridge → SMTP to mailserver. | `worker/worker.js`, `bridge/server.mjs`, `compose.inbound.yaml`, `setup_cloudflare.py` |
| **📤 Outbound relay** (`outbound/`) | Relay all outbound mail through Postmark (`smtp.postmarkapp.com:587`, STARTTLS) for deliverability. Per-sender-domain via `relayhost_map`. | `compose.outbound.yaml` |

---

## 🚀 Quick Start

### 1. Install & Build

```bash
git clone https://github.com/netplug-me/cf-mail-tui.git mailforge
cd mailforge
npm install
npm run build
```

### 2. Configure Environment

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

> **Cloudflare Token**: Needs `Zone:DNS:Edit` and `Zone:Zone:Read` permissions.

---

## 🎮 Usage

### Interactive TUI

```bash
./mailforge
# or
npm start
# or
node dist/index.js
```

**Keys**: `1` `2` `3` / `tab` switch screens · `↑↓` move · `enter` actions · `r` refresh · `esc` cancel · `ctrl+c` quit

### CLI Commands

```bash
# Initialize / Scaffold project structure
mailforge init [path] --domain example.com --mx mail.example.com

# List all domains and their live DNS health
mailforge list
mailforge list --no-dns

# Add a virtual domain (with accounts, quota, DNS sync)
mailforge add shop.example.com sales support --quota 1G --dns

# Remove a virtual domain
mailforge remove shop.example.com --yes --data --dns

# Inspect or regenerate DKIM keys
mailforge dkim shop.example.com
mailforge dkim shop.example.com --generate

# Live DNS health checks
mailforge dns check shop.example.com

# Push / Sync DNS records to Cloudflare
mailforge dns sync shop.example.com

# Manage Docker Mailserver container
mailforge docker status
mailforge docker up
mailforge docker down
mailforge docker logs
```

---

## ☁️ AWS Proxy Box

Scaffold an AWS box (t3.micro + Elastic IP) that proxies IMAP/SMTP to the mailserver over WARP:

```
mail client ─993/465/587─▶ AWS box (HAProxy, TLS passthrough)
                              │ WARP (service-token enrolment)
                              ▼
                      Cloudflare ─▶ tunnel (warp-routing) ─▶ mailserver
```

```bash
# 1. Zero Trust setup (idempotent)
python3 aws-proxy/setup_zero_trust.py --dry-run
python3 aws-proxy/setup_zero_trust.py

# 2. Provision the box (prints plan by default)
REGION=<region> MY_IP=<your-ip> ./aws-proxy/provision.sh
REGION=<region> MY_IP=<your-ip> ./aws-proxy/provision.sh --apply

# 3-7. Enrol WARP, connect, reachability, open-relay test, DNS — see aws-proxy/README.md
```

> See [`aws-proxy/README.md`](aws-proxy/README.md) for the full runbook, security rules, and teardown.

---

## 📥 Inbound Mail (No Public IP)

```bash
python3 inbound/setup_cloudflare.py --dry-run
python3 inbound/setup_cloudflare.py
docker compose -f compose.yaml -f inbound/compose.inbound.yaml up -d
```

> See [`inbound/README.md`](inbound/README.md).

---

## 📤 Outbound Relay (Postmark)

```bash
# Add POSTMARK_SERVER_TOKEN to .env, then:
python3 inbound/setup_cloudflare.py
docker compose -f compose.yaml -f inbound/compose.inbound.yaml -f outbound/compose.outbound.yaml up -d
```

> See [`outbound/README.md`](outbound/README.md).

---

## 🏗️ Architecture

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

## 🔑 Required Environment Variables

| Variable | Purpose |
|---|---|
| `PRIMARY_DOMAIN` | Your primary mail domain |
| `MX_HOST` | Mail server hostname (e.g. `mail.example.com`) |
| `DKIM_SELECTOR` | DKIM selector (default: `mail`) |
| `CF_API_TOKEN` | Cloudflare API token (`Zone:DNS:Edit`, `Zone:Zone:Read`) |
| `POSTMARK_SERVER_TOKEN` | (Optional) Postmark server token for outbound relay |
| `WEBMAIL_HOSTNAME` | (Optional) Enables Roundcube webmail overlay |
| `BRIDGE_SECRET` | (Optional) 64-char HMAC secret for inbound bridge |
| `MAIL_PUBLIC_IP` | (Optional) Elastic IP for AWS proxy box |

---

## 📄 License

MIT © [RCP Solutions](https://rcpsolutions.net)
