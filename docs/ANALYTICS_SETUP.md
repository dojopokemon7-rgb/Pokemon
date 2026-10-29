# Analytics Setup — PostHog + Microsoft Clarity

Dojo ships two optional, client-side analytics trackers:

- **PostHog** — product analytics (pageviews, events, funnels).
- **Microsoft Clarity** — heatmaps and session recordings.

Both are **off by default**. They load only when (1) their key is configured
**and** (2) the visitor clicks **Accept** on the cookie-consent banner. With no
keys set, there is zero analytics code on the wire — no script, no network, no
cookies.

---

## 1. Get your keys

### PostHog

1. Sign in at your PostHog instance (PostHog Cloud US/EU or self-hosted).
2. **Project Settings → Project API Key** — copy the key (starts with `phc_`).
3. Note your ingestion host:
   - US cloud: `https://us.i.posthog.com`
   - EU cloud: `https://eu.i.posthog.com`
   - Self-hosted: your own URL.

### Microsoft Clarity

1. Sign in at <https://clarity.microsoft.com> and open (or create) your project.
2. **Settings → Overview** — copy the **project id** (the id that appears in the
   install snippet and in the project URL).

---

## 2. Environment variables

All three are `NEXT_PUBLIC_*` — **public client keys, not secrets**. Set them in
your prod `.env` (templates and comments live in `.env.example`):

| Variable | Required? | Example |
|---|---|---|
| `NEXT_PUBLIC_POSTHOG_KEY` | for PostHog | `phc_xxxxxxxx` |
| `NEXT_PUBLIC_POSTHOG_HOST` | for PostHog | `https://us.i.posthog.com` |
| `NEXT_PUBLIC_CLARITY_PROJECT_ID` | for Clarity | `abcd1234` |
| `NEXT_PUBLIC_POSTHOG_DASHBOARD_URL` | optional | exact PostHog project URL for the admin link card |

Each tracker is independent: set only the PostHog keys and only PostHog loads;
set only the Clarity id and only Clarity loads. Any unset/blank key makes that
tracker a **total no-op**.

---

## 3. Consent gating

A bottom banner (`src/components/CookieConsent.tsx`) asks every visitor to
Accept or Decline. The choice persists in `localStorage` under
`dojo-analytics-consent` (`granted` | `denied`).

- **Nothing** loads until the choice is `granted` — not on Decline, not before a
  choice is made.
- Flipping consent takes effect without a page reload (a `dojo-consent-changed`
  event re-runs the init check).

---

## 4. ⚠️ Build-time inlining (Docker / standalone)

**This is the step that silently breaks if skipped.** Next.js **inlines** every
`NEXT_PUBLIC_*` value into the client bundle at **`next build` time** — it does
**not** read them at runtime. For a standalone/Docker build, the keys must be
present **before the build runs**, or the trackers will never load even with the
keys sitting in the runtime `.env`.

This repo plumbs them through as build args:

- **`Dockerfile`** (builder stage) declares `ARG` + `ENV` for all four vars
  **before** `RUN npm run build`, so the values are inlined into the image.
- **`docker-compose.yml`** passes them under `app.build.args` (and
  `app-staging.build.args`), sourced from the root `.env` via `${VAR}`
  substitution at `--build` time.

### Operator sequence (prod)

```bash
# 1. Put the keys in the ROOT .env on the server (same dir as docker-compose.yml)
#    NEXT_PUBLIC_POSTHOG_KEY=phc_...
#    NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
#    NEXT_PUBLIC_CLARITY_PROJECT_ID=abcd1234

# 2. (optional) confirm compose resolves the build args
docker compose config

# 3. BUILD so the keys get inlined, then bring the stack up
docker compose up -d --build app
```

Changing any `NEXT_PUBLIC_*` value later requires a **rebuild** (`--build`) — a
plain `docker compose up` reuses the old image with the old inlined values.

---

## 5. Admin dashboard links

`/admin/analytics` has an **External Analytics** card
(`src/app/(admin)/admin/_components/ExternalAnalyticsLinks.tsx`) with links that
open the PostHog and Clarity dashboards in a new tab:

- PostHog → `NEXT_PUBLIC_POSTHOG_DASHBOARD_URL` if set, else
  `NEXT_PUBLIC_POSTHOG_HOST`.
- Clarity → `https://clarity.microsoft.com/projects/view/<id>/dashboard`.

When a provider's key is unset, the card shows a muted
"Configure analytics keys to enable" state instead of a broken link. The
first-party `/admin/analytics` panel (scan usage, portfolio totals, etc.) is
unchanged — these are an additional card.
