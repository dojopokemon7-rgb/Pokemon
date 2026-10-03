# Performance notes — sub-1s load target

Audit of the current performance posture plus the levers that matter for fast
loads. The app was already well-tuned; this documents what's in place and the
honest remaining levers (so nobody "optimizes" something already optimal).

## Already in place (verified)

- **TanStack Query cache** (`src/app/providers.tsx`): `staleTime` 5 min, `gcTime`
  10 min, `refetchOnWindowFocus:false`, `refetchOnReconnect:false`. Tab switches
  between dashboard/portfolio/search/wantlist are cache hits — no refetch.
- **Redis caching with documented TTLs** (`src/lib/redis.ts` `RedisKeys`): search
  24h, trending 120s, card price 6h, eBay/sold 24h, FX 24h. Postgres stays source
  of truth; Redis is fail-open.
- **Shared per-card 24h freshness gate** (`scrydex-pricing.service.ts`): a repeat
  card view reads STORED Postgres data — zero Scrydex round-trips (and zero
  credits) inside the window. This is the single biggest cold-load lever and it's
  active.
- **Route-level HTTP caching**: trending `private, max-age=30, SWR=120`; population
  `private, max-age=86400`; sold-records 24h shared cache.
- **Narrowed Prisma selects**: the collection GET selects only the columns the UI
  reads (no dead CardSet payload); trending/search use explicit `select`.
- **Offset pagination** everywhere (composes with any sort, no duplicate pages).
- **Lazy, async-decoded images** (`CardImage.tsx`): `loading="lazy"`,
  `decoding="async"`, aspect-ratio box (no layout shift), ordered fallback chain.
  Deliberately plain `<img>` (not next/image) because card art spans many
  cross-origin CDNs where per-tile optimization overhead isn't worth it.
- **Standalone output** + `serverExternalPackages` (prisma, ioredis) keep the
  server bundle lean.
- **SSR `initialData`** on the dashboard removes the first-paint spinner.

## Added this pass

- `experimental.optimizePackageImports: ["@tanstack/react-query"]` in
  `next.config.ts` — tree-shakes the barrel export so only used symbols ship,
  shrinking first-load JS. Safe/additive, no behaviour change.

## Honest remaining levers (measure before changing)

- **Cold card-detail load** depends on how many stored price points exist. With
  the credit gate OFF (default), history/sold sections render their empty state
  instantly (no live call). With it ON, the first load of an un-cached card pays
  the Scrydex round-trip once, then the 24h cache makes repeats instant.
- **Catalog growth**: the GIN tag index + the `@@index([updatedAt])` keep search
  and trending off sequential scans. Re-check `EXPLAIN` if the catalog grows past
  a few hundred thousand rows.
- **Images**: if a single canonical CDN is ever adopted, switching `CardImage` to
  `next/image` with that host in `remotePatterns` would add on-the-fly resizing.
  Not worth it while art is spread across many CDNs.

## How to measure (owner, in a full env)

- `npm run build` then Lighthouse on `/dashboard`, `/search`, a card detail, and
  `/portfolio` (mobile throttling). Target LCP < 1s on a warm cache.
- Watch the Network panel: a second visit to any card should show cached API
  responses (304 / from-cache), not fresh round-trips.
