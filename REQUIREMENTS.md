# TCG Collection PWA — Requirements & Dependency Document

> Use this document when moving the project to a new machine or onboarding a new developer.
> Follow every step in order. Estimated time: **20–30 minutes**.

---

## 1. System Prerequisites

Install these tools **before** cloning the project.

| Tool | Min Version | Download | Notes |
|------|-------------|----------|-------|
| **Node.js** | 22.x LTS | https://nodejs.org | Use LTS, not Current |
| **npm** | 10.x | Bundled with Node.js | Verify: `npm -v` |
| **Docker Desktop** | 4.x+ | https://www.docker.com/products/docker-desktop/ | Needed for Redis & Caddy |
| **Git** | Any | https://git-scm.com | For cloning the repo |

### Verify Installations

```bash
node -v          # should print v22.x.x
npm -v           # should print 10.x.x
docker -v        # should print Docker version 4.x.x
git --version    # any version is fine
```

---

## 2. External Services Required

You need accounts and projects set up on these services:

| Service | Purpose | Free Tier? | URL |
|---------|---------|------------|-----|
| **Supabase** | PostgreSQL database | ✅ Yes (Pro plan recommended) | https://supabase.com |
| **Redis** | Session cache, OTP store, rate-limiting | ✅ Via Docker (local) | Managed by docker-compose |

### 2a. Supabase Setup

