/**
 * Generic Fallback Executor with Circuit Breaker
 *
 * Runs an ordered list of async tasks and returns the first one that
 * succeeds. If a task rejects, throws, or exceeds the per-task timeout,
 * the executor logs the failure and moves to the next task.
 *
 * Each task is paired with a *circuit breaker*: a Redis-backed flag that
 * lets us skip an API that has failed repeatedly, instead of waiting for
 * it to time out on every request. After {@link FAILURE_THRESHOLD}
 * consecutive failures, the breaker "opens" for {@link OPEN_TTL} seconds,
 * during which the task is skipped entirely.
 *
 * @module fallback-executor
 *
 * -------------------------------------------------------------------
 * USAGE
 * -------------------------------------------------------------------
 * ```ts
 * const result = await executeWithFallback([
 *   { name: "tcgdex",      task: () => fetchTcgdex(query) },
 *   { name: "pokemon-tcg", task: () => fetchPokemonTcg(query) },
 *   { name: "scrydex",     task: () => fetchScrydex(query) },
 * ]);
 * ```
 * -------------------------------------------------------------------
 */

import { redis } from "@/lib/redis";

// =============================================================
// Configuration
// =============================================================

/** Hard per-task timeout. No single API call may run longer than this. */
const TASK_TIMEOUT_MS = 5000;

/** Consecutive failures required to trip (open) a circuit breaker. */
const FAILURE_THRESHOLD = 3;

/** How long an open breaker stays open before we retry the API. */
const OPEN_TTL_SECONDS = 600; // 10 minutes

/** Redis counter tracking consecutive failures: `circuit_breaker:fail:{name}` */
const failKey = (name: string): string => `circuit_breaker:fail:${name}`;

/** Redis flag marking the breaker as open: `circuit_breaker:{name}` */
const openKey = (name: string): string => `circuit_breaker:${name}`;

// =============================================================
// Types
// =============================================================

/**
 * A single fallback entry.
 *
 * @template T - The resolved value type of the task.
 * @property name      Human/terminal-readable identifier for the API (e.g. `"tcgdex"`).
 *                     Also used as the Redis key namespace, so keep it stable + lowercase.
 * @property task      Zero-arg async function that performs the actual API call.
 *                     Receives no args so closures must capture their own inputs.
 */
export interface FallbackTask<T> {
  name: string;
  task: () => Promise<T>;
}

// =============================================================
// "No Results" Signal
// =============================================================

/**
 * Thrown by a task when the upstream API responded successfully but has
 * no data for this query (e.g. HTTP 200 with `[]`).
 *
 * Semantically this is different from a hard failure:
 *   - It must still advance to the next fallback (the caller wants data).
 *   - It must NOT count against the circuit breaker — "no match for
 *     charizard" says nothing about whether the API is healthy.
 *
 * The executor detects this type via `instanceof` and skips the
 * failure-recording step.
 */
export class NoResultsError extends Error {
  constructor(message = "API returned no results for this query") {
    super(message);
    this.name = "NoResultsError";
  }
}

// =============================================================
// Circuit Breaker Helpers
// =============================================================

/**
 * Reads the breaker state for `name`.
 *
 * @returns `true` if the breaker is currently OPEN (the API should be skipped).
 */
