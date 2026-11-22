#!/bin/sh
# Compose entrypoint (run via `sh`): prepare the writable runtime dir, then hand
# over to the official image entrypoint, which renders templates/*.template.
# Runs for `nginx -t` / `nginx -s reload` one-offs too, so they see the same files.
set -eu

for f in cert.pem key.pem; do
  if [ ! -r "/etc/nginx/origin/$f" ]; then
    echo "start.sh: ERROR: /etc/nginx/origin/$f is missing. Put the Cloudflare Origin Certificate cert.pem + key.pem in ./infra/cloudflare-origin BEFORE starting nginx (docs/CLOUDFLARE_SETUP.md)." >&2
    exit 1
  fi
done

mkdir -p /etc/nginx-run/conf.d
# Empty hash => `staging:*` never matches, so staging auth fails closed.
printf 'staging:%s\n' "${STAGING_BASICAUTH_HASH:-*}" > /etc/nginx-run/htpasswd
chmod 640 /etc/nginx-run/htpasswd
chown root:nginx /etc/nginx-run/htpasswd

exec /docker-entrypoint.sh "$@"
