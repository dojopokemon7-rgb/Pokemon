# Test fixtures

## `golden_prices.json` — READ-ONLY, user-provided

Drop the provided file with 20 real PSA-graded cards and their true market
values here as `golden_prices.json`.

**This file is READ-ONLY.** No script, seed, or test in this repo may write to
or edit it. `prisma/seed-test.ts` only *reads* it (for a sanity log) and never
mutates it. It is the ground-truth oracle for pricing-accuracy tests.
