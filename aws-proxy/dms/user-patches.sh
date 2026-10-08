#!/bin/bash
# docker-mailserver runs this at container start (before Postfix). Adds PROXY-protocol twins of the
# submission (587) and submissions (465) services on 10587 / 10465, copied from the shipped master.cf
# so their restrictions stay identical. They keep the original syslog_name so fail2ban filters match.
# smtpd_upstream_proxy_protocol makes Postfix read the client address from the HAProxy header;
# submission still requires SASL (permit_sasl_authenticated,reject), so a spoofed address buys nothing.
MASTER=/etc/postfix/master.cf
if ! grep -q '^10587[[:space:]]' "${MASTER}"; then
  TMP=$(mktemp)
  awk '
    function flush() { if (blk) { print "  -o smtpd_upstream_proxy_protocol=haproxy"; print "  -o smtpd_client_auth_rate_limit=20"; print "" } blk = 0 }
    /^(submission|submissions)[ \t]+inet/ { flush(); blk = 1; $1 = ($1 == "submission") ? "10587" : "10465"; print; next }
    blk && /^[ \t]+-o/ { print; next }
    { flush() }
    END { flush() }
  ' "${MASTER}" >"${TMP}"
  cat "${TMP}" >>"${MASTER}"
  rm -f "${TMP}"
fi
