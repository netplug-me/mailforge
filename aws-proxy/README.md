# AWS proxy box: remote IMAP/SMTP for mail clients, over WARP

Mail clients need nothing installed. They talk to a small Ubuntu box on AWS that forwards the TCP
streams to the mailserver over a WARP private-network route.

```
mail client ─993/465/587─▶ AWS box (Elastic IP, HAProxy mode tcp, TLS passthrough)
                              │ WARP (headless, service-token enrolment)
                              ▼
                      Cloudflare ─▶ tunnel (warp-routing) ─▶ 172.25.0.10 (mailserver on nerdland)
```

`mail.<domain>` becomes a DNS-only A record to the Elastic IP. TLS is not terminated on the proxy, so
the existing Let's Encrypt cert on nerdland (renewed by DNS-01 through Cloudflare) matches unchanged.

Files: `provision.sh` (aws CLI; dry run by default), `user-data.sh` (installs HAProxy + WARP),
`haproxy.cfg`, `mdm.xml.example`, `setup_zero_trust.py`, and `dms/` (the mailserver half of the PROXY protocol
setup: `dovecot.cf` + `user-patches.sh`, copied into `docker-data/dms/config/`; apply with
`docker compose ... up -d --force-recreate mailserver`, because a plain `docker restart` skips DMS setup).

HAProxy sends PROXY protocol v2 to **10993 / 10465 / 10587** on the mailserver (twins of 993 / 465 / 587), so the
mailserver's logs and per-IP limits see the real client address instead of cloudflared. Plain 993/465/587 stay
as they are for webmail and local clients, and are closed to the proxy box by the Gateway rule.

## Hard rules

- **Never open or proxy port 25 or 143.** `PERMIT_DOCKER=connected-networks` trusts the compose network, which
  includes cloudflared. Port 25 reachable through the proxy would be an open relay. (Ports 465/587 are safe by
  Postfix config: both `submission` and `submissions` set `smtpd_client_restrictions=permit_sasl_authenticated,reject`,
  so `mynetworks` does not apply. Step 6 proves it before anything is opened.)
- **fail2ban bans do not work on this path by themselves.** Remote logins arrive from cloudflared (pinned
  `172.25.0.11`, ignored by fail2ban). With PROXY protocol the mailserver logs show the real client IP, but a
  fail2ban ban is a firewall rule on the mailserver, and the connection's TCP peer is still cloudflared, so on its
  own a ban never blocks the attacker. `fail2ban-watcher.sh` (below) closes that gap by mirroring bans onto the
  proxy box. Independent of it, per real IP: HAProxy's connection-rate limit, Postfix
  `smtpd_client_auth_rate_limit=20`/min on the proxy ports, and Dovecot's auth delay. Use strong mailbox passwords.
- The proxy box's VPC must not overlap `172.25.0.0/16` (the default VPC `172.31.0.0/16` is fine).

### Ban sync: `fail2ban-watcher.sh`

Runs on nerdland. It follows fail2ban's log, and for each `Ban` / `Restore Ban` / `Unban` of a public IPv4 sets or
clears `gpc0` for that IP in HAProxy's `st_src` stick-table (`set table st_src key <ip> data.gpc0 1|0`, over SSH +
`sudo socat` to the admin socket). Every frontend rejects connections whose `gpc0` is set, before the rate checks.

- **Expiry:** an entry ages out 10 minutes after the IP's last connection attempt. A banned IP that keeps knocking
  keeps its ban alive; one that stops is let back in after 10 minutes even though fail2ban still holds the ban.
- **Restarts:** HAProxy forgets its table on restart or reload, so the watcher replays `fail2ban-client banned` at
  startup. After restarting HAProxy, restart the watcher too.
- **Two jails:** an IP banned in both `postfix` and `dovecot` is unbanned at HAProxy only when both release it.
- **Skipped on purpose:** loopback, private and CGNAT addresses (the compose network, cloudflared) and IPv6 (the
  table is `type ip` and the security group is IPv4-only).

Setup:

1. **Apply the new `haproxy.cfg`.** The `gpc0` column and reject rules, plus the admin socket, only exist on boxes
   provisioned after this change. For a running proxy box, copy `aws-proxy/haproxy.cfg` to
   `/etc/haproxy/haproxy.cfg`, run `sudo apt-get install -y socat`, then `sudo haproxy -c -f /etc/haproxy/haproxy.cfg
   && sudo systemctl restart haproxy`. The socket is root-owned (`mode 660`), hence `sudo` in the SSH command;
   Ubuntu's default `ubuntu` user has passwordless sudo.
