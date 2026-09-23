#!/usr/bin/env bash
# Upstream DMS setup wrapper
if docker ps --format '{{.Names}}' | grep -q '^mailserver$'; then
  docker exec -i mailserver setup "$@"
else
  docker run --rm -i \
    -v "$(pwd)/docker-data/dms/config/:/tmp/docker-mailserver/" \
    -v "$(pwd)/docker-data/dms/mail-data/:/var/mail/" \
    -v "$(pwd)/docker-data/dms/mail-state/:/var/mail-state/" \
    -v "$(pwd)/docker-data/dms/mail-logs/:/var/log/mail/" \
    ghcr.io/docker-mailserver/docker-mailserver:latest setup "$@"
fi
