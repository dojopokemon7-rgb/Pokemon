import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Vitest config for unit + integration tests.
 *
 * - `unit` and `integration` are just directory conventions under `tests/`
 *   (plus colocated `*.test.ts(x)` next to source). They share one runner;
 *   `npm run test:unit` / `test:integration` scope by path.
 * - Playwright E2E specs live in `e2e/` and are excluded here so the two
 *   runners never trip over each other.
 */
export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  // Use the automatic JSX runtime so test files don't need `import React`.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
    // Coverage maps which application code (src/) has NO test behind it —
    // the concrete "what's untested" signal for vibe-coded risk. Scoped to
    // src so the % reflects app code, not test files or generated output.
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/*.d.ts",
        // UI pages/layouts are exercised by Playwright E2E, not Vitest —
        // excluding them keeps this report focused on logic coverage.
        "src/app/**/layout.tsx",
        "src/app/**/page.tsx",
      ],
    },
  },
});