async function isBreakerOpen(name: string): Promise<boolean> {
  try {
    const flag = await redis.get(openKey(name));
    return flag === "open";
  } catch (err) {
    // If Redis itself is unreachable we cannot trust the breaker —
    // fail open (i.e. attempt the task) rather than blocking everything.
    console.warn(
      `[Fallback] Could not read breaker state for "${name}":`,
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

/**
 * Records a failure for `name` and opens the breaker once the threshold is hit.
 */
async function recordFailure(name: string, reason: string): Promise<void> {
  try {
    // Increment the consecutive-failure counter (defaulting to 0 on first miss).
    const count = await redis.incr(failKey(name));
    // The counter should expire so a slow trickle of failures doesn't
    // accumulate forever; reset the window on each new failure.
    await redis.expire(failKey(name), OPEN_TTL_SECONDS);

    console.warn(
      `[Fallback] "${name}" failure #${count} — ${reason}` +
        (count >= FAILURE_THRESHOLD ? "  ⚡ BREAKER OPENED" : "")
    );

    if (count >= FAILURE_THRESHOLD) {
      await redis.set(openKey(name), "open", "EX", OPEN_TTL_SECONDS);
    }
  } catch (err) {
    console.error(
      `[Fallback] Could not record failure for "${name}":`,
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Resets the failure counter and clears the open flag for `name`.
 * Called whenever a task succeeds — a single success means the API is healthy.
 */
async function recordSuccess(name: string): Promise<void> {
  try {
    await redis.del(failKey(name), openKey(name));
  } catch {
    // Non-fatal: a stale breaker just causes an extra skipped call.
  }
}

// =============================================================
// Core Executor
// =============================================================

/**
 * Runs `tasks` in order and resolves with the first successful result.
 *
 * Failure modes handled per task:
 *   1. **Circuit breaker open** → task is skipped immediately (no network call).
 *   2. **Timeout (> {@link TASK_TIMEOUT_MS})** → task is aborted + counted as failure.
 *   3. **Rejection / thrown error** → counted as failure, next task runs.
 *
 * Every transition is logged so the terminal shows the full chain:
 *   `[Fallback] Trying "tcgdex"…` → `[Fallback] ✅ "tcgdex" succeeded in 312ms`
 *   or `[Fallback] ❌ "tcgdex" failed — <reason>`
 *
 * @template T - The result type shared by all tasks.
 * @param tasks - Ordered list of {@link FallbackTask}s. First wins.
 * @returns The value of the first task that resolves.
 * @throws {Error} `"All fallback tasks failed"` if every task fails or is skipped.
 *                 The original errors are attached on `.errors` for diagnostics.
 */
export async function executeWithFallback<T>(
  tasks: Array<FallbackTask<T>>
): Promise<T> {
  if (tasks.length === 0) {
    throw new Error("executeWithFallback received an empty task list.");
  }

  const errors: Array<{ name: string; reason: string }> = [];

  for (const { name, task } of tasks) {
    // ----------------------------------------------------------
    // 1. Circuit breaker check — skip healthy APIs that are resting
    // ----------------------------------------------------------
    if (await isBreakerOpen(name)) {
      const reason = "circuit breaker open";
      console.log(`[Fallback] ⏭️  Skipping "${name}" (${reason})`);
      errors.push({ name, reason });
      continue;
    }

    // ----------------------------------------------------------
    // 2. Run the task under a strict timeout
    // ----------------------------------------------------------
    const startedAt = Date.now();
    console.log(`[Fallback] Trying "${name}"…`);

    try {
      const result = await withTimeout(task(), TASK_TIMEOUT_MS, name);
      const elapsed = Date.now() - startedAt;

      await recordSuccess(name);
      console.log(
        `[Fallback] ✅ "${name}" succeeded in ${elapsed}ms — ` +
          `results resolved`
      );
      return result;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const elapsed = Date.now() - startedAt;

      // A "no results" signal is NOT a health failure: the API worked fine,
      // it just had nothing for this query. Advance to the next fallback
      // without penalizing the circuit breaker.
      if (err instanceof NoResultsError) {
        console.log(
          `[Fallback] ⚪ "${name}" returned no results after ${elapsed}ms — ` +
            `trying next source`
        );
        errors.push({ name, reason });
        continue; // next task, breaker untouched
      }

      console.warn(
        `[Fallback] ❌ "${name}" failed after ${elapsed}ms — ${reason}`
      );
      await recordFailure(name, reason);
      errors.push({ name, reason });
      // fall through to the next task
    }
  }

  // ----------------------------------------------------------
  // 3. Every task failed — surface a single, descriptive error
  // ----------------------------------------------------------
  const summary = errors.map((e) => `${e.name} (${e.reason})`).join("; ");
  const failure = new Error(
    `All ${tasks.length} fallback tasks failed. Details: ${summary}`
  );
  // Attach structured diagnostics for route handlers / tests.
  (failure as Error & { errors: typeof errors }).errors = errors;
  throw failure;
}

// =============================================================
// Timeout Helper
// =============================================================

/**
 * Wraps a promise so it rejects if it doesn't settle within `ms`.
 *
 * Uses `Promise.race` against a never-resolving timeout. The underlying
 * `fetch` request is *not* cancelled (Node 18 fetch lacks full AbortSignal
 * wiring in all runtimes), but the executor moves on immediately — which
 * is what matters for keeping latency bounded.
 *
 * @template T - Result type of `promise`.
 * @param promise - The in-flight API call.
 * @param ms      - Milliseconds to wait before timing out.
 * @param name    - Task name, included in the timeout error message.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  name: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
      ms
    );
  });

  return Promise.race([promise, timeout])
    .finally(() => {
      if (timer) clearTimeout(timer);
    }) as Promise<T>;
}
