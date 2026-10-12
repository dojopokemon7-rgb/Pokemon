# Verification — One Piece ALTERNATE-ART variant-image fix (op-altart)

Worktree `d:\Pokemon\Pokemon\.worktrees\op-altart`, branch `op-altart`. Windows /
PowerShell; the repo path contains a space — all paths quoted.

## Iteration note

The `.agents/tasks/review.json` on disk at the start of this run was a STALE copy
from an unrelated `perf-optimize` task (its only finding + `reviewDoc` point at a
`perf-optimize` worktree and an e2e portfolio-chart spec, nothing alt-art). The
alt-art `design.md`/`requirements.md` the step prompt references do NOT exist in
this worktree (the on-disk `design.md`/`requirements.md` are the earlier
"External API Integration" task). Per `.agents/tasks/plan.md`'s own "Context note",
the alt-art **plan.md step prompt is the authoritative spec**, and this was treated
as the FIRST implementation iteration of the 14-step alt-art plan (none of those
steps had been implemented on the branch — the branch HEAD was desktop/admin work).

## What was implemented (plan steps 1–13)

| Step | File(s) | Change |
|---|---|---|
| 1 Schema | `prisma/schema.prisma` | `variantImages Json?` on `Card` (next to image fields) + load-bearing comment; `npx prisma generate` OK. |
| 2 Migration | `prisma/migrations/20250111000000_card_variant_images/{migration.sql,APPLY.md}` | Additive `ALTER TABLE "card" ADD COLUMN IF NOT EXISTS "variantImages" JSONB;` + APPLY.md (prefer `prisma migrate deploy`, Docker-psql fallback, verify query). Verified LOCALLY on throwaway `postgres:17-alpine` (see below). NOT applied to Mumbai. |
| 3 Resolvers | `src/lib/utils/card-image.ts` | `VariantImagesReadSchema` (the ONE shared Zod schema), type `VariantImagesMap`, `parseVariantImages` (never-throws → `{}`), `onePieceVariantImageUrl` (select large→medium→small; null → fallback). |
| 4 Scrydex schema | `src/lib/services/scrydex.service.ts` | `ScrydexImageSchema` (`.nullish()`); `images` added to `VariantSchema` + `ScrydexCardSchema` (resilient — no-images parses). |
| 5 Mapper | `src/lib/services/scrydex.service.ts` | `pickVariantImages(card)` keyed by `variant.name`; RULE 2 (real URLs only, imageless omitted, may be `{}`). |
| 6 Ingest | `src/lib/services/scrydex-pricing.service.ts` | After price write: write `Card.variantImages` ONLY when `game===ONE_PIECE` AND non-empty; best-effort/non-fatal; never Pokémon, never null/empty. |
| 7 Cache schema | `src/app/api/cards/[id]/prices/route.ts` | `PricesCacheSchema.variantImages` = `VariantImagesReadSchema.nullable()` (REQUIRED-nullable → stale blob misses); `variantImages` added to both cached payloads + the catch payload. |
| 8 Integration test | `tests/integration/scrydex-variant-images.test.ts` | REAL OP08-023 shape (foil/altArt/reprint/specialAltArt). Asserts schema parse, `pickVariantImages` captures altArt + omits imageless, write stores for One Piece / never Pokémon / never empty. Mocked Prisma + fetchers; no network/credits. |
| 9 Unit test | `tests/unit/card-image.test.ts` | `parseVariantImages` round-trip + never-throw on garbage; `onePieceVariantImageUrl` select + fallback. |
| 10 Display | `src/app/(dashboard)/search/[id]/page.tsx` | Hero resolves `onePieceVariantImageUrl(variantImages, variant)` for One Piece, falling back to `onePieceImageUrl(id) ?? PLACEHOLDER`; `variantImages` read from prices payload; `useEffect` resets `heroError` on src change. PRESERVED: hero `<img>` `maxWidth:"100%"`, single-hop `onError`, Pokémon `cardImgById` branch, VariantSelect/`listVariants`/`pickDefaultVariant`. |
| 11 Selectability ceiling | `src/app/(dashboard)/search/[id]/page.tsx` | `ponytail:` comment at VariantSelect: priced-variant-only; upgrade = union `variantImages` keys into `listVariants`. Did NOT list unpriced variants. |
| 12 Backfill | `scripts/backfill-onepiece-variant-images.ts` + `scripts/BACKFILL-onepiece-variant-images.md` | DRY-RUN default, One-Piece-scoped (`set.externalId` startsWith `"onepiece-"`), idempotent (canonical deep-equal, `{}`≡`null`), credit-GATED via `@/lib/services/scrydex-credit-gate` `assertScrydexCreditsApproved("standard", n)`, OWNER-RUN banner. NOT run; no live Scrydex calls in build/verify. |
| 13 Docs | `docs/CODE_MAP.md`, `docs/ARCHITECTURE.md` | `Card.variantImages`, `pickVariantImages`, ingest write, `card-image.ts` resolvers + shared schema, prices-route payload/cache, detail hero flow, migration + backfill entries, accepted selectability ceiling. |

