# Cloudflare origin-hiding runbook (operator)

> **What this does.** Puts `dojocollect.com` (prod + `staging`) behind Cloudflare so
> the public domain resolves to Cloudflare, not the Droplet, and the origin IP is
> never exposed via DNS. It then LOCKS the Droplet firewall so the origin accepts
> connections ONLY from Cloudflare — which is what makes the `CF-Connecting-IP`
> header trustworthy for the per-IP rate limiter in
> [`src/lib/utils/rate-limit.ts`](../src/lib/utils/rate-limit.ts) `clientIp()`.
>
> **These are OUT-OF-REPO operator steps.** The repo already carries the matching
> config: Caddy `trusted_proxies` + the origin-cert `tls` directives in
> [`../Caddyfile`](../Caddyfile), the cert volume mount in
> [`../docker-compose.yml`](../docker-compose.yml), and the `.gitignore` entry for
> the private key. Run the steps BELOW on the Droplet / in the Cloudflare dashboard.
>
> Do them IN ORDER. Step 4 (firewall) can lock you out if you skip the SSH rule, and
> step 5 (Caddy redeploy) will crash-loop if the origin cert from step 3 isn't in
> place first.

Replace `<DROPLET_IP>` with the Droplet's public IPv4 everywhere below.

---

## 1. Add the domain to Cloudflare + switch nameservers

1. In the Cloudflare dashboard: **Add a site** → enter `dojocollect.com` → pick the
   Free plan (sufficient for proxying + Origin Certificates).
2. Cloudflare scans existing DNS and shows **two assigned nameservers**, e.g.
   `xxx.ns.cloudflare.com` / `yyy.ns.cloudflare.com`.
3. At your **registrar** (where the domain was bought), replace the current
   nameservers with those two Cloudflare NS records. Save.
4. Wait for Cloudflare to report the zone as **Active** (minutes to a few hours while
   NS propagates). Do not continue until it is Active.

## 2. DNS records — all PROXIED (orange cloud) to hide the origin IP

In Cloudflare → **DNS → Records**, create/verify these A records, each with the proxy
status set to **Proxied (orange cloud)** — this is what keeps `<DROPLET_IP>` out of
public DNS answers:

| Type | Name      | Content        | Proxy status      |
|------|-----------|----------------|-------------------|
| A    | `@`       | `<DROPLET_IP>` | Proxied (orange)  |
| A    | `www`     | `<DROPLET_IP>` | Proxied (orange)  |
| A    | `staging` | `<DROPLET_IP>` | Proxied (orange)  |

Verify no record still points at the origin in **DNS-only (grey cloud)** mode — a
single grey-cloud record leaks the IP and defeats the whole exercise:

```bash
# From anywhere: the answer must be a Cloudflare IP, NOT <DROPLET_IP>.
dig +short dojocollect.com
dig +short staging.dojocollect.com
```

## 3. SSL/TLS mode + Origin Certificate

