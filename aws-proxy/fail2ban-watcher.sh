#!/usr/bin/env bash
# Mirror fail2ban bans onto the proxy box's HAProxy. Runs on the mailserver host (nerdland).
#
# Remote clients reach the mailserver through cloudflared, so a fail2ban ban (a firewall rule on the
# mailserver) never blocks the attacker. Thanks to PROXY protocol the fail2ban log still carries the real
# client IP, so this script follows that log and, for each Ban / Unban, sets or clears the `gpc0` flag of
# that IP in HAProxy's `st_src` stick-table over SSH + the admin socket. haproxy.cfg rejects connections
# whose entry has gpc0 > 0. Entries expire 10 min after the IP's last connection attempt (table `expire`),
# and a banned IP that keeps knocking keeps refreshing its own entry.
#
#   PROXY_SSH_HOST=<elastic-ip> ./aws-proxy/fail2ban-watcher.sh [--dry-run]
#   <log lines> | ./aws-proxy/fail2ban-watcher.sh --stdin [--dry-run]      # parse stdin, no tailing, no resync
#
# Env: PROXY_SSH_HOST (required unless --dry-run), PROXY_SSH_USER (ubuntu), PROXY_SSH_KEY (optional -i file),
#      HAPROXY_SOCK (/run/haproxy/admin.sock), HAPROXY_TABLE (st_src), DMS_CONTAINER (mailserver),
#      F2B_LOG (docker-data/dms/mail-logs/fail2ban.log; root-only, so without read access it falls back to
#      `docker exec`).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_SSH_HOST="${PROXY_SSH_HOST:-}"
PROXY_SSH_USER="${PROXY_SSH_USER:-ubuntu}"
PROXY_SSH_KEY="${PROXY_SSH_KEY:-}"
HAPROXY_SOCK="${HAPROXY_SOCK:-/run/haproxy/admin.sock}"
HAPROXY_TABLE="${HAPROXY_TABLE:-st_src}"
DMS_CONTAINER="${DMS_CONTAINER:-mailserver}"
F2B_LOG="${F2B_LOG:-$HERE/../docker-data/dms/mail-logs/fail2ban.log}"
CONTAINER_LOG=/var/log/mail/fail2ban.log
BATCH=50
RETRY_DELAY="${RETRY_DELAY:-2}"   # seconds, multiplied by the attempt number

DRY=0; STDIN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --stdin) STDIN=1 ;;
    -h|--help) sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg (see --help)" >&2; exit 2 ;;
  esac
done
if (( ! DRY )) && [[ -z "$PROXY_SSH_HOST" ]]; then echo "set PROXY_SSH_HOST (or use --dry-run)" >&2; exit 2; fi

log() { printf '%s fail2ban-watcher: %s\n' "$(date '+%F %T')" "$*" >&2; }

declare -A BANS=()   # "jail ip" -> 1: bans currently held in fail2ban, so one jail's unban can't lift another's
QUEUE=()             # HAProxy commands waiting for the next flush

