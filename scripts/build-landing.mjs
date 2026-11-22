/**
 * Rebuilds the marketing landing from landing/ and swaps the result into
 * public/landing (what the Next app serves). Usage: npm run landing:build
 *
 * Needs `npm ci` inside landing/ first. Builds with base /landing/ into a temp
 * dir, then replaces public/landing/*.html and public/landing/assets/ (deleting
 * stale hashed files). public/landing/{brand,logos,fonts} are overwritten file by
 * file from landing/public, never emptied: fonts/brand are referenced by the CSS.
 *
 * Cross-platform (Node fs + child_process), no shell-specific commands.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const landing = join(root, "landing");
const target = join(root, "public", "landing");
const vite = join(landing, "node_modules", "vite", "bin", "vite.js");

if (!existsSync(vite)) {
  console.error("landing/node_modules is missing. Run `npm ci` inside landing/ first.");
  process.exit(1);
}

const out = mkdtempSync(join(tmpdir(), "dojo-landing-"));
try {
  const run = spawnSync(
    process.execPath,
    [vite, "build", "--base=/landing/", "--outDir", out, "--emptyOutDir"],
    { cwd: landing, stdio: "inherit" }
  );
  if (run.status !== 0) {
    console.error("landing build failed; public/landing was NOT touched.");
    process.exit(run.status ?? 1);
  }

  const pages = readdirSync(out).filter((f) => f.endsWith(".html"));
  if (!pages.includes("index.html") || !existsSync(join(out, "assets"))) {
    console.error("landing build produced no index.html/assets; public/landing was NOT touched.");
    process.exit(1);
  }

  for (const f of readdirSync(target)) {
    if (f.endsWith(".html")) rmSync(join(target, f));
  }
  rmSync(join(target, "assets"), { recursive: true, force: true });
  for (const f of pages) cpSync(join(out, f), join(target, f));
  cpSync(join(out, "assets"), join(target, "assets"), { recursive: true });
  for (const dir of ["brand", "logos", "fonts"]) {
    if (existsSync(join(out, dir))) cpSync(join(out, dir), join(target, dir), { recursive: true });
  }
  console.log(`landing: ${pages.join(", ")} + assets/ -> public/landing`);
} finally {
  rmSync(out, { recursive: true, force: true });
}