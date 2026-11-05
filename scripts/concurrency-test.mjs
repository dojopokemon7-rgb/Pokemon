#!/usr/bin/env node
/**
 * Harness for the REAL-Postgres sale-concurrency test (fix 3ac5153).
 *
 * Stands up a DISPOSABLE local Postgres 16 in Docker on a NON-default port
 * (5433), applies the Prisma schema to it with `prisma db push` (schema-only,
 * NO migration history), runs the concurrency Vitest file against it, then
 * TEARS THE CONTAINER DOWN — pass or fail. Idempotent: it force-removes any
 * leftover container from a prior run before starting, and removes it again in
 * a finally block.
 *
 * SAFETY (critical): this NEVER reads or uses the repo .env DATABASE_URL /
 * DIRECT_URL (which point at PRODUCTION Supabase). The ONLY connection string
 * used anywhere here is the local disposable one below, injected into the child
 * processes' env as DATABASE_URL + DIRECT_URL + TEST_DATABASE_URL. The repo
 * .env is left untouched.
 *
 * Usage:  node scripts/concurrency-test.mjs   (or: npm run test:concurrency)
 * Requires: Docker daemon running.
 */
import { spawnSync } from "node:child_process";

const CONTAINER = "dojo-saletest-pg";
const HOST_PORT = "5433";
const PG_IMAGE = "postgres:16";
// Disposable local DB — throwaway creds, loopback only, never Supabase.
const TEST_DB_URL = `postgresql://postgres:postgres@localhost:${HOST_PORT}/dojo_saletest`;

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: false, ...opts });
  return res.status ?? 1;
}

function runQuiet(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8", shell: false });
}

function removeContainer() {
  // -f so it's a no-op when the container doesn't exist (idempotent).
  runQuiet("docker", ["rm", "-f", CONTAINER]);
}

async function waitForReady(maxTries = 60) {
  for (let i = 0; i < maxTries; i++) {
    const res = runQuiet("docker", [
      "exec",
      CONTAINER,
      "pg_isready",
      "-U",
      "postgres",
      "-d",
      "dojo_saletest",
    ]);
    if (res.status === 0 && /accepting connections/.test(res.stdout || "")) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function main() {
  // Fail fast if Docker isn't reachable.
  if (runQuiet("docker", ["info"]).status !== 0) {
    console.error("[concurrency] Docker daemon is not reachable. Start Docker and retry.");
    process.exit(1);
  }

  console.log("[concurrency] (idempotent) removing any leftover test container…");
  removeContainer();

  let exitCode = 1;
  try {
    console.log(`[concurrency] starting disposable ${PG_IMAGE} on port ${HOST_PORT}…`);
    const up = run("docker", [
      "run",
      "-d",
      "--name",
      CONTAINER,
      "-e",
      "POSTGRES_PASSWORD=postgres",
      "-e",
      "POSTGRES_USER=postgres",
      "-e",
      "POSTGRES_DB=dojo_saletest",
      "-p",
      `127.0.0.1:${HOST_PORT}:5432`,
      PG_IMAGE,
    ]);
    if (up !== 0) throw new Error("docker run failed");

    console.log("[concurrency] waiting for Postgres readiness…");
    if (!(await waitForReady())) throw new Error("Postgres did not become ready in time");

    // Child env: point Prisma at the TEST DB ONLY. We do NOT spread process.env
    // selectively — we inherit it then OVERRIDE the two connection vars, so even
    // if a stray .env was loaded elsewhere these win for the children.
    const childEnv = {
      ...process.env,
      DATABASE_URL: TEST_DB_URL,
      DIRECT_URL: TEST_DB_URL,
      TEST_DATABASE_URL: TEST_DB_URL,
    };

    console.log("[concurrency] applying schema with `prisma db push` (schema-only)…");
    const push = run(
      "node",
      ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"],
      { env: childEnv }
    );
    if (push !== 0) throw new Error("prisma db push failed");

    console.log("[concurrency] running the concurrency Vitest suite against the live DB…");
    exitCode = run(
      "node",
      ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.concurrency.config.ts"],
      { env: childEnv }
    );
  } catch (err) {
    console.error("[concurrency] ERROR:", err instanceof Error ? err.message : err);
    exitCode = 1;
  } finally {
    console.log("[concurrency] tearing down the disposable container…");
    removeContainer();
  }

  process.exit(exitCode);
}

main();
