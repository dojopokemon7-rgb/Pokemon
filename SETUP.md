# TCG Collection PWA — Developer Setup Guide

> **Phase 0 — Infrastructure Bootstrap**
> Complete this guide before running any code. It should take ~15 minutes.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 22+ | [nodejs.org](https://nodejs.org) |
| Docker Desktop | 4.x+ | [docker.com](https://www.docker.com/products/docker-desktop/) |
| Git | Any | [git-scm.com](https://git-scm.com) |

---

## Step 1 — Clone & Install

```bash
git clone <your-repo-url> tcg-collection
cd tcg-collection
npm install
```

---

## Step 2 — Create Your Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign in.
2. Click **New Project** and fill in:
   - **Name**: `tcg-collection-pwa` (or anything you like)
   - **Database Password**: Generate a strong password — **save it somewhere safe**.
   - **Region**: Pick one closest to your users.
   - **Plan**: Pro (as per architecture requirements).
3. Wait ~1 minute for the project to spin up.

### 2a. Find your DATABASE_URL (Pooled — Port 6543)

This is used at **runtime** for all queries.

1. In your Supabase dashboard, go to: **Project Settings → Database**.
2. Scroll down to **Connection string**.
3. Select the **Transaction** tab (this is the PgBouncer pooled connection).
4. Copy the URI — it looks like:
   ```
   postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
   ```
5. Append `?pgbouncer=true` to the end if not already present.

### 2b. Find your DIRECT_URL (Direct — Port 5432)

This is used **only for Prisma migrations** (bypasses PgBouncer).

1. On the same **Connection string** page, select the **Session** tab.
2. Copy the URI — it looks like:
   ```
   postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres
   ```

---

## Step 3 — Configure Environment Variables

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

Open `.env` and update every placeholder:

```dotenv
# From Step 2a (pooled, port 6543)
DATABASE_URL="postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?pgbouncer=true"

# From Step 2b (direct, port 5432)
DIRECT_URL="postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres"

# Redis — use localhost when running Next.js locally (without Docker)
REDIS_URL="redis://localhost:6379"

# A random 32-character secret — see Step 4 for how to generate one
BETTER_AUTH_SECRET="your-secret-here"

# Local dev URL
BETTER_AUTH_URL="http://localhost:3000"

# From Supabase Dashboard → Project Settings → API
NEXT_PUBLIC_SUPABASE_URL="https://[PROJECT-REF].supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="your-anon-key"

# Leave blank for local dev (OTPs will be logged to console)
SMS_PROVIDER_API_KEY=""
SMS_PROVIDER_BASE_URL=""
SMS_FROM_NUMBER=""
```

---

## Step 4 — Generate BETTER_AUTH_SECRET

Generate a cryptographically secure random secret using one of these methods:

**Option A — Node.js (recommended, works everywhere):**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Option B — OpenSSL (macOS/Linux):**
```bash
openssl rand -base64 32
```

**Option C — PowerShell (Windows):**
```powershell
[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

Copy the output and paste it as your `BETTER_AUTH_SECRET` in `.env`.

---

## Step 5 — Start Redis & Caddy (Docker)

Start only the Redis and Caddy services so you can run Next.js locally:

```bash
# Start Redis in the background
docker-compose up redis -d

# Verify Redis is running
docker exec tcg_redis redis-cli ping
# Expected output: PONG
```

> **Note:** Don't start the `app` service with Docker yet — you'll run Next.js
> directly with `npm run dev` for a faster development experience.

---

## Step 6 — Push Prisma Schema to Supabase

This creates all the database tables in your Supabase project.

```bash
npx prisma db push
```

Expected output:
```
Environment variables loaded from .env
Prisma schema loaded from prisma\schema.prisma
The database is now in sync with your Prisma schema. 🚀
Generated Prisma Client (v6.x.x) ...
```

> **Troubleshooting:** If you see a connection error, double-check your
> `DIRECT_URL` in `.env` — it must use port **5432** (not 6543).

### Optional: Open Prisma Studio

Visually browse and edit your database:

```bash
npx prisma studio
```

---

## Step 7 — Start the Next.js App

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — you should see the Phase 0 placeholder page.

### Verify the health check

```bash
curl http://localhost:3000/api/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2026-07-29T12:00:00.000Z",
  "services": {
    "app": "ok",
    "redis": "ok"
  }
}
```

If `redis` shows `"unreachable"`, make sure Docker is running and you ran `docker-compose up redis -d`.

---

## Step 8 — Verify Auth Endpoint

Better Auth should be live:

```bash
curl http://localhost:3000/api/auth/get-session
```

Expected: `{"session": null}` (no session yet — that's correct).

---

## Step 9 — Test OTP Flow (Dev Mode)

In local dev, OTPs are logged to the **Next.js terminal** instead of being sent via SMS.

```bash
curl -X POST http://localhost:3000/api/auth/phone-number/send-otp \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "+1234567890"}'
```

Check your terminal — you'll see:

```
[Better Auth — OTP DEV MODE]
  📱 Phone : +1234567890
  🔑 Code  : 123456
  ⚠️  Set SMS_PROVIDER_API_KEY in .env to send real SMS.
```

---

## Running with Full Docker Compose (Production-like)

When you're ready to test the full Docker stack:

```bash
# Build and start everything
docker-compose up --build -d

# Check all services are running
docker-compose ps

# View logs
docker-compose logs -f app
```

The app will be accessible at [http://localhost](http://localhost) (via Caddy on port 80).

---

## Week 4 — Switching to a Real SMS Provider

When you're ready to send real OTPs:

1. Open `src/lib/auth.ts`.
2. Find the `sendSmsOtp` function.
3. Replace the `TODO` block with your provider's SDK call (Twilio, MSG91, AWS SNS, etc.).
4. Add your provider credentials to `.env`:
   ```dotenv
   SMS_PROVIDER_API_KEY="your-api-key"
   SMS_PROVIDER_BASE_URL="https://api.your-provider.com"
   SMS_FROM_NUMBER="+1234567890"
   ```
5. Restart the app. **No other code changes are needed.**

---

## Project Structure Reference

```
d:/Pokemon/
├── Caddyfile                     # Caddy reverse proxy config
├── Dockerfile                    # Multi-stage production build
├── docker-compose.yml            # Redis + App + Caddy services
├── .env                          # Your local secrets (not in git)
├── .env.example                  # Template for new developers
├── prisma/
│   └── schema.prisma             # Database schema (Prisma)
├── src/
│   ├── app/
│   │   ├── layout.tsx            # Root layout
│   │   ├── page.tsx              # Phase 0 placeholder
│   │   ├── (auth)/               # Auth pages (Phase 1)
│   │   │   └── layout.tsx
│   │   ├── (dashboard)/          # Dashboard pages (Phase 1+)
│   │   │   └── layout.tsx
│   │   └── api/
│   │       ├── auth/[...all]/    # Better Auth catch-all handler
│   │       │   └── route.ts
│   │       └── health/           # Docker health check
│   │           └── route.ts
│   └── lib/
│       ├── db/
│       │   └── index.ts          # Prisma client singleton
│       ├── auth.ts               # Better Auth server config (SMS plug-and-play)
│       ├── auth-client.ts        # Better Auth client config
│       └── redis.ts              # ioredis client + health check
└── SETUP.md                      # This file
```

---

## Common Issues

| Issue | Fix |
|-------|-----|
| `Cannot connect to database` | Check `DIRECT_URL` uses port 5432, not 6543 |
| `Redis: ECONNREFUSED` | Run `docker-compose up redis -d` |
| `BETTER_AUTH_SECRET is not set` | Add it to `.env` (Step 4) |
| `Cannot find module '@prisma/client'` | Run `npx prisma generate` |
| Port 3000 already in use | `npx kill-port 3000` or use `npm run dev -- -p 3001` |
| Docker build fails | Ensure `npm install` ran and `node_modules` exists |

---

*Phase 0 complete. Proceed to Phase 1 for authentication UI.*