2. **SSH access** from the user that runs the watcher to the proxy box. `provision.sh` already saved the key as
   `~/.ssh/mail-proxy.pem`; pass it with `PROXY_SSH_KEY`.
3. **Preview, then run** (from nerdland, where compose.yaml lives):
   ```bash
   PROXY_SSH_HOST=<EIP> ./aws-proxy/fail2ban-watcher.sh --dry-run     # prints the HAProxy commands only
   PROXY_SSH_HOST=<EIP> PROXY_SSH_KEY=~/.ssh/mail-proxy.pem ./aws-proxy/fail2ban-watcher.sh
   ```
   `docker-data/dms/mail-logs/fail2ban.log` is root-only; without read access the script follows the log with
   `docker exec mailserver tail -F` instead, so a user in the `docker` group is enough.
4. **Check it on the proxy box:** `echo "show table st_src" | sudo socat stdio /run/haproxy/admin.sock`
   lists the entries with `gpc0=1` for banned IPs. `npm run test:f2b` covers the parsing and push logic offline.
5. **Optional: systemd service** (`/etc/systemd/system/fail2ban-watcher.service`):
   ```ini
   [Unit]
   Description=fail2ban to HAProxy ban sync
   After=docker.service

   [Service]
   Type=simple
   User=lham
   Environment=PROXY_SSH_HOST=<EIP> PROXY_SSH_KEY=/home/lham/.ssh/mail-proxy.pem
   ExecStart=/home/lham/dev/cli/cf-mail-tui/aws-proxy/fail2ban-watcher.sh
   Restart=always
   RestartSec=10

   [Install]
   WantedBy=multi-user.target
   ```
   Then `systemctl enable --now fail2ban-watcher`.

## Steps

Already done from this repo (2026-10-08): `compose.yaml` pins the network and mailserver `172.25.0.10`;
cloudflared pinned at `172.25.0.11` and added to `ignoreip`; `inbound/setup_cloudflare.py` enabled `warp-routing`
on the tunnel and created the private route `172.25.0.10/32`.

### 1. Zero Trust settings (before the box exists)

**Applied 2026-10-08 with `python3 aws-proxy/setup_zero_trust.py`** (idempotent, `--dry-run` first): service token
`mail-proxy-warp` (credentials written to the gitignored `aws-proxy/mdm.xml`), Service Auth enrolment policy
`mail-proxy-service-auth`, device profile "mail-proxy (service token)" (Include `172.25.0.10/32`, precedence 500),
Gateway TCP proxy on, and Gateway rules "mail-proxy: allow mail ports" / "mail-proxy: block rest". The list below
is what that script does, for reference or manual repair.

This is the company's shared Zero Trust org (it also holds PrinterPlug SSH/VNC apps and other tokens), so change
only what is listed here. Current state, checked via API 2026-10-08: no enrolled devices, no Gateway rules,
Gateway TCP proxy off, Default device profile in Exclude mode, an Access app "Warp Login App" (type `warp`) that
holds the device-enrolment policies. Menu paths below are from Cloudflare's current docs.

1. **Service token:** Access controls → Service credentials → Service Tokens → Create Service Token. Name it
   `mail-proxy-warp`, copy the Client Secret immediately (shown once). API: `POST /accounts/$ACCT/access/service_tokens`.
2. **Enrolment permission:** add a policy with action **Service Auth** that includes only this token to the
   "Warp Login App" policies (Team & Resources → Devices → Management → Device enrollment permissions). An Allow
   policy does not apply to service tokens.
