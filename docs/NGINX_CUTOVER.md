# Nginx cutover + rollback runbook (operator)

Replaces Caddy with Nginx as the one reverse proxy that fronts prod
(`dojocollect.com`) and staging (`staging.dojocollect.com`) on the Droplet. The
behaviour is reproduced from the old `Caddyfile`; where it differs on purpose, the
difference is listed in [Behaviour differences](#behaviour-differences-vs-caddy).
Caddy stays in the repo as a rollback behind the compose profile `caddy`.

Run the cutover on the Droplet. Nothing here needs a Cloudflare change.

## Architecture

- One `nginx` container (`tcg_nginx`, image `nginx:1.30.7-alpine`) publishes 80 and 443
  and proxies by `Host`: `dojocollect.com` to `app:3000`, `staging.dojocollect.com`
  to `app-staging:3000` (behind basic auth).
- Cloudflare is unchanged: same Full (strict) mode, same Origin Certificate in
  `./infra/cloudflare-origin`, same ports, same ufw lock to Cloudflare ranges
  ([CLOUDFLARE_SETUP.md](./CLOUDFLARE_SETUP.md)).
- Upstream names are resolved at request time (`resolver 127.0.0.11` + variable
  `proxy_pass`), so `docker compose up -d --build app` needs no nginx restart and
  nginx starts even when an app container is down.
- Pinned image: `nginx:1.30.7-alpine` (nginx 1.30.7, stable branch; built with
  OpenSSL 3.5.9), checked 2026-11-22 with `docker run --rm --entrypoint nginx
  nginx:1.30.7-alpine -V`. Bump the tag in `docker-compose.yml` on purpose, then re-run
  `node scripts/verify-nginx.mjs`.

## Config layout (`infra/nginx/`)

| Path | What it is |
|---|---|
| `nginx.conf` | Main config. Includes `snippets/http-*.conf` and the rendered `/etc/nginx-run/conf.d/*.conf`. |
| `mime.types` | Stock mime types from the pinned image. |
| `snippets/http-global.conf` | `http{}` level: Cloudflare `set_real_ip_from` ranges + `real_ip_header CF-Connecting-IP`, resolver, maps, gzip, redacted `log_format`, timeouts, TLS settings, loopback `:8081/healthz`. |
| `snippets/proxy-common.conf` | Forwarded headers (`Host`, `X-Real-IP`, `X-Forwarded-*`), WebSocket upgrade, 330s timeouts. |
| `snippets/locations.conf` | Recognize tiers (30,000,000 B with a session cookie, 64,000 B without), the CSV export (unbuffered), default proxy. |
| `templates/10-dojo.conf.template` | Server blocks. Only `${DOMAIN}` is substituted (`NGINX_ENVSUBST_FILTER=DOMAIN`). |
| `scripts/start.sh` | Compose entrypoint: checks the origin cert, writes the staging htpasswd, then runs the official entrypoint. |
| `origin/.gitkeep` | Mountpoint for the cert directory inside the read-only config mount. |

Change config without recreating the container (the whole directory is mounted
read-only, so edits on the host are visible immediately):

```bash
docker compose exec nginx nginx -t && docker compose exec nginx nginx -s reload
```

Templates, `DOMAIN` and the htpasswd are rendered when the container STARTS. A change
to `templates/*.template`, `DOMAIN` or `STAGING_BASICAUTH_HASH` needs:

```bash
docker compose up -d --force-recreate nginx
```

Edits to the `snippets/*.conf` files and `nginx.conf` only need `nginx -t` + reload.

## Pre-flight checklist (on the Droplet, before the cutover)

1. Origin cert present (the key is git-ignored, never committed):
   `ls -l /srv/dojo/infra/cloudflare-origin/cert.pem /srv/dojo/infra/cloudflare-origin/key.pem`.
   Without them `start.sh` stops with `ERROR: /etc/nginx/origin/cert.pem is missing`.
2. Root `.env` has `DOMAIN=dojocollect.com` (unquoted) and `STAGING_BASICAUTH_HASH`.
   Compose refuses to start nginx without `DOMAIN`.
3. Recommended: replace the staging bcrypt hash with an apr1 hash of the SAME
   password. Nginx runs `crypt()` on every staging request and blocks a worker while
   it does (Caddy cached the result). Measured locally on the pinned image
   (`node scripts/verify-nginx.mjs`, median of 3 authed staging requests, Docker
   Desktop; an unauthenticated prod request took 15 ms):

   | Hash | Authed staging request |
   |---|---|
   | bcrypt `$2a$` cost 14 (what `caddy hash-password` produced) | about 1040 to 1070 ms |
   | bcrypt cost 10 (`$2a$`, `$2b$`, `$2y$` all accepted) | about 72 to 76 ms |
   | apr1 (`openssl passwd -apr1`) | about 15 ms |

   Generate it (verified; the nginx image has no `openssl`, so use alpine):

   ```bash
   docker run --rm alpine sh -c "apk add -q openssl && openssl passwd -apr1 '<password>'"
   ```

   Put it in the root `.env` with every `$` doubled (compose interpolates `$name`
   in `.env`; an unescaped hash is silently truncated):

   ```
   STAGING_BASICAUTH_HASH=$$apr1$$salt$$hash
   ```

   An existing bcrypt hash keeps working, so this step is optional but advised.
4. Update the checkout and pull the image:

   ```bash
   cd /srv/dojo
   git fetch origin && git reset --hard origin/<branch>   # same convention as app deploys; .env is git-ignored and survives
   docker compose pull nginx
   ```

## Cutover (in order)

```bash
cd /srv/dojo
git fetch origin && git reset --hard origin/<branch>
docker compose pull nginx
docker compose run --rm nginx nginx -t        # expect: syntax is ok / test is successful
docker compose stop caddy && docker compose rm -f caddy
docker compose up -d nginx
docker compose ps
docker compose logs --tail=50 nginx
```

Expected: `nginx -t` prints `syntax is ok` and `test is successful`; `docker compose
ps` shows `tcg_nginx` Up (healthy after about 10 s); the log tail has no `[emerg]`
lines. Every `docker compose` command above was syntax-checked against the real
`docker-compose.yml` with dummy env (`docker compose config`, `--profile caddy config
--services`, `up --dry-run`; `stop caddy` and `rm -f caddy` exit 0 even when caddy was
never started). `nginx -t` through `docker compose run` exits 1 with the `start.sh`
cert error when the cert directory is empty, which is the intended failure.

Expected downtime: the gap is the time between stopping Caddy and nginx answering
on 443. Measured locally (stop one proxy container on a host port, start the real
repo nginx config on the same port, poll over HTTPS): 1.4 s, 1.9 s and 1.4 s, so
budget 2 to 10 s on the Droplet (image already pulled). Cloudflare retries or shows
a brief 52x during that window.

## Smoke checks

```bash
# Prod: 200 (through Cloudflare)
curl -sI https://dojocollect.com | head -n 1
# Staging without credentials: 401 with a WWW-Authenticate header
curl -sI https://staging.dojocollect.com | head -n 1
# Staging with credentials: 200
curl -sI -u staging:'<password>' https://staging.dojocollect.com | head -n 1
# HTTP redirect: nginx answers 308 (Caddy did too). Through Cloudflare you may see
# Cloudflare's own 301 first if "Always Use HTTPS" is on.
curl -sI http://dojocollect.com | head -n 3
# Direct to the origin, on the Droplet itself (bypasses Cloudflare, so use -k and --resolve):
curl -skI --resolve dojocollect.com:443:127.0.0.1 https://dojocollect.com | head -n 1
curl -sI --resolve dojocollect.com:80:127.0.0.1 http://dojocollect.com | head -n 3   # 308, Location: https://dojocollect.com/
# Recognize body cap without a session cookie (64,000 B): 413
head -c 100000 /dev/zero | curl -s -o /dev/null -w '%{http_code}\n' -X POST --data-binary @- \
  -H 'Content-Type: application/json' https://dojocollect.com/api/cards/recognize
```

Client IP sanity check: visit the site once from your own connection, then run
`docker compose logs --tail=5 nginx`. The first field of each line is the client IP.
It must be your public IP (resolved from `CF-Connecting-IP` because the peer is a
Cloudflare range), not a Cloudflare or `172.x` address. The app's rate limiter keys
on `CF-Connecting-IP` first; `scripts/verify-nginx.mjs` checks that nginx passes the
header through byte-identical and that `clientIp()` returns it.

## Rollback

```bash
docker compose stop nginx && docker compose --profile caddy up -d caddy
```

Caddy needs `./Caddyfile`, `./infra/cloudflare-origin` and its `caddy_data` /
`caddy_config` volumes, all still present. What was verified locally (no 80/443
bound): `docker compose --profile caddy config --services` lists `caddy`; `docker
compose --profile caddy up -d caddy --dry-run` plans caddy, `app` and `redis` only
(no nginx, no `app-staging`); plain `docker compose up -d --dry-run` plans nginx and
not caddy; `node scripts/verify-caddy-body-limit.mjs` still passes against the real
`caddy:2-alpine`. The rollback does not start `app-staging`; leave it running if it
already is.

## What NOT to do

- Never run nginx and caddy together: both publish 80 and 443.
- Do not delete `Caddyfile`, `caddy_data` or `caddy_config` until you no longer want
  the rollback.
- Do not edit `.env` values for `DOMAIN` / `STAGING_BASICAUTH_HASH` and expect a reload
  to pick them up; recreate the container.
- Do not commit anything from `infra/cloudflare-origin/`.
- Keep the Cloudflare ranges in `infra/nginx/snippets/http-global.conf` and the ufw
  rules in sync (fetched 2026-11-22; see CLOUDFLARE_SETUP.md section 6).

## Behaviour differences vs Caddy

| Area | Caddy | Nginx |
|---|---|---|
| `DOMAIN` unset | Plain HTTP on :80 (dev mode) | Compose refuses to start. Local dev uses `npm run dev`; plain-HTTP proxy dev stays on `docker compose --profile caddy up caddy`. |
| `X-Real-IP` | Raw TCP peer (the Cloudflare edge IP) | Real visitor IP when the peer is a Cloudflare range. Strictly more useful; the app still reads `CF-Connecting-IP` first. |
| Body limits | Streamed to the app, cut at the limit (upstream saw a truncated body) | `413` up front on `Content-Length`; the body is buffered before forwarding, so the app never sees a partial oversized body. Costs temp-file space for scans up to 30 MB. Chunked bodies are cut at the limit with 413. |
| Other routes | No limit | Finite global cap of 30,000,000 B (equals the recognize ceiling; every other POST route caps itself at 16 KB or less). |
| Timeouts | None | 330 s proxy read/send (cron `maxDuration` 300 s + 30 s), 10 s connect. Cloudflare cuts proxied requests at 100 s regardless. |
| `Server` header | `Caddy` | `nginx` (no version) |
| Security headers | `header{}` added X-Frame-Options SAMEORIGIN, Referrer-Policy and nosniff next to the app's own, so clients saw duplicate/conflicting values | Nginx adds none: clients get exactly the app's single set (DENY, etc.). Proxy-generated responses (e.g. the staging 401) carry no security headers. Intentional fix, verified by `verify-nginx.mjs`. |
| Staging password check | bcrypt result cached | `crypt()` on every request; see the latency table above. |
| HTTP/3 | Served | Not served. Compose only published TCP, and Cloudflare uses h1/h2 to the origin. |

## Troubleshooting

- **502 after an app rebuild.** Upstreams are re-resolved every 10 s
  (`resolver ... valid=10s`), so it clears itself. If it persists:
  `docker compose ps app app-staging` and `docker compose logs --tail=50 app`.
- **`start.sh: ERROR: /etc/nginx/origin/cert.pem is missing`.** The origin cert is not
  in `./infra/cloudflare-origin`. Paste `cert.pem` and `key.pem` there
  (CLOUDFLARE_SETUP.md step 3) and start again. A bind mount of a missing directory
  makes Docker create it empty, so check the files, not the directory.
- **Staging 401 loop.** Wrong password, an empty or truncated hash, or an unescaped
  `$` in `.env`. Check with
  `docker compose exec nginx cat /etc/nginx-run/htpasswd` (prints the stored hash; do
  not paste it anywhere). It should start with `staging:$apr1$` or `staging:$2`. After
  fixing `.env`, `docker compose up -d --force-recreate nginx`. `staging:*` means the
  variable was empty.
- **413 on a large POST.** Expected above 30,000,000 B anywhere, above 64,000 B on
  `/api/cards/recognize` without a session cookie. Check the access log status and
  `client_max_body_size` in `infra/nginx/snippets/`.
- **`nginx: [emerg] host not found in upstream`.** Should not occur (the upstream is a
  variable). If it does, the config was edited to use a static `upstream{}` or a
  literal `proxy_pass http://app:3000`; revert to the `set $upstream` pattern.
- **`bind: address already in use` on 80/443.** Caddy (or another proxy) is still
  running. `docker compose stop caddy`, then start nginx.
- **Verify after config changes:** `node scripts/verify-nginx.mjs` (about 3 minutes,
  needs Docker, binds only 127.0.0.1:18443 and 18080, cleans up after itself).
