# cf-mail-tui (mailctl)

A TypeScript CLI and Interactive Terminal User Interface (TUI) for managing **Docker Mailserver (DMS)** with automated **Cloudflare DNS** synchronization (MX, SPF, DKIM, and DMARC).

Replaces fragmented bash scripts (`list-domains.sh`, `add-domain.sh`, `remove-domain.sh`, `mailctl`) with a single typed, self-contained TypeScript solution.

---

## Features

- **Interactive TUI Dashboard (`mailctl`)**:
  - Live Docker container status, primary domain, and MX hostname display.
  - Multi-column domain health matrix: mailbox counts, DKIM generation status, and live DNS checks (MX, SPF, DKIM, DMARC).
  - Interactive wizards to add/remove domains, manage mailboxes/aliases, inspect DKIM keys, and control containers.
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
    ├── dashboard.ts       # Dashboard header & summary UI
    ├── actions.ts         # Interactive wizard prompts (@clack/prompts)
    └── app.ts             # Main interactive application loop
```
