# Installation guide (beginner friendly)

This walks you from an empty Linux machine to a working mail server with a web inbox. Do the steps in order and
don't skip the checks. Each one tells you what "good" looks like.

**What you will end up with**

| Piece | What it does | Required? |
|---|---|---|
| Mail server (Docker Mailserver) | Stores mail, handles logins | Yes |
| Cloudflare DNS records | Tells the internet where your mail lives | Yes |
| Inbound mail (Cloudflare Email Routing + Tunnel) | Receives mail without opening port 25 | Recommended |
| Webmail (Roundcube) | Read and send mail in a browser | Optional |
| Postmark relay | Better delivery for outgoing mail | Optional |
| AWS proxy box | Lets phone/desktop mail apps connect from anywhere | Optional |

---

## Step 0: What you need first

- A Linux machine you control (this guide was written for Ubuntu), with a user that can run `docker` (`docker ps` works without `sudo`).
- **Docker** with the Compose plugin (`docker compose version` prints a version).
- **Node.js 20 or newer** (`node --version`) and **npm**.
- **Python 3** (`python3 --version`), used by the Cloudflare setup scripts.
- **git**.
- A **domain name** whose DNS is hosted on **Cloudflare** (free plan is fine).
- A Cloudflare account with **Zero Trust** enabled (free; only needed for the tunnel and webmail login).

Pick two names now and write them down. This guide uses these examples; replace them everywhere:

| Example | Meaning |
|---|---|
| `example.com` | Your domain (`PRIMARY_DOMAIN`) |
| `mail.example.com` | Your mail server's hostname (`MX_HOST`) |
| `webmail.example.com` | Where the web inbox will live (optional) |

---

## Step 1: Get the code and build it

```bash
git clone https://github.com/netplug-me/mailforge.git mailforge
cd mailforge
npm install
npm run build
```

**Check:** `./mailforge --help` prints a list of commands.

---

## Step 2: Create a Cloudflare API token

1. Cloudflare dashboard → **My Profile → API Tokens → Create Token → Create Custom Token**.
2. Give it these permissions (add the extra ones only if you plan to use that part):

| Permission | Needed for |
|---|---|
| Zone → DNS → Edit | Always (mail DNS records, certificate) |
| Zone → Zone → Read | Always |
| Zone → Email Routing Rules → Edit | Inbound mail |
| Account → Workers Scripts → Edit | Inbound mail |
| Account → Cloudflare Tunnel → Edit | Inbound mail, webmail |
| Account → Access: Apps and Policies → Edit | Webmail login protection (can also be done by hand, see Step 10) |

3. Under **Zone Resources**, pick your domain. Create the token and **copy it now**. Cloudflare only shows it once.

---

## Step 3: Fill in `.env`

```bash
cp .env.example .env
chmod 600 .env
```

Open `.env` in an editor and set at least these:

```ini
PRIMARY_DOMAIN=example.com
MX_HOST=mail.example.com
DKIM_SELECTOR=mail
CF_API_TOKEN=paste_your_token_here
POSTMASTER_ADDRESS=postmaster@example.com
```

Also generate the inbound secret now (a random 64-character string) and add it to `.env`:

```bash
echo "BRIDGE_SECRET=$(openssl rand -hex 32)" >> .env
```

`.env` holds secrets and is already git-ignored. Never commit it.

---

## Step 4: Point the compose file at your domain

The repo ships a `compose.yaml` that still names the original owner's domain. Open it and change these two lines under
`mailserver:` to match your `.env`:

```yaml
    hostname: mail.example.com
    domainname: example.com
```

Leave the rest alone, especially the `networks:` block at the bottom. The tunnel and webmail depend on those fixed addresses.

Now create the data folders:

```bash
./mailforge init
```

It skips files that already exist, which is what you want here. **Check:** a `docker-data/dms/` folder now exists.

---

## Step 5: Get a TLS certificate

The mail server needs a certificate for `mail.example.com` so mail apps trust it. This command uses Cloudflare DNS to prove you own the name, so no
port 80 or 443 is needed. Run it once, replacing the hostname and token:

```bash
CF_TOKEN=$(grep ^CF_API_TOKEN= .env | cut -d= -f2-)
MX=$(grep ^MX_HOST= .env | cut -d= -f2-)
CREDS=$(mktemp -d)
( umask 077; echo "dns_cloudflare_api_token = $CF_TOKEN" > "$CREDS/cloudflare.ini" )
sudo mkdir -p /etc/letsencrypt /var/lib/letsencrypt
sudo docker run --rm \
  -v /etc/letsencrypt:/etc/letsencrypt -v /var/lib/letsencrypt:/var/lib/letsencrypt \
  -v "$CREDS":/creds:ro certbot/dns-cloudflare:latest certonly --non-interactive --agree-tos \
  --email you@example.com --dns-cloudflare --dns-cloudflare-credentials /creds/cloudflare.ini -d "$MX"
rm -rf "$CREDS"
```

**Check:** `sudo ls /etc/letsencrypt/live/` lists `mail.example.com`.

Certificates last 90 days. Renew automatically with the included script, run daily from cron (`crontab -e`):

```
17 3 * * * /full/path/to/mailforge/scripts/renew-cert.sh
```

Test it first with `scripts/renew-cert.sh --dry-run` and read `logs/renew-cert.log`.

---

## Step 6: Start the mail server

```bash
./mailforge docker up
./mailforge docker status
```