## Commands run and results (from the worktree root)

| Command | Result |
|---|---|
| `npx prisma generate` | PASS — client regenerated with `variantImages`. |
| `npm run type-check` (`tsc --noEmit`) | PASS — exit 0. |
| `npm run lint` (`eslint .`) | PASS — exit 0, 0 errors. |
| `npm run build` | PASS — exit 0, production build compiles clean (`/search/[id]` 7.79 kB / 143 kB First Load). |
| `npm run test:unit` | PASS — **54 files, 407 tests** (includes the 6 new card-image alt-art cases). |
| `npm run test:integration` | PASS — **52 files, 358 tests** (includes the 4 new `scrydex-variant-images` tests; `cache-revalidate-read` "valid blob" case updated to carry the new required-nullable `variantImages` key — a direct consequence of step 7, no behavior change). |

No pre-existing unrelated unit/integration failures were observed in this run; all
suites are fully green. (e2e was NOT run here — it needs a reachable remote
`DATABASE_URL` + standalone build; the schema migration is authored-not-applied, so
e2e against Mumbai is out of scope for this build/verify.)

## Local migration verification (throwaway postgres:17-alpine — NOT Mumbai)

Ran a disposable container (`docker run -e POSTGRES_PASSWORD=pw postgres:17-alpine`),
created a minimal `card` table, piped
`prisma/migrations/20250111000000_card_variant_images/migration.sql` through
`psql -v ON_ERROR_STOP=1`, then ran the APPLY.md verify query. Results:

```
CREATE TABLE
ALTER TABLE
=== VERIFY: column_name ===
variantImages
=== VERIFY: type/nullable ===
jsonb|YES
=== idempotency re-run ===
NOTICE:  column "variantImages" of relation "card" already exists, skipping
ALTER TABLE
```

Column exists as `jsonb`, nullable, and the migration is idempotent on re-run. The
container was stopped + removed afterward. **The migration was NOT applied to Mumbai**
— the orchestrator runs `npx prisma migrate deploy` per APPLY.md.

## Backfill status

`scripts/backfill-onepiece-variant-images.ts` is authored, DRY-RUN-default,
credit-gated, and was **NOT run** (no live Scrydex/Vision calls were made anywhere in
build/verify; the tests mock Scrydex + Prisma). Owner runs it per
`scripts/BACKFILL-onepiece-variant-images.md`.

## Accepted deviations (per step prompt)

1. **scrydex-credit-gate path.** The backfill imports the credit gate from
   `@/lib/services/scrydex-credit-gate` (it lives under `src/lib/services/`, NOT
   `src/lib/utils/`) — the correct path used throughout the codebase.
2. **Scanner candidate strip INTENTIONALLY NOT changed** — `src/app/api/cards/recognize/route.ts`
   is untouched. Owner-approved descope: Scrydex Vision's `variant` cannot be reliably
   mapped to a catalog variant name without a forbidden 5-credit probe, so the scan
   candidate strip keeps showing the variant-blind base art. **FR-5 / AC-7 are NOT
   blocking.** scan-allowance + credit-gate ordering untouched.

## Load-bearing invariants preserved

- Pokémon ingest/display byte-for-byte unchanged (every new write/read is One-Piece-gated).
- RULE 2 (only real Scrydex URLs; absent stays absent — imageless variant omitted, empty map not written).
- RULE 3 (`variantImages` is display data, not an id).
- RULE 4 (Zod at every boundary incl. cache re-parse via the ONE shared `VariantImagesReadSchema`).
- RULE 13 (images.scrydex.com flows through the existing proxy; no CSP/SSRF change).
- e2e selectors/testids/text intact: `data-testid="variant-select"`, `ariaLabel="Price history chart"`,
  want-to-buy-btn, hero `maxWidth:"100%"` + single-hop `onError`. No new dependency; square corners / `--color-dojo-*` tokens unchanged.