# Only public IPv4 is pushed: the table is `type ip`, the security group is IPv4-only, and loopback /
# private ranges are the compose network and cloudflared (banning those would cut off every remote client).
usable_ip() {
  local ip=$1 o
  [[ $ip =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  local -a oct=("${BASH_REMATCH[@]:1:4}")
  for o in "${oct[@]}"; do (( 10#$o <= 255 )) || return 1; done
  local a=$((10#${oct[0]})) b=$((10#${oct[1]}))
  (( a == 0 || a == 10 || a == 127 || a >= 224 )) && return 1
  (( a == 172 && b >= 16 && b <= 31 )) && return 1
  (( a == 192 && b == 168 )) && return 1
  (( a == 169 && b == 254 )) && return 1
  (( a == 100 && b >= 64 && b <= 127 )) && return 1
  return 0
}

# Send the queued commands to HAProxy in as few SSH round trips as possible (';' separates commands).
flush() {
  (( ${#QUEUE[@]} )) || return 0
  local i n=${#QUEUE[@]} chunk joined
  for (( i = 0; i < n; i += BATCH )); do
    chunk=("${QUEUE[@]:i:BATCH}")
    joined=$(IFS=';'; printf '%s' "${chunk[*]}")
    send "$joined"
  done
  QUEUE=()
}

send() {
  local cmds=$1 out try
  if (( DRY )); then printf '[dry-run] haproxy> %s\n' "${cmds//;/$'\n[dry-run] haproxy> '}"; return 0; fi
  local -a ssh=(ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
  [[ -n "$PROXY_SSH_KEY" ]] && ssh+=(-i "$PROXY_SSH_KEY")
  # The commands travel on stdin; the remote command line is fixed, so nothing from the log is ever shell-interpreted.
  for try in 1 2 3; do
    if out=$(printf '%s\n' "$cmds" | "${ssh[@]}" "$PROXY_SSH_USER@$PROXY_SSH_HOST" "sudo -n socat stdio UNIX-CONNECT:$HAPROXY_SOCK" 2>&1); then
      [[ -n "$out" ]] && log "HAProxy replied: $out"
      return 0
    fi
    log "push failed (attempt $try/3): ${out:-no output}"
    sleep $(( try * RETRY_DELAY ))
  done
  log "giving up on: $cmds"
  return 1
}

ban() { # jail ip
  local jail=$1 ip=$2
  if ! usable_ip "$ip"; then log "skip $ip ($jail): not a public IPv4"; return 0; fi
  BANS["$jail $ip"]=1
  QUEUE+=("set table $HAPROXY_TABLE key $ip data.gpc0 1")
  log "ban   $ip ($jail)"
}

unban() { # jail ip
  local jail=$1 ip=$2 key
  usable_ip "$ip" || return 0
  unset "BANS[$jail $ip]"
  for key in "${!BANS[@]}"; do
    if [[ "$key" == *" $ip" ]]; then log "keep  $ip: still banned in ${key% *}"; return 0; fi
  done
  QUEUE+=("set table $HAPROXY_TABLE key $ip data.gpc0 0")
  log "unban $ip ($jail)"
}

# fail2ban.actions lines: "... fail2ban.actions [276]: NOTICE  [postfix] Ban 1.2.3.4" (also Unban, and
# "Restore Ban" when fail2ban restarts and re-applies persisted bans). Anything else is ignored.
handle_line() {
  local re='fail2ban\.actions.*\[([A-Za-z0-9_.-]+)\] (Restore Ban|Ban|Unban) ([0-9a-fA-F:.]+)[[:space:]]*$'
  [[ $1 =~ $re ]] || return 0
  case "${BASH_REMATCH[2]}" in
    Unban) unban "${BASH_REMATCH[1]}" "${BASH_REMATCH[3]}" ;;
    *) ban "${BASH_REMATCH[1]}" "${BASH_REMATCH[3]}" ;;
  esac
  flush
}

# HAProxy forgets its tables on restart, so on startup replay everything fail2ban currently holds.
# `fail2ban-client banned` prints [{'postfix': ['1.2.3.4']}, {'dovecot': []}].
startup_sync() {
  local out chunk jail ip n=0
  if ! out=$(docker exec "$DMS_CONTAINER" fail2ban-client banned 2>&1); then
    log "startup sync skipped (fail2ban-client banned failed: ${out:0:120})"; return 0
  fi
  while IFS= read -r chunk; do
    [[ $chunk =~ ^\'([^\']+)\':\ \[(.*)\]$ ]] || continue
    jail=${BASH_REMATCH[1]}
    while IFS= read -r ip; do ban "$jail" "$ip"; n=$((n + 1)); done < <(grep -oE '[0-9]+(\.[0-9]+){3}' <<<"${BASH_REMATCH[2]}")
  done < <(grep -oE "'[^']+': \[[^]]*\]" <<<"$out")
  flush
  log "startup sync: replayed $n active ban(s)"
}

follow_log() {
  if [[ -r "$F2B_LOG" ]]; then exec tail -n0 -F "$F2B_LOG"; fi
  log "cannot read $F2B_LOG; following $CONTAINER_LOG inside $DMS_CONTAINER instead"
  # Docker does not stop the in-container tail when this script dies; it exits on its next write (SIGPIPE),
  # i.e. at the next fail2ban log line. Pushes are idempotent, so a briefly lingering tail is harmless.
  exec docker exec "$DMS_CONTAINER" tail -n0 -F "$CONTAINER_LOG"
}

if (( STDIN )); then
  while IFS= read -r line || [[ -n "$line" ]]; do handle_line "$line"; done
  exit 0
fi

log "watching fail2ban -> $PROXY_SSH_USER@${PROXY_SSH_HOST:-<dry-run>}:$HAPROXY_SOCK table $HAPROXY_TABLE$( (( DRY )) && echo ' (dry run)')"
# Start tailing before the sync so events that land during the sync are not lost.
exec 3< <(follow_log)
FOLLOW_PID=$!
trap 'kill "$FOLLOW_PID" 2>/dev/null' EXIT
trap 'exit 143' TERM INT
startup_sync
while IFS= read -r line <&3; do handle_line "$line"; done
log "log stream ended"
exit 1