1. Cloudflare → **SSL/TLS → Overview** → set the mode to **Full (strict)**. This makes
   Cloudflare validate the origin's certificate, which pairs with the Origin
   Certificate below (a real cert Cloudflare's own CA trusts).
2. Cloudflare → **SSL/TLS → Origin Server → Create Certificate**. Accept the default
   key type; set the hostnames to cover both prod and staging:
   `dojocollect.com` **and** `*.dojocollect.com`. Create it.
3. Cloudflare shows the **Origin Certificate** and the **Private Key** ONCE. On the
   Droplet, paste them into the mount directory the Caddy service expects:

   ```bash
   mkdir -p /srv/dojo/infra/cloudflare-origin   # path = <repo>/infra/cloudflare-origin
   # Paste the certificate body into cert.pem and the private key into key.pem:
   nano /srv/dojo/infra/cloudflare-origin/cert.pem
   nano /srv/dojo/infra/cloudflare-origin/key.pem
   chmod 600 /srv/dojo/infra/cloudflare-origin/key.pem   # key is readable only by owner
   ```

   The directory and `*.pem` are git-ignored (see `.gitignore`) — the private key is
   NEVER committed. Caddy mounts this dir read-only at `/etc/caddy/origin` and serves
   it via `tls /etc/caddy/origin/cert.pem /etc/caddy/origin/key.pem` (see the Caddyfile
   prod + staging blocks). ONE Origin Certificate covering `dojocollect.com` +
   `*.dojocollect.com` serves BOTH prod and staging. If you prefer separate certs,
   create a second one and point the staging block's `tls` paths at the second file
   pair.

## 4. Lock the Droplet firewall to Cloudflare ONLY (ufw)

> **WHY this step is mandatory, not optional.** Proxied DNS (step 2) hides the IP, but
> anyone who learns `<DROPLET_IP>` by other means could still connect to 80/443
> DIRECTLY, bypassing Cloudflare — and forge a `CF-Connecting-IP` header to rotate
> per-IP rate-limit buckets and brute-force sign-in / email-OTP / admin-auth. Closing
> 80/443 to everything EXCEPT Cloudflare's ranges removes that bypass and is exactly
> what makes `CF-Connecting-IP` authoritative for
> [`src/lib/utils/rate-limit.ts`](../src/lib/utils/rate-limit.ts) `clientIp()`.

Run on the Droplet, IN THIS ORDER:

```bash
# 1. ALLOW SSH FIRST — never lock yourself out before enabling the firewall.
sudo ufw allow 22/tcp

# 2. Allow 80 + 443 ONLY from Cloudflare's published IPv4 ranges.
for ip in $(curl -s https://www.cloudflare.com/ips-v4); do
  sudo ufw allow from "$ip" to any port 80,443 proto tcp
done

# 3. Allow 80 + 443 ONLY from Cloudflare's published IPv6 ranges.
for ip in $(curl -s https://www.cloudflare.com/ips-v6); do
  sudo ufw allow from "$ip" to any port 80,443 proto tcp
done

# 4. Enable the firewall (default-deny inbound; only the rules above pass).
sudo ufw --force enable

# Verify: 22 open to anywhere; 80/443 listed ONLY against Cloudflare ranges.
sudo ufw status verbose
```

Because ufw default-denies inbound once enabled, any inbound 80/443 from a
non-Cloudflare source is now dropped. SSH (22) stays open to all — restrict it further
to your admin IP if you wish, but do that in a SEPARATE change after confirming access.

## 5. Redeploy Caddy (cert must already be in place)

The origin cert from step 3 MUST exist before Caddy starts, or the `tls` directive
fails and Caddy crash-loops. Then:

```bash
cd /srv/dojo              # repo root (where docker-compose.yml lives)
docker compose up -d --force-recreate caddy
docker compose logs -f caddy   # confirm it started cleanly (no cert/tls errors)
```

Verify the domain serves over HTTPS AND the direct-IP bypass is closed:

```bash
# Through Cloudflare — should return 200/301 and a valid chain:
curl -I https://dojocollect.com

# Direct to the origin IP, bypassing Cloudflare — MUST fail / time out now that
# the firewall allows 80/443 only from Cloudflare (run from OUTSIDE Cloudflare):
curl -k --resolve dojocollect.com:443:<DROPLET_IP> https://dojocollect.com
#   expected: connection refused / timeout (the firewall dropped it)
```

Staging is reached the same way (`https://staging.dojocollect.com`) and additionally
prompts for Caddy `basic_auth`.

### Staging basic-auth password (env var, survives deploys)

The staging `basic_auth` hash is read from the `STAGING_BASICAUTH_HASH` env var — it is
NO LONGER hand-edited into the Caddyfile. (Previously the Caddyfile carried a hardcoded
placeholder hash that the operator replaced by hand; every `git reset --hard origin/staging`
deploy overwrote it back to the placeholder and broke staging basic-auth.) Set it ONCE in
the gitignored root `.env` and deploys no longer clobber it:

```bash
# 1. Generate the bcrypt hash (quote the password so the shell leaves it intact):
docker run --rm caddy:2-alpine caddy hash-password --plaintext '<password>'
#    → prints a $2a$... hash.

# 2. Put it in the gitignored ROOT .env (the SAME file docker-compose reads DOMAIN
#    from — the shared caddy service has no env_file, so compose interpolates both
#    from the root .env, NOT from .env.staging). Paste the full hash UNQUOTED:
#        STAGING_BASICAUTH_HASH=$2a$14$...
#    (template entry lives in .env.example).

# 3. Recreate caddy so it picks up the new container env:
cd /srv/dojo
docker compose up -d --force-recreate caddy
```

The Caddyfile reads it via `basic_auth { staging {$STAGING_BASICAUTH_HASH} }` — the same
`{$ENV_VAR}` substitution as the prod block's `{$DOMAIN::80}`. Log in with username
`staging` and the plaintext password you hashed. If the var is empty/unset, there is no
valid credential and staging basic-auth fails closed.

## 6. Maintenance — keep the Cloudflare ranges fresh

Cloudflare occasionally changes its published IP ranges. When it does, BOTH of these
must be refreshed from <https://www.cloudflare.com/ips-v4> and
<https://www.cloudflare.com/ips-v6>, together:

- the `servers { trusted_proxies static … }` list at the top of
  [`../Caddyfile`](../Caddyfile) (then `docker compose up -d --force-recreate caddy`), and
- the ufw allow-rules from step 4 (remove the stale `from <ip>` rules, re-run the loops).

If these drift apart, client-IP resolution (Caddy) or origin reachability (ufw) breaks.
A stale `trusted_proxies` list silently degrades the rate limiter back to one shared
bucket; a stale ufw list can make the origin unreachable through Cloudflare.
