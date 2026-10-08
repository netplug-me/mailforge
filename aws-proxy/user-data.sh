#!/bin/bash
# cloud-init user data (provision.sh appends the haproxy.cfg write). Installs HAProxy and the WARP
# client. Secrets are deliberately NOT here: user data is readable from instance metadata, so the
# service token goes into mdm.xml by hand (aws-proxy/README.md).
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y haproxy curl gpg lsb-release swaks openssl
curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main" > /etc/apt/sources.list.d/cloudflare-client.list
apt-get update
apt-get install -y cloudflare-warp
systemctl enable haproxy
