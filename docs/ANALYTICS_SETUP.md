# Analytics Setup — PostHog (EU)

Dojo ships one optional, client-side analytics tracker: **PostHog** (product
analytics, funnels, session replay, error tracking). The event list lives in
`docs/ANALYTICS_EVENTS.md`.

It is **off by default**. It loads only when (1) the project key is configured
**and** (2) the visitor clicks **Accept** on the cookie-consent banner. With no
key set there is zero analytics code on the wire — no network, no cookies.

---

## 1. Get your key

Dojo's PostHog project is on the **EU cloud**.

1. Sign in at <https://eu.posthog.com> and open the project
   (<https://eu.posthog.com/project/333915>).
2. **Project Settings → Project API Key** — copy the project token (`phc_...`).
3. Ingestion host: `https://eu.i.posthog.com`.

**Dev vs prod projects.** Use a separate PostHog project for testing so tester
traffic never pollutes real metrics. Production uses the prod project key in the
root `.env`. If you want analytics on staging, put a *different* project's key
in the staging build env (`.env.staging` / the compose build arg) — otherwise
leave it unset and staging stays a no-op.

---

## 2. Environment variables

All are `NEXT_PUBLIC_*` — **public client keys, not secrets**. Templates and
comments live in `.env.example`:

| Variable | Required? | Example |
|---|---|---|
| `NEXT_PUBLIC_POSTHOG_KEY` | yes (else no-op) | `phc_xxxxxxxx` |
| `NEXT_PUBLIC_POSTHOG_HOST` | yes | `https://eu.i.posthog.com` |
| `NEXT_PUBLIC_POSTHOG_DASHBOARD_URL` | optional | `https://eu.posthog.com/project/333915` |

An unset/blank key makes PostHog a **total no-op**.

---

## 3. Consent gating

A bottom banner (`src/components/CookieConsent.tsx`) asks every visitor to
Accept or Decline. The choice persists in `localStorage` under
`dojo-analytics-consent` (`granted` | `denied`).

- **Nothing** loads until the choice is `granted` — not on Decline, not before a
  choice is made. `posthog.identify` and every `track()` call are gated the same
  way (they are no-ops until PostHog is initialized).
- Flipping consent takes effect without a page reload (a `dojo-consent-changed`
  event re-runs the init check).

---

## 4. ⚠️ Build-time inlining (Docker / standalone)

**This is the step that silently breaks if skipped.** Next.js **inlines** every
`NEXT_PUBLIC_*` value into the client bundle at **`next build` time** — it does
**not** read them at runtime. Set them in `.env` **before**
`docker compose up --build`, or PostHog will never load even with the key sitting
in the runtime `.env`.

- **`Dockerfile`** (builder stage) declares `ARG` + `ENV` for the vars
  **before** `RUN npm run build`.
- **`docker-compose.yml`** passes them under `app.build.args` (and
  `app-staging.build.args`), sourced from the root `.env` via `${VAR}`
  substitution at `--build` time.

The same build-time values also drive the Content-Security-Policy in
`next.config.ts` (see §5).

### Operator sequence (prod)

```bash
# 1. Put the vars in the ROOT .env on the server (same dir as docker-compose.yml)
#    NEXT_PUBLIC_POSTHOG_KEY=phc_...
#    NEXT_PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com
#    NEXT_PUBLIC_POSTHOG_DASHBOARD_URL=https://eu.posthog.com/project/333915

# 2. (optional) confirm compose resolves the build args
docker compose config

# 3. BUILD so the values get inlined, then bring the stack up
docker compose up -d --build app
```

Changing any `NEXT_PUBLIC_*` value later requires a **rebuild** (`--build`).

---

## 5. Content-Security-Policy

`next.config.ts` ships an enforcing CSP. PostHog is allowlisted minimally,
derived from `NEXT_PUBLIC_POSTHOG_HOST` (EU: `eu.i.posthog.com` for ingestion and
`eu-assets.i.posthog.com` for lazy-loaded scripts such as the session-replay
recorder): `connect-src` gets both origins, `script-src` gets the assets origin.
`worker-src blob:` was already present. Once a first-party `/ph` reverse proxy
ships, these can shrink to `'self'`.

---

## 6. Admin dashboard link

`/admin/analytics` has an **External Analytics** card
(`src/app/(admin)/admin/_components/ExternalAnalyticsLinks.tsx`) linking to
PostHog in a new tab: `NEXT_PUBLIC_POSTHOG_DASHBOARD_URL` if set, else
`NEXT_PUBLIC_POSTHOG_HOST`. When neither is set it shows a muted
"Configure analytics keys to enable" state instead of a broken link.