**Check:** the status says the container is running. Wait about a minute, then `docker ps` should show `mailserver` as `healthy`.
If it isn't, read `./mailforge docker logs`. A missing certificate (Step 5) is the usual cause.

> Always start and stop through `./mailforge docker up` / `down` (or the TUI). It adds the right optional pieces automatically.
> A bare `docker compose up` would leave out the inbound, relay and webmail settings.

---

## Step 7: Add your domain and DNS records

```bash
./mailforge add example.com info support --password 'choose-a-long-password' --dns
```

This creates the mailboxes `info@` and `support@` with that starting password, makes a DKIM signing key, and writes the SPF, DKIM and DMARC records in
Cloudflare. Use a long, unique password, and change it later from the TUI's **Mailboxes** screen.

**Check:**

```bash
./mailforge list
./mailforge dns check example.com
```

All rows should be green, except possibly MX until Step 8.

---

## Step 8: Receive mail (inbound, no open port 25)

Most home and cloud networks block port 25, so mail is received by Cloudflare and handed to your server through a private tunnel.

Preview, then apply:

```bash
python3 inbound/setup_cloudflare.py --dry-run
python3 inbound/setup_cloudflare.py
```

This creates the tunnel, the DNS record, the Email Worker and the Email Routing rule, and saves `CF_TUNNEL_TOKEN` into `.env`. Read the dry-run
output. It tells you if it will replace an existing MX record.

Then restart so the tunnel containers start:

```bash
./mailforge docker up
```

**Check:** `docker ps` shows `…-cloudflared-1` and `…-inbound-bridge-1` running. Send an email to `info@example.com` from another account, then:

```bash
docker logs $(docker ps --format '{{.Names}}' | grep inbound-bridge)
```

You should see the message delivered. More detail: [`inbound/README.md`](inbound/README.md).

---

## Step 9: Open the TUI

```bash
./mailforge
```

Keys: `1` to `4` or `tab` switch screens, `↑↓` move, `enter` opens actions, `r` refreshes, `ctrl+c` quits. Use **Mailboxes** to add
people and reset passwords, **Domains** to see DNS health, **Tools** for the queue, logs and bans.

---

## Step 10 (optional): Webmail

Roundcube runs in a container that is **never published on the host**. It listens on port **9000 inside Docker only**, and Cloudflare's tunnel is the
only way in, behind a login.

1. Add the hostname to `.env`:
   ```ini
   WEBMAIL_HOSTNAME=webmail.example.com
   ```
2. **Tunnel route.** Cloudflare Zero Trust → **Networks → Tunnels** → your tunnel (`example.com-inbound`) → **Public Hostname → Add**:
   hostname `webmail.example.com`, service type `HTTP`, URL `webmail:9000`. Cloudflare creates the DNS record for you.
3. **Login protection (do this before anyone visits the address).** Zero Trust → **Access → Applications → Add → Self-hosted**:
   - Application domain: `webmail.example.com`
   - Add a policy: Action **Allow**, include **Emails** → your own address(es)
   - Login method: One-time PIN is the simplest.
4. Start it:
   ```bash
   ./mailforge docker up
   ```
5. Open `https://webmail.example.com`. Cloudflare asks for your email, sends you a PIN, then Roundcube asks for a **mailbox address and password** (for example
   `info@example.com` and the password you set in Step 7).

**Check:** `docker ps` shows `…-webmail-1`, and `ss -ltn | grep ':80 '` shows nothing (no web server on your machine's port 80).

---

## Step 11 (optional): Better outgoing delivery with Postmark

1. In Postmark, create a server and verify your sending domain.
2. Add the token to `.env`: `POSTMARK_SERVER_TOKEN=...`
3. Run `python3 inbound/setup_cloudflare.py --dry-run`, then without `--dry-run` (it updates SPF).
4. `./mailforge docker up`

Details: [`outbound/README.md`](outbound/README.md).

## Step 12 (optional): Mail apps from anywhere (AWS proxy box)

Only needed if phones or desktop mail programs must connect from outside your network. It costs about $9 a month and has several security rules
(never expose ports 25 or 143). Follow [`aws-proxy/README.md`](aws-proxy/README.md) start to finish rather than improvising.

---

## Day-to-day commands

```bash
./mailforge                 # open the TUI
./mailforge docker status   # is it running?
./mailforge docker logs     # recent logs
./mailforge docker down     # stop everything
./mailforge list            # domains, DKIM and DNS health
npm test                    # run the project's tests (needs a build first, the script does it)
```

## Back up

Everything that matters lives in `docker-data/` (mail, accounts, DKIM keys, webmail database) plus `.env`. Stop the stack and copy both somewhere safe regularly.

## Troubleshooting

| Problem | What to check |
|---|---|
| `mailserver` keeps restarting | `./mailforge docker logs`. Look for a missing certificate. Redo Step 5. |
| Mail from outside never arrives | Step 8 done? the `inbound-bridge` container's logs (`docker logs`); `./mailforge dns check example.com` |
| Your outgoing mail lands in spam | Run `./mailforge dns check`; make sure SPF, DKIM and DMARC are green. Consider Step 11. |
| Webmail shows Cloudflare error 502 | The tunnel route must be exactly `webmail:9000`, and `docker ps` must show the webmail container up. |
| Webmail login page says "connection to storage server failed" | Wrong password, or the mailserver is down. Test the same login in the TUI. |
| Port 80 or 443 conflicts | Nothing here needs them on the host. If a compose file you edited publishes them, remove that line. |
