#!/usr/bin/env bash
# Create the proxy box: security group, Ubuntu 24.04 instance, Elastic IP. Prints the plan unless
# --apply is given. Needs the aws CLI with EC2 permissions and a default VPC (its CIDR must not
# overlap 172.25.0.0/16; the default 172.31.0.0/16 is fine).
#
#   REGION=us-east-1 MY_IP=203.0.113.7 ./aws-proxy/provision.sh [--apply]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGION="${REGION:?set REGION}"; MY_IP="${MY_IP:?set MY_IP (your public IP, for SSH)}"
TYPE="${INSTANCE_TYPE:-t3.micro}"; KEY="${KEY_NAME:-mail-proxy}"; NAME=mail-proxy
APPLY=0; [[ "${1:-}" == "--apply" ]] && APPLY=1
aws() { command aws --region "$REGION" "$@"; }
run() { echo "+ $*"; if (( APPLY )); then "$@"; fi; }

AMI=$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
echo "account: $(aws sts get-caller-identity --query Arn --output text)  region: $REGION  ami: $AMI  vpc: $VPC"
(( APPLY )) || echo "(dry run: pass --apply to create resources; these cost money until terminated)"

UD=$(mktemp); trap 'rm -f "$UD"' EXIT
{ cat "$HERE/user-data.sh"
  echo "echo '$(base64 -w0 "$HERE/haproxy.cfg")' | base64 -d > /etc/haproxy/haproxy.cfg"
  echo "systemctl restart haproxy"; } > "$UD"

if ! aws ec2 describe-key-pairs --key-names "$KEY" >/dev/null 2>&1; then
  echo "+ create key pair $KEY -> ~/.ssh/$KEY.pem"
  if (( APPLY )); then
    aws ec2 create-key-pair --key-name "$KEY" --query KeyMaterial --output text > ~/.ssh/"$KEY.pem"; chmod 600 ~/.ssh/"$KEY.pem"
  fi
fi

SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$NAME Name=vpc-id,Values="$VPC" --query 'SecurityGroups[0].GroupId' --output text)
if [[ "$SG" == None ]]; then
  echo "+ create security group $NAME"
  if (( APPLY )); then
    SG=$(aws ec2 create-security-group --group-name $NAME --description "mail proxy" --vpc-id "$VPC" --query GroupId --output text)
    # Mail ports are world-open (phones roam); SSH only from your address. 25/143 are never opened.
    for p in 993 465 587; do aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port $p --cidr 0.0.0.0/0 >/dev/null; done
    aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 22 --cidr "$MY_IP/32" >/dev/null
  fi
else echo "security group $NAME exists ($SG)"; fi

echo "+ run-instances $TYPE $AMI (key $KEY, sg ${SG/None/<new>}, user-data $(wc -c <"$UD") bytes)"
if (( APPLY )); then
  IID=$(aws ec2 run-instances --image-id "$AMI" --instance-type "$TYPE" --key-name "$KEY" --security-group-ids "$SG" \
        --user-data "file://$UD" --metadata-options HttpTokens=required \
        --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" --query 'Instances[0].InstanceId' --output text)
  aws ec2 wait instance-running --instance-ids "$IID"
  ALLOC=$(aws ec2 allocate-address --domain vpc --query AllocationId --output text)
  aws ec2 associate-address --instance-id "$IID" --allocation-id "$ALLOC" >/dev/null
  EIP=$(aws ec2 describe-addresses --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp' --output text)
  echo "instance $IID, Elastic IP $EIP. Cloud-init takes a few minutes; then follow aws-proxy/README.md."
  echo "ssh -i ~/.ssh/$KEY.pem ubuntu@$EIP"
fi
