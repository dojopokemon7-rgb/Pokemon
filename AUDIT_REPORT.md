# Dojo TCG Collection PWA — Comprehensive Audit Report

**Date:** 2025-09-25  
**Auditor:** Automated Code Review  
**Scope:** Full codebase (Next.js 15, React 19, TypeScript, Prisma, Better Auth, Redis, eBay API, Google Vision OCR)

---

## Executive Summary

The Dojo TCG Collection PWA is a well-architected Progressive Web App for tracking Pokémon and One Piece trading card collections. The codebase demonstrates **strong architectural discipline** with clear separation of concerns, proper validation at boundaries, graceful degradation patterns, and thoughtful caching strategies.

**Overall Risk Rating: MEDIUM** — Solid foundation with several operational and security hardening gaps that should be addressed before production scaling.

---

## ✅ Strengths (What Works Well)

### Architecture & Design
| Area | Observation |
|------|-------------|
| **Validation** | Zod schemas at every API boundary, external API payloads, Redis cached data — no trust assumptions |
| **Cache Strategy** | Redis is truly optional; every read/write wrapped in try/catch with fallback to live data |
| **Auth Model** | Better Auth with Prisma adapter; session cookie caching (5 min TTL); admin flag on session |
| **Data Ownership** | All user-scoped mutations use `where: { id, userId }` — prevents ID enumeration |
| **Audit Logging** | Every admin mutation logs to `AuditLog` with before/after values, IP, user agent |
| **Sync Engine** | Daily cron pulls from external APIs → local catalog; user searches hit only Supabase (instant, no API bans) |
| **Two ID System** | `Card.id` (internal cuid) vs `Card.externalId` (catalog ID) — documented and consistently used |
| **TanStack Query** | Well-defined query keys with precise invalidation strategies per mutation |
| **Error Handling** | Public routes return HTTP 200 with `{ fallback: true }` instead of 5xx; auth routes return real 4xx/5xx |
| **Type Safety** | TypeScript strict mode; discriminated unions for auth guards; branded types where needed |

### Code Quality
- **Pure domain logic** in `src/lib/utils/*.ts` — unit tested in isolation
- **Service layer** owns side effects; routes stay thin
- **Constants over magic numbers** — weights, TTLs, limits all centralized
- **Comprehensive comments** explaining WHY (eBay sold-listings reality, sync ordering, cookie/Edge constraints)
- **Fallback chains** for One Piece images (TCG Collector → Cardmarket → Bandai proxy)

### Testing
- Unit tests: Vitest + jsdom for pure utils (card-price, card-image, card-sort, etc.)
- Integration tests: Vitest with mocked Prisma/fetch (collections, pricing, bulk-add, etc.)
- E2E: Playwright against standalone production build (port 3001)
- Chart accuracy gate: Validates against mocked Collectr reference

---

## 🔴 Critical Issues (Fix Immediately)

### 1. CRON_SECRET Not Enforced in Production
**File:** `src/app/api/cron/sync-cards/route.ts:34-36`
```typescript
const expected = process.env.CRON_SECRET;
if (!expected) return true; // local dev / unconfigured — allow
```
**Risk:** If `CRON_SECRET` is unset in production, anyone can trigger the daily sync (10 sets/run, 250s budget), consuming API quotas and database resources.

**Fix:** Add startup validation that crashes if `CRON_SECRET` missing in production:
```typescript
if (process.env.NODE_ENV === 'production' && !process.env.CRON_SECRET) {
  throw new Error('CRON_SECRET required in production');
}
```

### 2. Search API Auth Enforcement Disabled
**File:** `src/app/api/cards/search/route.ts:44`
```typescript
const ENFORCE_AUTH = false;
```
**Risk:** Full card catalog publicly scrapeable. While intentional for browsing, enables competitive enumeration.

