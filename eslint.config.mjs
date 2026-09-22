import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Flat ESLint config for `npm run verify`.
 *
 * SCOPE: this gate lints the code THIS testing-infra setup introduced —
 * the test suites, the seed script, and the config/tooling files. It does
 * NOT retroactively lint the pre-existing application surface under
 * `src/**`: the repo had no working ESLint setup before (the old
 * `next lint` script had no config and eslint wasn't installed), so there
 * is no lint baseline the app was passing. Turning strict lint on across
 * the whole app would surface ~777 pre-existing findings and require
 * editing application code — out of scope for a "change nothing about app
 * behavior" task. Broadening this to `src/**` is a separate, opt-in cleanup.
 *
 * Uses typescript-eslint's preset directly rather than the Next.js
 * shareable config, which throws a circular-structure error when bridged
 * through FlatCompat under ESLint 9.
 */
export default tseslint.config(
  {
    // Only lint the files this task owns.
    files: ["tests/**/*.{ts,tsx}", "e2e/**/*.ts", "prisma/seed-test.ts", "*.config.{ts,mts,mjs}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Everything else is intentionally not linted by this gate (see note above).
    ignores: [
      "src/**",
      ".next/**",
      "node_modules/**",
      ".reference/**",
      ".kilo/**",
      "prisma/seed.ts",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
    ],
  }
);
