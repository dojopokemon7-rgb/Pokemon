# Design Review — Full Scrydex-Parity Catalog Re-Model (both games)

Reviewer: fresh design-review subagent (no prior context from the authoring session).
Target: `design.md` (Revision 3) against `requirements.md` and `PLAN.md` (repo root).
Method: every load-bearing claim re-verified against the actual source, not taken on the
design's word.

---

## Summary verdict

**CHANGES_REQUESTED.** The design is unusually thorough and its two previous review passes
have materially improved it. The hardest question — the per-printing unique key and the
Pokémon `me55c-4` vs `base1-4` identity problem — is answered with REAL, independently
re-verified source evidence and a sound match-then-upsert that provably preserves owned FKs
and want-list ids. However the review found **one HIGH** and **two MEDIUM** gaps that must be
closed before implementation, plus NITs. The dominant HIGH is a real architecture mismatch:
the design's central safety guarantee (FR-3.5 / NFR-2 "per-set transactional, never
half-migrated") does not match the page-based, non-transactional structure of EITHER ingest
script, and the design never specifies how to bridge that gap.

---

## What I verified against real source (Verified Assumptions)

1. **Scrydex shape: one `card.id`, printings nested in `variants[]` (design §1.2 #1).**
   CONFIRMED in `src/lib/services/scrydex.service.ts`: `ScrydexCardSchema` has a single
   `id: z.string()` and `variants: z.array(VariantSchema)`, where `VariantSchema = { name
   (default "normal"), prices[], images }`. There is NO per-variant top-level id. The design's
   core premise (composite key required) is a FACT, not an assumption. ✔

2. **Pokémon id namespace differs from `Card.externalId` (design §1.2 #4, HIGH-1 resolution).**
   CONFIRMED: `scrydex.service.ts` header and `ScrydexCardSchema.id` comment both state the
   Scrydex id is `me55c-4`, "NOT the TCGdex externalId"; `resolveScrydexCard` exists precisely
   because `externalId` cannot be passed to the by-id endpoint, and it matches on
   `normNumber(number)` + `expansion.name`. `prisma/schema.prisma` `Card.scrydexId` carries the
   verbatim `me55c-4` vs `base1-4` comment. The design's match-then-upsert premise is grounded. ✔

3. **`pull-full-catalog.ts` has NO credit gate, NO dry-run, NO `--apply` (design §4.3 /
   MEDIUM-3).** CONFIRMED: it is a bare `main()` that calls `scrydexHeaders()` directly (never
   `assertScrydexCreditsApproved`), pages immediately, and `createMany({ skipDuplicates:true })`.
   It writes `externalId: c.id, scrydexId: c.id`. The design's "must ADD, not extend" framing is
   correct. ✔

4. **One Piece ingest contract (design §4.2/§4.4).** CONFIRMED: `ingest-onepiece-catalog.ts`
   calls `assertScrydexCreditsApproved("standard", pages)`, defaults to dry-run, gates on
   `--apply`, and `upsertOnePieceCard` is keyed on `{ externalId }`. The `hasVariantImages`
   write branch and the `canonical(prior.variantImages) === canonical(m.variantImages)`
   unchanged term (NIT-4) both exist exactly as the design describes (lines ~214, ~224, ~240). ✔

5. **Schema FK/cascade chains (design §5.1/§5.2).** CONFIRMED in `schema.prisma`:
   `UserCollection.cardId → Card.id onDelete: Cascade`; `CardSet → Card`, `Card →
   PricingHistory/CurrentPrice/PopulationReport/SoldListing` all `onDelete: Cascade`.
   `Card.externalId @unique`, `Card.scrydexId String? @unique` (the design's drop-unique target),
   `Card.number` has NO uniqueness, `variantImages Json?`. `CurrentPrice`/`PricingHistory`
   unique tuples are keyed by `cardId` + source/currency/variant/condition/company/grade/type. ✔

6. **`WantListItem.cardId` is the EXTERNAL id, not an FK (design §5.5).** CONFIRMED:
   `cardId String // external card id`, no relation to `Card`. The want-list resolution argument
   (base printing keeps `base1-4`, so bare-id want rows still resolve) is valid. ✔

7. **Add-to-collection fallback `number` derivation (design §6.3 / MEDIUM-2).** CONFIRMED:
   `route.ts` POST creates a new card with
   `number: deriveStoredCardNumber(item.externalId, isOnePieceCode(item.externalId))`. A
   composite `externalId` WOULD corrupt `number`. The one-line `split("::")[0]` fix is valid and
   a genuine no-op for non-composite ids. ✔

8. **Redis cache keys/TTLs (design §6.1 / MEDIUM-2 of Rev 2).** CONFIRMED in `src/lib/redis.ts`
   and `card.service.ts`: `card:searchq:` (DB-backed catalog read) has `CACHE_TTL.cardSearch =
   300` (5 min); `card:search:` (service-layer external search) is set with a direct
   `redis.set(..., "EX", 86_400)` (24h) in `card.service.ts`. The design correctly distinguishes
   the two and flushes both. ✔

9. **Search route + `NormalizedCardSchema` additive `printing` (design §6.1).** CONFIRMED:
   the search route uses a `select` and maps rows to `NormalizedCard`; adding `printing: true`
   to `select` and `printing: z.string().nullish()` to the schema is additive and back-compat
   (the route re-parses cached blobs with the same schema; `.nullish()` lets old blobs pass). ✔

---

## Unverified / Wrong Assumptions

1. **"Per-set transactional migration" (FR-3.5 / NFR-2 / AC-13) is asserted but NOT supported by
   the code it builds on.** Both ingest scripts page the catalog by PAGE (100 cards/page), and a
   single page interleaves cards from multiple sets while a single set spans many pages
   (`pull-full-catalog.ts` `pullGame` loop; `ingest-onepiece-catalog.ts` `run` loop — both
   per-card upsert, NO `$transaction` anywhere). The design's §5.4 claim that the re-ingest
   "processes one set at a time, each set's upserts inside a `prisma.$transaction`" does not
   follow from either script's shape, and the design never specifies the restructure (buffer the
   whole catalog grouped by set? two-pass? accumulate per-set then flush on set boundary?). This
   is the HIGH finding below. UNVERIFIED → effectively WRONG as written.

2. **The "~1 entry per number" / variant-multiplier evidence rests on cached LOG files this
   reviewer could not open.** The design (§1.2 #2) and PLAN Phase 0 cite `.full-pull*.log`
   `total_count` values (2840 OP / 47481 PKM). The Zod-schema evidence (one id + nested
   variants) is sufficient ON ITS OWN to prove the composite key is required, so this does not
   block — but the specific multiplier/size numbers (~80k–160k) remain owner-probe-confirmed
   estimates, exactly as the design itself flags. Acceptable, noted for honesty.

3. **The credit-gate module PATH.** The design cites `scrydex-credit-gate.ts`; the One Piece
   script imports it from `../src/lib/services/scrydex-credit-gate`, while AGENTS.md §8 lists it
   under `src/lib/utils/`. The import that actually compiles is the `services/` one. Minor, but
   the Pokémon rewrite must import from the SAME path the OP script uses, not the AGENTS.md path.
   NIT below.

---

## Findings

### HIGH-1 — "Per-set transactional, never half-migrated" is unimplementable as specified against page-based ingest; the HARD CONSTRAINT (FR-3.5/NFR-2/AC-13) has no concrete mechanism.

**Where:** design §5.4 ("processes one set … each set's upserts run inside a
`prisma.$transaction`"), §7 ("per-set transactional re-ingest"), §9 ("that set's `$transaction`
rolls back"). Requirements FR-3.5, NFR-2, AC-13 make per-set-transactional-or-staging a HARD
CONSTRAINT.

**Problem:** Verified against both scripts: `pull-full-catalog.ts` and
`ingest-onepiece-catalog.ts` are PAGE-based and do per-card upserts with NO transaction. A
Scrydex catalog PAGE contains cards from many sets, and a set spans many pages — so "wrap one
set in a transaction" cannot be done by the existing page loop. The design asserts the guarantee
but never specifies the restructuring that would make it true. As written, an implementer would
either (a) ship the page-based loop and silently violate the HARD CONSTRAINT, or (b) have to
invent the per-set grouping themselves — exactly the ambiguity this review exists to catch. The
duplicate-base and net-increase assertions (§5.1) are described as per-set and "roll the set's
`$transaction` back," which inherits the same missing mechanism.

**Concrete fix (pick ONE and specify it fully in §5.4):**
- **Option A — two-pass, set-grouped apply.** Pass 1: page the whole catalog, buffer the mapped
  rows in memory keyed by `setExternalId` (rows are small; ~160k rows is tractable, or spill per
  game). Pass 2: for each set, open `prisma.$transaction`, run that set's match-then-upserts +
  the two assertions, commit or roll back. State the memory budget and that OP (~29 pages) and
  PKM (~475 pages) are bounded.
- **Option B — staging-first, whole-DB snapshot as the rollback unit (A5).** Run the entire
  re-ingest against the isolated `staging` schema, verify counts, then promote. If this is the
  primary path, say so and demote per-set transactions to the prod-only fallback, and still
  specify the fallback's grouping (Option A) because A5 says prod-direct is used when credits
  don't allow a staging pull.
- **Option C — explicitly accept per-PAGE transactional + idempotent-resume** as the recovery
  unit instead of per-set, and REWRITE FR-3.5/AC-13's "per-set" wording to "per-page
  transactional + resumable," justifying that a crash leaves only committed pages (idempotent
  upsert makes re-run safe) and no half-written SET matters because the composite key is stable.
  This is the smallest diff but requires the requirements wording to change — call that out.

Whichever is chosen, §5.4 must name the transaction UNIT, how cards are grouped into it against a
page-based fetch, and how a mid-run crash is recovered — concretely enough to implement.

---

### MEDIUM-1 — The net-Card-increase assertion is the ONLY guard against a clean Pokémon set-name miss, and the design does not prove it fires in the cross-set case; it also breaks on an idempotent re-run.

**Where:** design §5.1 "Duplicate-base guard" and the "per-set net `Card`-count increase MUST
equal the number of non-base printings created" assertion; §9 error handling.

**Problem:** The design's own NIT-3 scenario: a seeded Pokémon row whose `set.name` does not
line up with the Scrydex expansion name → step-2 match MISSES → green-field `baseId = c.id`
(`me55c-4`) in the Scrydex-keyed set, while the old `base1-4` seed row stays in the OLD set. The
design claims the duplicate-base assertion makes this safe, but that assertion is "exactly one
base row per number+set" — and the orphaned seed row and the new green-field base are in
DIFFERENT sets, so BOTH sets show exactly one base → the duplicate-base assertion PASSES and does
NOT catch it. Only the net-increase assertion catches it (new set gains N rows but only N−1 are
non-base). The design never spells out that the net-increase assertion is the sole catcher for
the cross-set miss, and two edges make it fragile:
  (a) **Idempotent re-run (AC-5):** on a second `--apply`, zero rows are created, so "net
      increase (0) == non-base created (0)" holds — fine — but the assertion must be phrased as
      *created-this-run*, not *total non-base rows for the number*. As written ("the number of
      non-base printings created") it is ambiguous whether it counts this-run creations or the
      stored total; the stored-total reading would FALSELY fire on every re-run.
  (b) **Cross-set accounting:** the assertion is scoped "per set," but the miss SPLITS one
      logical number across two sets. A per-set net-increase check on the NEW set sees +N and
      non-base +（N−1) → fires (good), but the design should state explicitly that the per-set
      scope still catches a split, because a reader could reasonably assume per-number scope.

**Concrete fix:** In §5.1, (1) state that the net-increase assertion counts rows CREATED in this
run (`created` tally), not total stored non-base rows, so an idempotent re-run with 0 creations
trivially passes; (2) add one sentence proving the cross-set split is caught by the per-set
net-increase check on the Scrydex-keyed set (+N vs +(N−1)); and (3) since the whole safety of the
Pokémon path leans on this one assertion plus the MANDATORY pre-check, add the pre-check's
set-name-vs-expansion-name lineup as an explicit gate: if the pre-check shows seed set names that
don't match Scrydex expansion names, Pokémon set reconciliation is REQUIRED before `--apply`
(the design says this in prose — make it a hard precondition the script checks or the owner
signs off on, not just a note).

---

### MEDIUM-2 — The guarded-delete helper (FR-3.4/AC-12) is specified for "a stale seed row Scrydex no longer has," but the re-ingest has no step that ENUMERATES such orphans, so the safety net is never actually run.

**Where:** design §5.3 (guarded delete "for the genuine edge case where a pre-existing row
matches NO Scrydex card at all"), §7 ("runs the guarded-delete audit (expected: 0 deletes)").

**Problem:** The normal path adds rows and matches base printings onto existing rows; it never
iterates the EXISTING catalog to find rows that the re-ingest did NOT touch (true orphans —
stale seed rows, or cards Scrydex dropped). The design says the script "runs the guarded-delete
audit" but never specifies WHAT that audit queries. Without an explicit "find Card rows of this
game whose `externalId` was not upserted in this run AND have 0 `UserCollection` refs" step, the
guarded delete is dead code and stale rows silently persist (they'd keep appearing in search as
collapsed single results with no printing siblings — a parity miss FR-5.1 would not catch because
it only checks that the sample number HAS its printings, not that stale singletons are gone).
This is not data loss (safe direction), but it is an unmet requirement: FR-3.4/AC-12 describe a
guarded delete path that the design never wires to an input set.

**Concrete fix:** Either (a) specify the orphan-enumeration step concretely — e.g. track the set
of `externalId`s upserted this run per game, then
`SELECT id,cardId FROM card WHERE game=$G AND externalId NOT IN (<upserted>) AND NOT EXISTS
(SELECT 1 FROM user_collection WHERE cardId=card.id)` → delete only those, count them in
before/after — and state it runs AFTER all sets commit; or (b) explicitly scope the migration as
ADD-ONLY (never delete), accept that stale singletons remain until a separate cleanup, and reword
FR-3.4/AC-12 to "no delete is performed by this migration" so the guarded-delete helper is not
claimed as delivered. Pick one; today the design claims a guarded delete it never feeds.

---

### NIT-1 — Credit-gate import path inconsistent with AGENTS.md.

**Where:** design §4.3/§4.4/§7 cite `scrydex-credit-gate.ts`; AGENTS.md §8 lists it under
`src/lib/utils/`; the One Piece script actually imports `../src/lib/services/scrydex-credit-gate`.

**Fix:** State the Pokémon rewrite imports `assertScrydexCreditsApproved` / `estimateCredits`
from `@/lib/services/scrydex-credit-gate` (the path that compiles today), matching the OP script,
not the AGENTS.md `utils/` location.

---

### NIT-2 — `PLAN.md` is absent from the worktree task folder (confirmed).

**Where:** design header note; task references `.worktrees/scrydex-parity/.agents/tasks/
scrydex-parity-catalog/PLAN.md`.

**Observed:** `PLAN.md` exists ONLY at the repo root
(`d:\Pokemon\Pokemon\.agents\tasks\scrydex-parity-catalog\PLAN.md`); it is NOT in the worktree
task folder. The design already documents this and cites the repo-root path. No design change
required — recorded so the implementer reads it at the repo-root path (or the owner copies it in).

---

### NIT-3 — `pull-full-catalog.ts` is not on the worktree branch; the design says "bring it in," but doesn't pin the exact copy step.

**Where:** design §4.3 provenance note and Appendix.

**Observed:** `file_search` finds the script only at `d:\Pokemon\Pokemon\scripts\
pull-full-catalog.ts` (repo-root working tree). The design correctly says to copy the current
repo-root version onto the worktree branch before editing.

**Fix:** Name the one concrete action (e.g. `git show master:scripts/pull-full-catalog.ts` into
the worktree path, or `cp` from repo root) so the implementer doesn't reinvent it or edit the
wrong tree. Low risk, but the migration's correctness depends on editing the RIGHT file.

---

### NIT-4 — `buildCardRow` headline-price fields use `variants[0]` / a flat scan; the per-variant rewrite must re-scope them, and the design should name that.

**Where:** design §4.3 ("`marketPrice`/`weeklyChange*` from THIS variant's NM-raw entry + its
`trends.days_7`"), against the real `buildCardRow` which computes
`raw7 = c.variants?.[0]?.prices...days_7` and `nmRaw = c.variants.flatMap(prices).find(NM raw)`.

**Observed/Fix:** The design's intent is right (per-variant price), but the real code derives the
headline from `variants[0]` and a catalog-wide flat scan. The rewrite must change these to read
the CURRENT variant's `prices[]` (not `variants[0]`, not the union). The design says "THIS
variant's" — good — just add an explicit note that the existing `variants[0]` / flatMap headline
derivation is REPLACED per-variant, mirroring the NIT-4-style explicitness already applied to the
One Piece `upsertOnePieceCard` cleanup, so the implementer doesn't leave a stale `variants[0]`
read that would copy variant-0's price onto every printing (would fail AC-17).

---

## Requirement-by-requirement coverage spot-check

- FR-1.1 key decision + evidence: COVERED, evidence re-verified (§1.2). ✔
- FR-1.2 printing label / FR-1.3 number non-unique / FR-1.5 retire variantImages: COVERED (§2). ✔
- FR-1.7 pricing keys remain valid: COVERED and re-verified against the real unique tuples. ✔
- FR-2.1/2.2/2.3 one-row-per-variant, Zod drop-invalid, idempotent: COVERED (§4), image-fallback
  edge (Rev-3 MEDIUM-1) handled. ✔
- FR-2.4/2.5/2.6 gate + dry-run + counts: COVERED; the "Pokémon script must ADD these" is the
  correct reading of the real code. ✔
- FR-3.1/3.2/3.3 no loss / base-in-place / owned resolve: COVERED by match-then-upsert, logically
  sound. ✔ (but see MEDIUM-1 on the assertion that polices it)
- FR-3.4 guarded delete: SPECIFIED but not wired to an input set → MEDIUM-2.
- FR-3.5 per-set transactional: ASSERTED but not implementable as written → HIGH-1.
- FR-3.6 want-list resolution: COVERED (§5.5), re-verified `cardId` is the external id. ✔
- FR-4.1–4.6 UI parity + retire variantImages path: COVERED (§6). ✔
- FR-5.1/5.2 parity verification: COVERED (§8.3), offline/online split correct. ✔
- NFR-6 performance at scale: the design notes existing indexes suffice and no per-number group
  read is introduced; search stays `findMany` + offset. Adequate, no new index claimed needed —
  acceptable given each printing is an independent row on the same indexed columns. ✔

---

## Disposition

- HIGH: 1 (HIGH-1 — per-set transactional mechanism missing)
- MEDIUM: 2 (MEDIUM-1 — net-increase assertion under-specified / cross-set + re-run edges;
  MEDIUM-2 — guarded-delete helper never fed an orphan set)
- NIT: 4

Per the mechanical rule, HIGH+MEDIUM = 3 > 0 → **CHANGES_REQUESTED**. None of the three is a
design-killer; all three are "name the mechanism you already implied" gaps. A focused Revision 4
that (1) specifies the transaction unit against page-based fetch, (2) tightens the net-increase
assertion wording + proves the cross-set catch and makes the set-name pre-check a hard
precondition, and (3) either wires or explicitly drops the guarded delete, should clear to
APPROVED.
