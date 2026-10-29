# Implementation Plan — PostHog + Microsoft Clarity analytics (consent-gated, env-gated)

All work happens in the worktree `d:\Pokemon\Pokemon\.worktrees\add-analytics`. All paths below are relative to that root unless written absolute. Do NOT push/deploy/merge-to-origin. Do NOT touch `prisma/schema.prisma` or `src/lib/auth.ts`.

## Design decisions (made here, grounded in the code I read)

- **Server/client boundary (RULE 6).** `src/app/layout.tsx` stays a server component (it exports `metadata`/`viewport`, which client components cannot). All analytics code is client-only and mounts INSIDE the existing `"use client"` `src/app/providers.tsx` boundary — the same place TanStack's `QueryClientProvider` already lives. `providers.tsx` already runs only in the browser, so wiring `<AnalyticsProvider>` + `<CookieConsent>` as children of `QueryClientProvider` there keeps `layout.tsx` a server component untouched except for... nothing (we don't touch layout at all — Providers already wraps `{children}`). The three keys are `NEXT_PUBLIC_*`, public by design (RULE 6: these are client keys, not secrets — PostHog project key `phc_...` and Clarity project id are meant to ship to the browser; no server secret is involved).
- **Page-export guard.** `src/app/(admin)/admin/analytics/page.tsx` must keep ONLY its `default` export (a named export passes `tsc` but fails `next build`'s Page-type phase). The new "External Analytics" card is a SEPARATE component file under `_components/` (matching the existing `AnalyticsDetail.tsx` there) and is imported into the page — no new named export is added to `page.tsx`.
- **Decision helper is pure and SSR-safe.** The init decision (`consent === "granted"` AND key present/non-empty) is extracted to a pure function in `src/lib/utils/analytics-consent.ts` with no DOM/`window`/`localStorage` access, so it is trivially unit-testable (RULE 11: pure domain logic in `src/lib/utils`, unit-tested in isolation). The components read `localStorage` and env, then call the pure helper.
- **posthog-js dynamic import.** `posthog-js` is imported dynamically (`await import("posthog-js")`) inside a `useEffect` guarded by `typeof window !== "undefined"`, so it never executes on the server and never enters the SSR/build bundle path that could break the build. Clarity needs no package — it is the standard window snippet injected only after consent.
- **PostHog App Router pageviews.** Disable PostHog's automatic pageview capture (`capture_pageview: false`) and capture `$pageview` manually from a `usePathname()` + `useSearchParams()` effect — the documented Next.js App Router pattern (the automatic capture misses client-side route changes). The `useSearchParams()` hook forces the component (or a small child) to be wrapped so it does not opt the whole tree into CSR bailout at build; keep the searchParams-reading piece in its own tiny component rendered by `AnalyticsProvider`. Because `AnalyticsProvider` lives under the `"use client"` Providers and is not a route segment, this is fine, but the pageview child still needs a `<Suspense>` boundary around it to satisfy `useSearchParams()` CSR-bailout rules in `next build`.
- **posthog-js version pin:** pin EXACTLY `posthog-js@1.258.5` (well-known maintained 1.x release, Apache-2.0/MIT, supports the `capture_pageview:false` + manual `$pageview` App Router pattern). Add under `dependencies` with no `^`/`~`.
- **Dockerfile / docker-compose build-arg decision.** `NEXT_PUBLIC_*` are INLINED at `next build`. The current `Dockerfile` builder stage runs `npm run build` with NO analytics env present, so without changes the trackers would silently never load even with keys in the runtime `.env`. **Decision: plumb all three (plus the optional dashboard URL) as build `ARG`→`ENV` in the Dockerfile builder stage, and pass them as `build.args` in `docker-compose.yml` sourced from the root `.env` via `${VAR}` substitution.** This bakes the keys at build time so `docker compose up --build` works. Documented in `docs/ANALYTICS_SETUP.md` with the exact operator sequence.

---

- [ ] 1. Add the pure consent/env decision helper.
      Create `src/lib/utils/analytics-consent.ts` exporting:
      `export const CONSENT_STORAGE_KEY = "dojo-analytics-consent";`
      `export type ConsentValue = "granted" | "denied";`
      `export function shouldInit(consent: ConsentValue | null | undefined, key: string | null | undefined): boolean` — returns `true` ONLY when `consent === "granted"` AND `typeof key === "string"` AND `key.trim() !== ""`; `false` otherwise.
      `export function parseConsent(raw: string | null | undefined): ConsentValue | null` — returns `"granted"`/`"denied"` for exactly those strings, else `null` (for SSR / corrupt / unset values).
      No `window`/`localStorage`/DOM access in this file (RULE 11). Add a load-bearing comment explaining WHY it is pure (testability + SSR-safety).
      Files: `src/lib/utils/analytics-consent.ts`
      Verify: `npm run type-check` passes (file compiles under strict TS).

- [ ] 2. Unit-test the decision helper.
      Create `tests/unit/analytics-consent.test.ts` (Vitest globals — no imports of describe/it/expect needed; jsdom env per `vitest.config.ts`). Cover: `shouldInit("granted","phc_abc") === true`; `shouldInit("granted","") === false`; `shouldInit("granted","   ") === false`; `shouldInit("granted", undefined) === false`; `shouldInit("denied","phc_abc") === false`; `shouldInit(null,"phc_abc") === false`; and `parseConsent` for `"granted"`, `"denied"`, `null`, `""`, `"garbage"`. No network, no real `window` needed (helper is pure).
      Files: `tests/unit/analytics-consent.test.ts`
      Verify: `npm run test:unit` — the new `analytics-consent` tests pass (run the whole scope; note the known `add-invalidates-chart.test.tsx` flake passes alone).

- [ ] 3. Pin posthog-js as a dependency (exact version).
      Add `"posthog-js": "1.258.5"` to `dependencies` in `package.json` (EXACT, no caret). Run `npm install` so `package-lock.json` is updated (the Dockerfile uses `npm ci`, which requires the lockfile to match).
      Files: `package.json`, `package-lock.json`
      Verify: `npm install` completes; `npm ls posthog-js` shows `posthog-js@1.258.5`.

- [ ] 4. Build the cookie-consent banner component.
      Create `src/components/CookieConsent.tsx` (`"use client"`). Renders a bottom banner (`position: fixed; bottom:0; left:0; right:0; z-index` above content) ONLY while no choice is stored. Uses inline styles + `.dojo-*` classes and `--color-dojo-*` tokens, square corners (RULE 10): background `var(--color-dojo-card)`, top border `1px solid var(--color-dojo-stroke)`, `.dojo-body` copy, two real `<button>`s — "Accept" (`.dojo-btn .dojo-btn-primary` or `.dojo-btn-outline-sm`) and "Decline" (`.dojo-btn-outline-sm`). On mount read `localStorage[CONSENT_STORAGE_KEY]` via `parseConsent`; show banner only when `null`. Accept → write `"granted"`; Decline → write `"denied"`; both hide the banner and notify via a custom event (`window.dispatchEvent(new Event("dojo-consent-changed"))`) so `AnalyticsProvider` can react without a page reload. Accessibility: `role="dialog"` + `aria-label`, keyboard-focusable real buttons, dismissible. Guard all `localStorage`/`window` access behind `typeof window !== "undefined"` and do the read in `useEffect` (never during render) to avoid hydration mismatch. Minimal re-show: export a tiny helper `resetConsent()` (removes the key + dispatches the event) — do not build a settings UI (don't over-engineer).
      Files: `src/components/CookieConsent.tsx`
      Verify: `npm run type-check` + `npm run lint` pass.

- [ ] 5. Build the analytics provider / init component.
      Create `src/components/AnalyticsProvider.tsx` (`"use client"`). On mount AND on the `"dojo-consent-changed"` event, read consent from `localStorage` (`parseConsent`) and the env keys (`process.env.NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`, `NEXT_PUBLIC_CLARITY_PROJECT_ID`). For EACH tracker independently call `shouldInit(consent, key)`:
      - PostHog: if true and not already initialized, `const posthog = (await import("posthog-js")).default; posthog.init(key, { api_host: host, capture_pageview: false, ... });` (dynamic import, guarded by `typeof window !== "undefined"`). Track an init-once ref so re-renders/events don't double-init.
      - Clarity: if true and not already injected, inject the standard Clarity bootstrap snippet using `NEXT_PUBLIC_CLARITY_PROJECT_ID` (create/append the script via DOM; guard double-inject with a ref or a check for the existing script/`window.clarity`).
      Pageviews: render a small child component (wrapped in `<Suspense>`) that uses `usePathname()` + `useSearchParams()` and, in an effect on path/search change, calls `posthog.capture("$pageview")` ONLY when PostHog is initialized. Keep the `useSearchParams()` reader isolated inside the `<Suspense>` boundary so `next build` does not fail the CSR-bailout check. Everything is a no-op when keys are unset or consent is not `"granted"` — no script injected, no network, no `posthog.init`.
      Files: `src/components/AnalyticsProvider.tsx`
      Verify: `npm run type-check` + `npm run lint` pass.

- [ ] 6. Wire the provider + banner into the existing client Providers (layout stays server).
      Edit `src/app/providers.tsx` (already `"use client"`): render `<AnalyticsProvider />` and `<CookieConsent />` inside `<QueryClientProvider>` alongside `{children}` (e.g. `<QueryClientProvider>{children}<AnalyticsProvider/><CookieConsent/></QueryClientProvider>`). Do NOT edit `src/app/layout.tsx` (keep it a server component). Add a short comment noting the analytics code is client-only and lives here to preserve the server/client boundary (RULE 6, RULE 14 — keep load-bearing comments).
      Files: `src/app/providers.tsx`
      Verify: `npm run build` passes the Next Page-type + CSR-bailout phases (this is the MANDATORY gate for this change). If `auth.ts` type errors surface, run `npx prisma generate` first then re-run.

- [ ] 7. Add the admin "External Analytics" dashboard-links card.
      Create `src/app/(admin)/admin/_components/ExternalAnalyticsLinks.tsx` (`"use client"` OR a plain server-safe component — it only reads `NEXT_PUBLIC_*` env, which is fine in a server component; prefer NO `"use client"` so it renders in the server page). It computes:
      - PostHog URL = `NEXT_PUBLIC_POSTHOG_DASHBOARD_URL` if set, else `NEXT_PUBLIC_POSTHOG_HOST` base, else none.
      - Clarity URL = `https://clarity.microsoft.com/projects/view/<NEXT_PUBLIC_CLARITY_PROJECT_ID>/dashboard` when the id is set, else the Clarity projects root `https://clarity.microsoft.com/projects`.
      Render an "External Analytics" section/card matching `AnalyticsDetail.tsx` conventions (`CARD_STYLE` tokens, `SectionHeading`, Tailwind utilities are allowed in the admin panel per §10). Each present link is an `<a target="_blank" rel="noopener noreferrer">`. When a provider's key is unset, render a muted "Configure analytics keys to enable" state (`.dojo-faint`) instead of a broken link. Keep the first-party `<AnalyticsDetail/>` panel UNCHANGED.
      Then edit `src/app/(admin)/admin/analytics/page.tsx` to import and render `<ExternalAnalyticsLinks />` as an ADDITIONAL card below `<AnalyticsDetail .../>`. Add NO new named export to `page.tsx` (default export only — Page-export guard).
      Files: `src/app/(admin)/admin/_components/ExternalAnalyticsLinks.tsx`, `src/app/(admin)/admin/analytics/page.tsx`
      Verify: `npm run type-check` + `npm run build` pass (page.tsx keeps default-only export; build's Page-type phase is the real check).

- [ ] 8. Document env vars in `.env.example` (no real values).
      Add a new "ANALYTICS (PostHog + Microsoft Clarity)" block to `.env.example` with the four vars and clear comments: `NEXT_PUBLIC_POSTHOG_KEY` (PostHog project API key `phc_...`, get from PostHog → Project Settings; public client key), `NEXT_PUBLIC_POSTHOG_HOST` (e.g. `https://us.i.posthog.com` or `https://eu.i.posthog.com`), `NEXT_PUBLIC_CLARITY_PROJECT_ID` (Clarity → Settings → project id), and optional `NEXT_PUBLIC_POSTHOG_DASHBOARD_URL`. State clearly: these are PUBLIC client keys (not secrets); trackers are a TOTAL no-op when unset; loading is additionally gated behind cookie consent; and they must be present at BUILD time (inlined) for a standalone/Docker build. Leave all values blank/placeholder. Do NOT put real values anywhere.
      Files: `.env.example`
      Verify: open the file and confirm the block exists with blank values; `npm run lint` is unaffected (not a code file).

- [ ] 9. Plumb the NEXT_PUBLIC_* vars as build args (Dockerfile + docker-compose).
      Edit `Dockerfile` builder stage (STAGE 2): add `ARG NEXT_PUBLIC_POSTHOG_KEY`, `ARG NEXT_PUBLIC_POSTHOG_HOST`, `ARG NEXT_PUBLIC_CLARITY_PROJECT_ID`, `ARG NEXT_PUBLIC_POSTHOG_DASHBOARD_URL` and the matching `ENV NEXT_PUBLIC_...=$NEXT_PUBLIC_...` lines BEFORE `RUN npm run build`, so the values are inlined at build. Add a load-bearing comment explaining WHY (Next inlines `NEXT_PUBLIC_*` at build; runtime `.env` alone is too late). Edit `docker-compose.yml`: under the `app` service `build:` block, add `args:` mapping each of the four to `${NEXT_PUBLIC_POSTHOG_KEY}` etc. so compose sources them from the root `.env` at `--build` time. Mirror the same `build.args` on `app-staging` for parity (staging reads from the same root `.env` interpolation — keep behavior consistent).
      Files: `Dockerfile`, `docker-compose.yml`
      Verify: `docker compose config` resolves without error (if Docker is unavailable in the sandbox, instead confirm by reading the files that the four ARG/ENV lines precede `npm run build` and that `build.args` reference the four `${...}` vars — note in findings that a live `docker compose build` must be run by the operator).

- [ ] 10. Write the analytics setup doc.
      Create `docs/ANALYTICS_SETUP.md`: how to get the PostHog project key + host (PostHog → Project Settings) and the Clarity project id (clarity.microsoft.com → Settings); which env vars to set in prod `.env`; that cookie consent gates loading (nothing loads until the user clicks Accept); that it is a no-op until keys are set; AND the BUILD-TIME inlining caveat — the three `NEXT_PUBLIC_*` must be present BEFORE `docker compose up --build` (document the exact operator sequence: put values in root `.env` → `docker compose build` / `docker compose up --build`), explaining the Dockerfile `ARG`/`ENV` + docker-compose `build.args` plumbing added in step 9. Note the admin dashboard-link card and the optional `NEXT_PUBLIC_POSTHOG_DASHBOARD_URL`. (AGENTS.md: update docs in the same change when routes/pages change.)
      Files: `docs/ANALYTICS_SETUP.md`
      Verify: open and confirm it covers keys, consent gating, no-op-when-unset, and the build-time/Docker caveat with the operator sequence.

- [ ] 11. Full verification gate.
      Run the required commands in order and confirm each passes: `npm run type-check`; `npm run lint`; `npm run test:unit`; `npm run test:integration`; and the MANDATORY `npm run build`. If `auth.ts` type errors appear, run `npx prisma generate` first (H-2 is merged, so type-check should be clean). The `add-invalidates-chart.test.tsx` flake passes when run alone — re-run that file alone if it flakes in the full unit scope. Do NOT run `test:e2e` (needs a reachable DATABASE_URL / standalone build) unless the environment supports it.
      Files: none (verification only)
      Verify: `npm run type-check && npm run lint && npm run test:unit && npm run test:integration && npm run build` all succeed.

## Notes / assumptions

- `useSearchParams()` in `AnalyticsProvider`'s pageview child REQUIRES a `<Suspense>` wrapper or `next build` fails with a CSR-bailout error — step 5 handles this; if the build still complains, confirm the searchParams reader is inside `<Suspense>` and is the only consumer.
- The Clarity snippet is the standard `window.clarity` bootstrap keyed by the project id — no npm package (task constraint).
- If `npm install` cannot reach the registry in the sandbox, the implementer must still add the exact `posthog-js@1.258.5` pin to `package.json`; the Docker `npm ci` requires the lockfile to be updated to match, so `package-lock.json` must be regenerated when network is available (note it in findings if blocked).
- No DB/schema/auth changes (constraint). Consent is localStorage-only; no new API route, no Prisma column.