3. **Custom device profile, not the Default one:** Team & Resources → Devices → Device profiles → General profiles →
   Create profile. Match expression: the service-token identity (`non_identity@<team>.cloudflareaccess.com`;
   confirm in the dashboard's expression builder). Split Tunnels → *Include IPs and Domains* → add `172.25.0.10/32`.
   Do not switch the Default profile to Include: any future company device would stop working.
4. **Gateway TCP proxy:** Traffic policies → Traffic settings → enable "Allow Secure Web Gateway to proxy traffic" (TCP).
   Needed for network policies to see WARP traffic.
5. **Gateway network policies** (Traffic policies → Firewall policies → Network), in this order:
   1. Allow: *Destination IP* is `172.25.0.10` AND *Destination Port* in `10993, 10465, 10587`
      (API expression: `net.dst.ip == 172.25.0.10 and net.dst.port in {10993 10465 10587}`).
   2. Block: *Destination IP* is `172.25.0.10` (everything else, notably 25, 143, 110).

### 2. Create the box (billable; review the dry run first)

```
REGION=<region> MY_IP=<your public IP> ./aws-proxy/provision.sh            # prints the plan
REGION=<region> MY_IP=<your public IP> ./aws-proxy/provision.sh --apply    # creates SG, t3.micro, Elastic IP
```
Security group: 993/465/587 from anywhere, 22 from `MY_IP` only. IMDSv2 required. The service token is not put in
user data (it is readable from instance metadata). Wait a few minutes for cloud-init (`cloud-init status --wait`).

### 3. Enrol WARP headlessly

On the box (`ssh -i ~/.ssh/mail-proxy.pem ubuntu@<EIP>`):
```
sudo install -m 600 /dev/null /var/lib/cloudflare-warp/mdm.xml   # path confirmed in Cloudflare docs
sudo nano /var/lib/cloudflare-warp/mdm.xml                       # paste aws-proxy/mdm.xml.example, filled in
sudo systemctl restart warp-svc
```
`auto_connect` is 0, so it enrols but doesn't connect yet.

### 4. Connect, with a safety net against SSH lockout

```
sudo systemd-run --on-active=5min warp-cli disconnect   # auto-disconnects if you get locked out
warp-cli status
warp-cli connect
ip route get 172.25.0.10      # should show the CloudflareWARP interface
ip route get 1.1.1.1          # must still use eth0/ens5
```
Only if the second route is right, keep going. If SSH drops, wait five minutes and reconnect. As a fallback,
use EC2 Instance Connect from the console. Cancel the safety net once all is well:
`sudo systemctl stop run-*.timer`.

### 5. Reachability

From the box the PROXY ports speak PROXY protocol first, so a plain `openssl` to 10993 will not work; test through
HAProxy instead: `openssl s_client -connect 127.0.0.1:993 -servername mail.<domain> </dev/null | head -20` must
show the Let's Encrypt chain (from anywhere, use the Elastic IP). Then `sudo systemctl restart haproxy; sudo ss -tlnp | grep haproxy`
(listening on 993, 465, 587 only). HAProxy's health checks mark each backend up once WARP can reach it.

### 6. HARD STOP: open-relay test (through the proxy, from any machine)

```
# 587 (STARTTLS) and 465 (TLS): an unauthenticated RCPT to an outside address must be rejected
(sleep 3; printf 'EHLO t.example\r\nMAIL FROM:<a@example.com>\r\n'; sleep 1; printf 'RCPT TO:<x@gmail.com>\r\n'; sleep 1; printf 'QUIT\r\n'; sleep 1) \
  | openssl s_client -starttls smtp -connect <EIP>:587 -servername mail.<domain> -quiet
(same with -connect <EIP>:465 and no -starttls)
# from the box: ports 25, 143 and the plain mail ports must give no banner (Gateway block)
```
Both runs must end in `554 5.7.1 ... Client host rejected: Access denied` (the rejected address is your real client
IP). Anything accepted means stop: don't touch DNS and tell whoever maintains the mailserver.
Also log in with a real mailbox through the Elastic IP (type the password; don't script it into history).

### 7. DNS last

Put the Elastic IP in `.env` as `MAIL_PUBLIC_IP=<EIP>` and run `python3 inbound/setup_cloudflare.py`: it creates the
DNS-only A record `mail.<domain>` → the Elastic IP. Then point the clients at `mail.<domain>`:
IMAP 993 (SSL/TLS), SMTP 465 (SSL/TLS) or 587 (STARTTLS).

## Operations

- The backend health check goes red if WARP drops; clients then get connection refused. Check
  `warp-cli status` and `systemctl status warp-svc haproxy`.
- If `compose down/up` ever changes addresses, the pins in `compose.yaml` / `compose.inbound.yaml` keep
  `172.25.0.10` and `172.25.0.11` stable; keep the route, `haproxy.cfg` and `fail2ban-jail.cf` in sync with them.
- Costs: t3.micro + Elastic IP + data transfer. Tear down: terminate the instance, release the Elastic IP
  (otherwise it keeps billing), delete the security group, revoke the service token, delete the A record.
