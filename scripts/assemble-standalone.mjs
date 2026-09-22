/**
 * Assembles the Next.js standalone output for `node .next/standalone/server.js`.
 *
 * `next build` with `output: standalone` emits a self-contained server under
 * .next/standalone/ but does NOT copy the static assets — the Dockerfile
 * normally does this. Mirror that here so the standalone server (used by the
 * Playwright webServer) can serve `.next/static` and `public`.
 *
 * Cross-platform (Node fs), no shell-specific copy commands.
 */
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const standalone = join(root, ".next", "standalone");

if (!existsSync(standalone)) {
  console.error("No .next/standalone — run `next build` with output:'standalone' first.");
  process.exit(1);
}

// .next/static → .next/standalone/.next/static
cpSync(join(root, ".next", "static"), join(standalone, ".next", "static"), { recursive: true });

// public → .next/standalone/public (optional; only if the app has one)
const publicDir = join(root, "public");
if (existsSync(publicDir)) {
  cpSync(publicDir, join(standalone, "public"), { recursive: true });
}

console.log("Standalone assets assembled (.next/static" + (existsSync(publicDir) ? " + public" : "") + ").");
