#!/usr/bin/env bash
# Renew the Let's Encrypt certificate for MX_HOST via the Cloudflare DNS-01 challenge,
# then restart Postfix/Dovecot in docker-mailserver if the certificate changed.
#
# certbot only renews within 30 days of expiry, so running this often is cheap.
# Scheduled from the user crontab. Usage:
#   scripts/renew-cert.sh            # renew if due
#   scripts/renew-cert.sh --dry-run  # test against Let's Encrypt staging, no changes
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
LOG_DIR="$PROJECT_DIR/logs"
IMAGE="certbot/dns-cloudflare:latest"
CONTAINER="mailserver"
EXTRA_ARGS=()
[[ "${1:-}" == "--dry-run" ]] && EXTRA_ARGS+=(--dry-run)

mkdir -p "$LOG_DIR"
exec >>"$LOG_DIR/renew-cert.log" 2>&1
echo "=== $(date -Is) renew-cert ${EXTRA_ARGS[*]:-}"

get_env() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }
TOKEN="$(get_env CF_API_TOKEN)"
PRIMARY_DOMAIN="$(get_env PRIMARY_DOMAIN)"
MX_HOST="$(get_env MX_HOST)"
MX_HOST="${MX_HOST:-mail.$PRIMARY_DOMAIN}"
[[ -n "$TOKEN" && -n "$MX_HOST" ]] || { echo "CF_API_TOKEN / MX_HOST missing from $ENV_FILE"; exit 1; }

# certbot's saved renewal config expects the credentials at /creds/cloudflare.ini.
# Write them to a private temp dir that is always removed on exit.
CREDS_DIR="$(mktemp -d)"
trap 'rm -rf "$CREDS_DIR"' EXIT
( umask 077; printf 'dns_cloudflare_api_token = %s\n' "$TOKEN" > "$CREDS_DIR/cloudflare.ini" )

# /etc/letsencrypt is root-only; read the cert fingerprint through a container.
fingerprint() {
  docker run --rm -v /etc/letsencrypt:/etc/letsencrypt:ro --entrypoint sh "$IMAGE" -c \
    "openssl x509 -in /etc/letsencrypt/live/$MX_HOST/fullchain.pem -noout -fingerprint -sha256 2>/dev/null" || true
}

docker pull -q "$IMAGE" >/dev/null
BEFORE="$(fingerprint)"

docker run --rm \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -v /var/lib/letsencrypt:/var/lib/letsencrypt \
  -v "$CREDS_DIR":/creds:ro \
  "$IMAGE" renew --non-interactive --cert-name "$MX_HOST" "${EXTRA_ARGS[@]}"

AFTER="$(fingerprint)"
if [[ ${#EXTRA_ARGS[@]} -eq 0 && -n "$AFTER" && "$BEFORE" != "$AFTER" ]]; then
  echo "certificate changed; restarting postfix and dovecot in $CONTAINER"
  docker exec "$CONTAINER" supervisorctl restart postfix dovecot
else
  echo "certificate unchanged"
fi
docker run --rm -v /etc/letsencrypt:/etc/letsencrypt:ro --entrypoint sh "$IMAGE" -c \
  "openssl x509 -in /etc/letsencrypt/live/$MX_HOST/fullchain.pem -noout -enddate"
