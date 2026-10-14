#!/usr/bin/env bash
# Install fail2ban-watcher.sh as a systemd service on the mailserver host (run once, as root).
#
#   sudo ./aws-proxy/install-fail2ban-watcher.sh              # install, enable, start
#   sudo ./aws-proxy/install-fail2ban-watcher.sh --uninstall
#   ./aws-proxy/install-fail2ban-watcher.sh --print           # show the unit it would write; changes nothing
#
# Env: PROXY_SSH_HOST  proxy box address (default: MAIL_PUBLIC_IP from the repo's .env)
#      PROXY_SSH_KEY   private key (default: ~/.ssh/mail-proxy.pem of WATCHER_USER)
#      WATCHER_USER    account the service runs as (default: the user who ran sudo). It needs read access to the
#                      key, membership of the `docker` group, and SSH access to the proxy box.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
UNIT=/etc/systemd/system/fail2ban-watcher.service
MODE=install
case "${1:-}" in
  --print) MODE=print ;;
  --uninstall) MODE=uninstall ;;
  "") ;;
  *) echo "usage: $0 [--print|--uninstall]" >&2; exit 2 ;;
esac

if [[ $MODE == uninstall ]]; then
  [[ $EUID -eq 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }
  systemctl disable --now fail2ban-watcher 2>/dev/null || true
  rm -f "$UNIT"; systemctl daemon-reload
  echo "removed fail2ban-watcher.service (bans already pushed to HAProxy expire on their own after 10 minutes)"
  exit 0
fi

WATCHER_USER="${WATCHER_USER:-${SUDO_USER:-$USER}}"
HOME_DIR="$(getent passwd "$WATCHER_USER" | cut -d: -f6)"
[[ -n "$HOME_DIR" ]] || { echo "unknown user: $WATCHER_USER" >&2; exit 1; }
PROXY_SSH_KEY="${PROXY_SSH_KEY:-$HOME_DIR/.ssh/mail-proxy.pem}"
if [[ -z "${PROXY_SSH_HOST:-}" && -r "$REPO/.env" ]]; then
  PROXY_SSH_HOST="$(sed -n 's/^MAIL_PUBLIC_IP=//p' "$REPO/.env" | tail -1 | tr -d '"'"'"' ')"
fi
[[ -n "${PROXY_SSH_HOST:-}" ]] || { echo "set PROXY_SSH_HOST (no MAIL_PUBLIC_IP in .env)" >&2; exit 1; }
PROXY_SSH_USER="${PROXY_SSH_USER:-ubuntu}"

render() {
  cat <<EOF
[Unit]
Description=fail2ban to HAProxy ban sync (mailforge)
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$WATCHER_USER
Environment=PROXY_SSH_HOST=$PROXY_SSH_HOST PROXY_SSH_USER=$PROXY_SSH_USER PROXY_SSH_KEY=$PROXY_SSH_KEY
ExecStart=$HERE/fail2ban-watcher.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
}

if [[ $MODE == print ]]; then render; exit 0; fi

[[ $EUID -eq 0 ]] || { echo "run as root: sudo $0" >&2; exit 1; }
fail=0
[[ -r "$PROXY_SSH_KEY" ]] || { echo "key not found: $PROXY_SSH_KEY" >&2; fail=1; }
id -nG "$WATCHER_USER" | tr ' ' '\n' | grep -qx docker || { echo "$WATCHER_USER is not in the docker group (needed for docker exec)" >&2; fail=1; }
(( fail )) && exit 1
echo "checking SSH + HAProxy socket as $WATCHER_USER ..."
sudo -u "$WATCHER_USER" ssh -i "$PROXY_SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new \
  "$PROXY_SSH_USER@$PROXY_SSH_HOST" 'echo "show info" | sudo -n socat stdio UNIX-CONNECT:/run/haproxy/admin.sock | head -1' \
  || { echo "cannot reach the HAProxy admin socket on $PROXY_SSH_HOST (see aws-proxy/README.md, 'Ban sync')" >&2; exit 1; }
sudo -u "$WATCHER_USER" docker exec mailserver fail2ban-client ping >/dev/null \
  || { echo "cannot run fail2ban-client in the mailserver container" >&2; exit 1; }

render > "$UNIT"
systemctl daemon-reload
systemctl enable --now fail2ban-watcher
sleep 3
systemctl --no-pager --lines=15 status fail2ban-watcher || true
echo
echo "installed $UNIT. Logs: journalctl -u fail2ban-watcher -f"
