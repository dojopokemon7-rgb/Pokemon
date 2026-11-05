import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Dedicated Vitest config for the REAL-Postgres concurrency test
 * (tests/concurrency/collection-sell.pg.test.ts).
 *
 * Kept SEPARATE from the default vitest.config.ts so this DB-backed test never
 * runs in the normal mocked `test:unit` / `test:integration` lanes (which stay
 * jsdom + fully mocked + DB-free). Differences from the default config:
 *   - `node` environment (no jsdom; this is a pure server/DB test, no React).
 *   - No tests/setup.ts (that pulls in jest-dom matchers we don't need here).
 *   - Only the concurrency file is included.
 *   - singleFork + no isolation so the five scenarios share one process and run
 *     sequentially against ONE Docker Postgres (the INTRA-scenario parallelism
 *     — two PrismaClients via Promise.all — is what proves the race; the
 *     scenarios themselves must not clobber each other's seeded lot).
 *
 * Invoked ONLY by scripts/concurrency-test.mjs (which sets TEST_DATABASE_URL to
 * the disposable local DB); the suite self-skips when TEST_DATABASE_URL is unset.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    globals: true,
    include: ["tests/concurrency/**/*.pg.test.ts"],
    // One process, no isolation → scenarios run sequentially, not in parallel
    // worker forks that would each spin up their own pools against the lot.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    isolate: false,
    // DB round-trips + container are slower than a mocked unit test.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
