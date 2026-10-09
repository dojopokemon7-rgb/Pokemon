# DigitalOcean Deployment Runbook — Dojo TCG PWA

**Phase 1 (this runbook):** deploy to a Droplet, reachable over **HTTP at the Droplet IP** (no domain yet).
**Phase 2 (later):** add a domain → Caddy auto-upgrades to HTTPS. Covered at the end.

**Model:** you run the steps on your DO account + the Droplet. Paste me any error and I'll fix it.
**Stack:** Docker Compose = Next.js app + password-protected Redis + Caddy reverse proxy. Database is remote (Supabase Mumbai, already migrated).

---

## 0. Prerequisites (on your side)
- A DigitalOcean account with billing enabled.
- The repo is public/accessible at `https://github.com/dojopokemon7-rgb/Pokemon.git` (or have a deploy key / PAT if private).
- Your Mumbai Supabase **DB password**, **anon key**, and your **Scrydex** + **Google OAuth** credentials ready to paste into `.env` on the server.

---

## 1. Create the Droplet
In the DO dashboard → **Create → Droplets**:
- **Image:** Ubuntu 24.04 LTS
- **Droplet type:** Basic → Regular → **2 vCPU / 4 GB** (~$24/mo). (1vCPU/2GB works for light traffic.)
- **Region:** **Bangalore (BLR1)** — closest to your Mumbai DB + Indian users (lowest latency).
- **Authentication:** SSH key (recommended) or password.
- Create. Note the Droplet's **public IPv4** (call it `<DROPLET_IP>`).

---

## 2. SSH in + install Docker
```bash
ssh root@<DROPLET_IP>

# Install Docker Engine + Compose plugin (official convenience script)
curl -fsSL https://get.docker.com | sh
docker --version && docker compose version   # verify both work
```

---

## 3. Get the code
```bash
cd /opt
git clone https://github.com/dojopokemon7-rgb/Pokemon.git dojo
cd dojo
```
(Private repo? Use a GitHub Personal Access Token:
`git clone https://<TOKEN>@github.com/dojopokemon7-rgb/Pokemon.git dojo`)

---

## 4. Create the production `.env`
A template is in the repo at `deploy/env.production.template`. Copy it and fill the blanks:
```bash
cp deploy/env.production.template .env
nano .env     # fill every <FILL> / <...> value
```
Fill in on the Droplet:
- `DATABASE_URL` / `DIRECT_URL` — already have the Mumbai host; replace `<DB_PASSWORD>` with your Mumbai DB password.
- `REDIS_PASSWORD` — generate: `openssl rand -hex 24`
- `BETTER_AUTH_SECRET` — generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (or `openssl rand -hex 32`)
- `BETTER_AUTH_URL` — set to `http://<DROPLET_IP>` for Phase 1.
- `DOMAIN` — leave **blank** for Phase 1.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SCRYDEX_API_KEY`, `SCRYDEX_TEAM_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CRON_SECRET` — paste your real values.

---

## 5. Open the firewall (HTTP)
```bash
# UFW (if enabled) — allow SSH + HTTP (and 443 for Phase 2 later)
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable
```
Also, in the DO dashboard, if you attached a **Cloud Firewall**, allow inbound 22/80/443.

---

## 6. Build + start the stack
```bash
cd /opt/dojo
docker compose up -d --build
```
First build takes a few minutes (Next.js production build in-container). Then:
```bash
docker compose ps              # app, redis, caddy should be Up
docker compose logs -f app     # watch startup; Ctrl-C to stop watching
```

---

## 7. Verify
```bash
# Health through Caddy (port 80). Expect {"status":"ok",...} once Redis connects.
curl -i http://localhost/api/health

# A real data path (proves the Mumbai DB connection + search):
curl "http://localhost/api/cards/search?game=pokemon&query=charizard&limit=3"
```
From your own machine, open **`http://<DROPLET_IP>`** in a browser — you should see the app.

Expected health: `{"status":"ok","services":{"app":"ok","postgres":"ok","redis":"ok"}}`.
(If `redis:"unreachable"` right at startup then flips to ok, that's the normal first-ping race.)

---

## 8. Daily price-refresh cron
The app exposes `GET /api/cron/refresh-owned-prices` (guarded by `CRON_SECRET`). Add a system cron on the Droplet:
```bash
crontab -e
# add (runs 03:00 UTC daily; replace <CRON_SECRET> with the value from .env):
0 3 * * * curl -s -H "Authorization: Bearer <CRON_SECRET>" http://localhost/api/cron/refresh-owned-prices >/dev/null 2>&1
```

---

## 9. Google OAuth (fixes the sign-in hang)
In Google Cloud Console → your OAuth 2.0 Client → add:
- **Authorized redirect URI:** `http://<DROPLET_IP>/api/auth/callback/google`
- **Authorized JavaScript origin:** `http://<DROPLET_IP>`

(Phase 2: add the `https://yourdomain.com` equivalents.)
Note: some Google OAuth setups reject bare-IP/HTTP origins — if Google refuses to save an IP origin, Google login will only work once you add the domain in Phase 2. Email/password login works regardless.

---

## Updating the app later
```bash
cd /opt/dojo
git pull
docker compose up -d --build
```

---

## PHASE 2 — Add domain + HTTPS (when ready)
1. Point your domain's **A record** at `<DROPLET_IP>` (at your DNS registrar).
2. On the Droplet, edit `.env`:
   - `DOMAIN="yourdomain.com"`
   - `BETTER_AUTH_URL="https://yourdomain.com"`
3. Add the `https://yourdomain.com/...` redirect URI + origin in Google Cloud Console.
4. `docker compose up -d` — Caddy detects `DOMAIN`, provisions a Let's Encrypt cert automatically, and serves HTTPS on 443. Verify: `https://yourdomain.com/api/health`.

---

## Post-deploy checklist
- [ ] App loads at `http://<DROPLET_IP>`; `/api/health` is `ok`.
- [ ] Search returns results (Mumbai DB + trigram indexes working).
- [ ] Email/password signup + login work.
- [ ] Enable **Supabase automated backups** (Mumbai project → Database → Backups).
- [ ] Rotate the Mumbai DB password (it was shared in chat) + update `.env`, then `docker compose up -d`.
- [ ] (Later) Re-run the k6 load test + ZAP against the live Droplet for a prod-env security/perf baseline.