1. Sign in at [supabase.com](https://supabase.com) → **New Project**
2. Fill in:
   - **Name**: `tcg-collection-pwa`
   - **Database Password**: Generate a strong one — **save it**
   - **Region**: Closest to your users
3. Wait ~1 minute for the project to provision.
4. Go to **Project Settings → Database → Connection string**

**Pooled URL** (port 6543, for runtime queries):
```
postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?pgbouncer=true
```

**Direct URL** (port 5432, for migrations only):
```
postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

---

## 3. NPM Dependencies

All dependencies are declared in `package.json`. Run `npm install` to install them all.

### Runtime Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `next` | ^15.3.5 | React framework (App Router) |
| `react` | ^19.0.0 | UI library |
| `react-dom` | ^19.0.0 | React DOM renderer |
| `better-auth` | ^1.6.25 | Authentication (email, phone OTP, sessions) |
| `@prisma/client` | ^6.19.3 | PostgreSQL ORM client |
| `ioredis` | ^5.11.1 | Redis client for session/OTP cache |
| `@tanstack/react-query` | ^5.101.4 | Server state management |
| `zod` | ^3.25.67 | Runtime schema validation |
| `@radix-ui/react-slot` | ^1.2.3 | Accessible UI primitives |
| `lucide-react` | ^0.523.0 | Icon library |
| `clsx` | ^2.1.1 | Conditional class names |
| `class-variance-authority` | ^0.7.1 | Variant-based component styling |
| `tailwind-merge` | ^3.3.1 | Tailwind class deduplication |

### Dev Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `prisma` | ^6.19.3 | Prisma CLI (migrations, studio) |
| `typescript` | ^5.8.3 | Type-safe JavaScript |
| `@types/node` | ^22.0.0 | Node.js type definitions |
| `@types/react` | ^19.0.0 | React type definitions |
| `@types/react-dom` | ^19.0.0 | React DOM type definitions |
| `tailwindcss` | ^4.1.11 | Utility-first CSS framework |
| `@tailwindcss/postcss` | ^4.1.11 | Tailwind PostCSS plugin |
| `postcss` | ^8.5.6 | CSS transformation toolchain |

---

## 4. Environment Variables

Copy the template and fill in your values:

```bash
# Windows (PowerShell)
Copy-Item .env.example .env

# macOS / Linux
cp .env.example .env
```

Open `.env` and set every variable:

```dotenv
# -------------------------------------------------------
# DATABASE — Supabase PostgreSQL
# -------------------------------------------------------
# Pooled (PgBouncer, port 6543) — used by Prisma at runtime
DATABASE_URL="postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?pgbouncer=true"

# Direct (port 5432) — used ONLY for Prisma migrations
DIRECT_URL="postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres"

# -------------------------------------------------------
# REDIS
# -------------------------------------------------------
# Local dev (Next.js runs outside Docker): use localhost
REDIS_URL="redis://localhost:6379"
# Full Docker Compose: use the service name
# REDIS_URL="redis://redis:6379"

# -------------------------------------------------------
# BETTER AUTH — see Section 5 for secret generation
# -------------------------------------------------------
BETTER_AUTH_SECRET="REPLACE_WITH_GENERATED_SECRET"
BETTER_AUTH_URL="http://localhost:3000"

# -------------------------------------------------------
# SUPABASE (client-side storage / file uploads)
# Found in: Supabase Dashboard → Project Settings → API
# -------------------------------------------------------
NEXT_PUBLIC_SUPABASE_URL="https://[PROJECT-REF].supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="YOUR_SUPABASE_ANON_KEY"

# -------------------------------------------------------
# SMS PROVIDER (optional — leave blank for local dev)
# OTPs will be printed to the terminal console instead.
# -------------------------------------------------------
SMS_PROVIDER_API_KEY=""
SMS_PROVIDER_BASE_URL=""
SMS_FROM_NUMBER=""
```

---

## 5. Better Auth — Secret Generation

`BETTER_AUTH_SECRET` must be a **cryptographically random 32-byte string**.
Generate it once and never share it.

**Option A — Node.js (works on all platforms):**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Option B — OpenSSL (macOS / Linux):**
```bash
openssl rand -base64 32
```

**Option C — PowerShell (Windows):**
```powershell
[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

Copy the output into `.env` as `BETTER_AUTH_SECRET`.

### Better Auth Config Files

| File | Purpose |
|------|---------|
| `src/lib/auth.ts` | Server-side config (plugins, OTP, SMS hook) |
| `src/lib/auth-client.ts` | Client-side config |
| `src/app/api/auth/[...all]/route.ts` | Catch-all API route handler |

### Better Auth Plugins in Use

| Plugin | Purpose |
|--------|---------|
| `phoneNumber` | Mobile OTP login via SMS |
| Prisma Adapter | Syncs auth models to PostgreSQL via Prisma |

---

## 6. Docker Services

The project uses Docker Compose to manage Redis and Caddy (reverse proxy).
PostgreSQL lives on Supabase (remote) — it is **not** managed by Docker.

### Services

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| `redis` | `redis:7-alpine` | `6379` | Session cache, OTP store, rate-limiting |
| `app` | `./Dockerfile` | `3000` | Next.js application |
| `caddy` | `caddy:2-alpine` | `80`, `443` | HTTPS reverse proxy |

### Dev Mode — Start Redis Only

```bash
# Start Redis in the background
docker-compose up redis -d

# Verify Redis is healthy
docker exec tcg_redis redis-cli ping
# Expected: PONG
```

### Production Mode — Full Stack

```bash
# Build and start all services
docker-compose up --build -d

# Check status
docker-compose ps

# View app logs
docker-compose logs -f app
```

---

## 7. Prisma Database Setup

After `.env` is configured and Redis is running:

```bash
# Step 1: Generate the Prisma client
npx prisma generate

# Step 2: Push schema to Supabase (creates all tables)
npx prisma db push

# Optional: Open the visual DB browser
npx prisma studio
```

### Database Models

| Model | Description |
|-------|-------------|
| `User` | Auth user (Better Auth required) |
| `Session` | Auth sessions (Better Auth required) |
| `Account` | OAuth accounts (Better Auth required) |
| `Verification` | OTP / email verification tokens |
| `CardSet` | TCG set/expansion (e.g., Scarlet & Violet) |
| `Card` | Individual TCG card |
| `UserCollection` | Cards owned by a user |
| `PricingHistory` | Historical market price data |

---

## 8. NPM Scripts Reference

```bash
npm run dev          # Start Next.js dev server (http://localhost:3000)
npm run build        # Build production bundle
npm run start        # Start production server (after build)
npm run lint         # Run ESLint
npm run type-check   # Run TypeScript compiler (no emit)

npm run db:generate  # npx prisma generate (regenerate client)
npm run db:push      # npx prisma db push (sync schema to DB)
npm run db:migrate   # npx prisma migrate dev (create migration files)
npm run db:studio    # npx prisma studio (open visual DB browser)
```

---

## 9. Quick-Start Checklist (New Machine)

Run these commands in order after meeting all prerequisites:

```bash
# 1. Clone the repository
git clone <your-repo-url> tcg-collection
cd tcg-collection

# 2. Install all npm dependencies
npm install

# 3. Copy environment template
cp .env.example .env        # macOS/Linux
# Copy-Item .env.example .env  # Windows PowerShell

# 4. Generate BETTER_AUTH_SECRET and paste into .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 5. Fill in DATABASE_URL, DIRECT_URL, and Supabase keys in .env

# 6. Start Redis via Docker
docker-compose up redis -d

# 7. Verify Redis is running
docker exec tcg_redis redis-cli ping
# Expected output: PONG

# 8. Push Prisma schema to Supabase (creates all tables)
npx prisma db push

# 9. Start the development server
npm run dev

# 10. Verify the app is running
curl http://localhost:3000/api/health
# Expected: { "status": "ok", "services": { "app": "ok", "redis": "ok" } }

# 11. Verify Better Auth is live
curl http://localhost:3000/api/auth/get-session
# Expected: { "session": null }

# 12. Test OTP flow (check terminal for the code)
curl -X POST http://localhost:3000/api/auth/phone-number/send-otp \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "+1234567890"}'
```

---

## 10. Common Issues & Fixes

| Issue | Cause | Fix |
|-------|-------|-----|
| `Cannot connect to database` | Wrong port in `DIRECT_URL` | Use port **5432** (not 6543) in `DIRECT_URL` |
| `Redis: ECONNREFUSED` | Docker not running / Redis not started | Run `docker-compose up redis -d` |
| `BETTER_AUTH_SECRET is not set` | Missing env var | Add it to `.env` (see Section 5) |
| `Cannot find module '@prisma/client'` | Client not generated | Run `npx prisma generate` |
| Port 3000 already in use | Another process is on port 3000 | Run `npx kill-port 3000` or `npm run dev -- -p 3001` |
| Docker build fails | Missing `node_modules` | Run `npm install` first |
| `pgbouncer=true` errors | Missing query param | Append `?pgbouncer=true` to `DATABASE_URL` |
| OTPs not being sent | SMS env vars not set | Leave blank for dev — OTPs print to terminal |

---

## 11. Project Structure

```
d:/Pokemon/
├── .env                          # Your local secrets (never commit)
├── .env.example                  # Template — commit this
├── Caddyfile                     # Caddy HTTPS reverse proxy config
├── Dockerfile                    # Multi-stage production build
├── docker-compose.yml            # Redis + App + Caddy services
├── package.json                  # NPM dependencies & scripts
├── tsconfig.json                 # TypeScript config
├── next.config.ts                # Next.js config
├── prisma/
│   └── schema.prisma             # Database schema (all models)
└── src/
    ├── app/
    │   ├── layout.tsx            # Root layout
    │   ├── page.tsx              # Home page
    │   ├── (auth)/               # Auth pages
    │   ├── (dashboard)/          # Dashboard pages
    │   └── api/
    │       ├── auth/[...all]/    # Better Auth API route
    │       └── health/           # Health check endpoint
    └── lib/
        ├── auth.ts               # Better Auth server config
        ├── auth-client.ts        # Better Auth client config
        ├── db/index.ts           # Prisma client singleton
        └── redis.ts              # ioredis client
```

---

*Last updated: 2026-08-18 | TCG Collection PWA v0.1.0*