**Fix:** Either enable auth or implement rate limiting (see #12).

### 3. Admin Session Revocation Window (5 minutes)
**Files:** `src/lib/auth.ts:293-296`, `src/lib/utils/auth-guard.ts:132-136`
```typescript
cookieCache: { enabled: true, maxAge: 60 * 5 } // 5 minutes
```
**Risk:** Revoked admin retains API access for up to 5 minutes via cached session cookie.

**Fix:** Reduce `cookieCache.maxAge` or migrate to JWT-based sessions with shorter TTL.

---

## 🟠 High Priority (Fix This Sprint)

### 4. No CI/CD Pipeline
**Missing:** `.github/workflows/`
**Risk:** No automated lint, type-check, test, or build verification on PRs. Broken code merges to main.

**Required Workflows:**
- `ci.yml` — `lint` → `type-check` → `test:unit` → `test:integration` → `build`
- `e2e.yml` — Nightly Playwright run against preview deployment
- `security.yml` — `npm audit`, Dependabot, SCA scan
- `dependency-update.yml` — Weekly automated PR for minor/patch updates

### 5. No Rate Limiting on Public Endpoints
**Endpoints at Risk:**
| Endpoint | Abuse Vector |
|----------|--------------|
| `GET /api/cards/search` | Catalog enumeration (60 results × unlimited requests) |
| `GET /api/cards/trending` | Full catalog dump via pagination |
| `GET /api/ebay/search` | eBay API quota exhaustion (1 req = 1 eBay call) |
| `POST /api/cards/recognize` | Vision API cost abuse (large image uploads) |
| `GET /api/cron/sync-cards` | If CRON_SECRET unset — DoS via repeated sync triggers |

**Fix:** Implement token-bucket rate limiter (Upstash Redis or in-memory with sliding window):
```typescript
// Example: 30 req/min per IP for search, 10 req/min for recognize
```

### 6. Redis Unsecured in Docker Compose
**File:** `docker-compose.yml:13-26`
```yaml
redis:
  image: redis:7-alpine
  command: redis-server --appendonly yes --loglevel warning
  ports:
    - "6379:6379"
```
**Risk:** No password, no TLS, no ACL. Anyone with network access reads/writes all cache (eBay tokens, search results, OTP codes).

**Fix:**
```yaml
redis:
  command: redis-server --appendonly yes --requirepass ${REDIS_PASSWORD} --tls-port 6380 --port 0
  # Add TLS certs via volume, configure ioredis with tls: {}
```

### 7. Missing Security Headers
**File:** `Caddyfile:32-36`
```caddy
header {
    X-Content-Type-Options "nosniff"
    X-Frame-Options "SAMEORIGIN"
    Referrer-Policy "strict-origin-when-cross-origin"
}
```
**Missing Critical Headers:**
- `Content-Security-Policy` — Prevents XSS (required for PWA)
- `Permissions-Policy` — Restricts camera, geolocation, microphone
- `Strict-Transport-Security` — Enforces HTTPS (production only)
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

**Fix:** Add comprehensive CSP in `next.config.ts`:
```typescript
async headers() {
  return [{
    source: '/:path*',
    headers: [
      { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://*.supabase.co https://api.ebay.com https://vision.googleapis.com; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" },
      { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
      { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
    ]
  }]
}
```

### 8. No Structured Logging / Observability
**Current:** `console.log/warn/error` throughout codebase
**Missing:**
- Correlation IDs (request tracing)
- Log levels (debug/info/warn/error)
- Structured JSON output
- Integration with Sentry, Datadog, Axiom, or Vercel Logs
- Request/response logging middleware

**Fix:** Replace `console` with Pino logger:
```typescript
// src/lib/logger.ts
import pino from 'pino';
export const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
```

### 9. E2E Tests Require Live Production Database
**File:** `playwright.config.ts` (referenced in AGENTS.md)
**Risk:** Tests mutate production Supabase data; flaky; cannot run in CI without credentials.

**Fix:** Use test database or ephemeral Prisma `db push` in CI:
```yaml
# .github/workflows/e2e.yml
- name: Setup test DB
  run: |
    npx prisma migrate deploy --schema=prisma/schema.test.prisma
    DATABASE_URL="${TEST_DATABASE_URL}" npm run test:e2e
```

---

## 🟡 Medium Priority (Next Sprint)

### 10. Docker Security Hardening
**File:** `Dockerfile`
| Issue | Recommendation |
|-------|----------------|
| No distroless/scratch final stage | Use `gcr.io/distroless/nodejs22-debian12` |
| No multi-arch build | Add `--platform linux/amd64,linux/arm64` |
| Prisma client copied but no generate in runner | Add `prisma generate` to runner or use `prisma migrate deploy` |
| No healthcheck in Dockerfile | Add `HEALTHCHECK CMD wget -qO- http://localhost:3000/api/health` |
| Hardcoded `NODE_ENV=production` | Use build arg: `ARG NODE_ENV=production` |

### 11. Health Check Only Verifies Redis
**File:** `src/app/api/health/route.ts`
```typescript
const redisOk = await pingRedis();
// No DB check, no external API check
```
**Risk:** Docker healthcheck passes even if Supabase is down.

**Fix:** Add comprehensive health checks:
```typescript
const checks = await Promise.allSettled([
  prisma.$queryRaw`SELECT 1`, // DB
  pingRedis(), // Redis
  fetch('https://api.ebay.com/buy/browse/v1/item_summary/search?q=test&limit=1', { headers: { Authorization: `Bearer ${await getEbayAccessToken()}` } }).then(r => r.ok), // eBay
]);
```

### 12. No Dependency Scanning / SBOM
**Current:** Only `npm audit --audit-level=critical`
**Missing:**
- GitHub Dependabot alerts
- Snyk / OWASP Dependency Check in CI
- SBOM generation (Syft → CycloneDX)
- License compliance checking
- Automated PR for security updates

### 13. Database Migration Strategy Not in CI/CD
**Current:** `prisma migrate dev` locally only
**Missing:**
- `prisma migrate deploy` in production CI
- Migration rollback plan documented
- Migration timeout handling
- Pre-migration backup verification

### 14. No Backup / Disaster Recovery Documentation
**Supabase:** Managed Postgres backups (good)
**Redis:** AOF only, no RDB, no backup strategy
**Missing:** Documented RPO/RTO, restore testing procedure, cross-region replication plan.

---

## 🟢 Low Priority (Technical Debt)

### 15. ESLint Only Lints Test/Config Files
**File:** `eslint.config.mjs:24,34`
```javascript
files: ["tests/**/*.{ts,tsx}", "e2e/**/*.ts", "prisma/seed-test.ts", "*.config.{ts,mts,mjs}"],
ignores: ["src/**", ...]
```
**Impact:** ~777 pre-existing findings in `src/**` ignored. No lint baseline for application code.

**Fix:** Incrementally enable on `src/**` with `--fix` and legacy config.

### 16. Large Service Files
**File:** `src/lib/services/sync-cards.service.ts` — 653 lines
**Fix:** Split into:
- `sync-pokemon.service.ts`
- `sync-onepiece.service.ts`
- `sync-orchestrator.ts`
- `sync-utils.ts`

### 17. Inconsistent Styling Approach
- Dashboard/Auth: Inline styles + `.dojo-*` primitive classes
- Admin Panel: Tailwind utilities
**Fix:** Pick one approach or document the boundary clearly.

### 18. `any` Types Allowed
**File:** `eslint.config.mjs:27`
```javascript
"@typescript-eslint/no-explicit-any": "off"
```
**Fix:** Enable and fix incrementally; use `unknown` + type guards instead.

---

## 📊 Penetration Testing Assessment

### Attack Surface
| Endpoint | Auth | Risk Level | Primary Concern |
|----------|------|------------|-----------------|
| `GET /api/cards/search` | None | HIGH | Catalog scraping, enumeration |
| `GET /api/cards/trending` | None | HIGH | Full catalog dump |
| `POST /api/cards/recognize` | Required | MEDIUM | Vision API abuse, large uploads |
| `GET /api/ebay/search` | Required | MEDIUM | eBay rate limit exhaustion |
| `GET /api/cron/sync-cards` | Bearer token | HIGH | Unauthorized sync if secret missing |
| `PATCH /api/admin/cards/[id]` | Admin | LOW | Data manipulation (audit logged) |
| `POST /api/support` | Required | LOW | Spam (validated, rate limited) |
| `POST /api/want-list` | Required | LOW | Data pollution (ownership scoped) |

### Recommended Pen Test Scenarios
1. **Auth Bypass** — Test middleware (Edge) vs API guard (Node) discrepancy
2. **IDOR** — Test `UserCollection` ownership scoping with foreign IDs
3. **Rate Limit Bypass** — Distributed requests to `/api/cards/search`
4. **Secret Leakage** — Scan build artifacts, Docker images, Vercel logs
5. **XSS** — Test card name/set fields in search results (rendered in UI)
6. **SSRF** — Test `/api/one-piece-img/[cardId]` proxy with malicious URLs
7. **DoS** — Large image uploads to `/api/cards/recognize`
8. **Session Fixation** — Test Better Auth session handling

---

## 📋 Prioritized Remediation Plan

| Priority | Issue | Effort | Category |
|----------|-------|--------|----------|
| **P0** | Enforce CRON_SECRET in production startup | 30 min | Security |
| **P0** | Add CI/CD pipeline with verify gate | 4 hrs | DevOps |
| **P1** | Implement rate limiting on public APIs | 4 hrs | Security |
| **P1** | Add CSP and security headers | 2 hrs | Security |
| **P1** | Secure Redis with auth + TLS | 2 hrs | DevOps |
| **P2** | Add structured logging (Pino + Sentry) | 4 hrs | Observability |
| **P2** | Add dependency scanning (Dependabot + Snyk) | 2 hrs | DevOps |
| **P2** | Fix Dockerfile hardening (distroless, multi-arch) | 3 hrs | DevOps |
| **P2** | Fix E2E test isolation (ephemeral test DB) | 4 hrs | Testing |
| **P3** | Enable ESLint on `src/**` incrementally | 8 hrs | Code Quality |
| **P3** | Add DB migration strategy to CI | 2 hrs | DevOps |
| **P3** | Document backup/restore procedures | 2 hrs | Operations |
| **P3** | Split large service files | 4 hrs | Refactoring |

---

## 🔧 Quick Wins (Under 1 Hour Each)

1. **Add startup validation** for required env vars (`CRON_SECRET`, `BETTER_AUTH_SECRET`, `DATABASE_URL`)
2. **Enable `strict: true`** in `tsconfig.json` if not already
3. **Add `.nvmrc`** with Node version (22)
4. **Add `security.md`** with responsible disclosure policy
5. **Add `Dependabot.yml`** for automated dependency updates
6. **Add `CODEOWNERS`** for review routing
7. **Add `pre-commit` hooks** (husky + lint-staged) for local verification

---

## 📁 Files Referenced in This Report

```
src/
├── app/
│   ├── api/
│   │   ├── cards/search/route.ts          # Auth disabled, no rate limit
│   │   ├── cron/sync-cards/route.ts       # CRON_SECRET not enforced
│   │   ├── ebay/search/route.ts           # No rate limit
│   │   ├── cards/recognize/route.ts       # No rate limit, large uploads
│   │   └── health/route.ts                # Incomplete health checks
│   └── (dashboard)/layout.tsx             # Shell with header/bottom-nav
├── lib/
│   ├── auth.ts                            # Better Auth config, 5-min cookie cache
│   ├── redis.ts                           # Lazy client, optional Redis
│   ├── utils/
│   │   ├── auth-guard.ts                  # requireAuth, requireAdmin
│   │   └── audit-log.ts                   # Admin audit trail
│   └── services/
│       ├── sync-cards.service.ts          # 653 lines — split recommended
│       ├── ebay.service.ts                # eBay Browse API wrapper
│       └── vision-ocr.service.ts          # Google Vision OCR
├── middleware.ts                          # Edge cookie check only
├── prisma/schema.prisma                   # 13 models, well-indexed
├── next.config.ts                         # Standalone output, image domains
├── docker-compose.yml                     # Redis no auth/TLS
├── Dockerfile                             # Multi-stage, no distroless
├── Caddyfile                              # Missing CSP, HSTS
├── vercel.json                            # Cron only, no security config
├── eslint.config.mjs                      # Ignores src/**
├── package.json                           # Scripts, deps
└── playwright.config.ts                   # E2E config (referenced)
```

---

## 🎯 Conclusion

The Dojo PWA is **production-capable** with excellent architectural foundations. The primary gaps are **operational hardening** (CI/CD, rate limiting, observability, Redis security) rather than architectural flaws. Addressing the P0/P1 items will bring it to a **production-hardened** state suitable for scaling.

**Next Recommended Action:** Start with CI/CD pipeline and rate limiting — these provide the safety net for all subsequent changes.