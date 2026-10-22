import { describe, it, expect } from "vitest";
import { isTerminalEnrichResult } from "@/lib/utils/enrich-result";

/**
 * Guards the on-view enrich terminal-vs-transient decision (the fix for the
 * staging bug where cards opened near login stayed empty forever). TERMINAL
 * results are returned and NOT retried; TRANSIENT failures must be treated as
 * retryable so the page's queryFn THROWS and the bounded retry re-attempts.
 * Pure function, no network — exercised directly.
 */
describe("isTerminalEnrichResult", () => {
  // ── TERMINAL: the enrich route actually ran and settled ───────────────────
  it("res.ok + enriched:true => terminal (no retry)", () => {
    expect(
      isTerminalEnrichResult({
        ok: true,
        body: { enriched: true, history: { stored: 309 } } as never,
      })
    ).toBe(true);
  });

  it('res.ok + reason:"fresh" => terminal', () => {
    expect(isTerminalEnrichResult({ ok: true, body: { enriched: false, reason: "fresh" } })).toBe(true);
  });

  it('res.ok + reason:"disabled" => terminal', () => {
    expect(isTerminalEnrichResult({ ok: true, body: { enriched: false, reason: "disabled" } })).toBe(true);
  });

  it('res.ok + reason:"unknown" => terminal', () => {
    expect(isTerminalEnrichResult({ ok: true, body: { enriched: false, reason: "unknown" } })).toBe(true);
  });

  // ── TRANSIENT: the attempt did not settle on the route (retryable) ────────
  it("401 (unauthenticated — pre-hydration race) => retryable", () => {
    expect(isTerminalEnrichResult({ ok: false, body: null })).toBe(false);
  });

  it("429 (rate-limited) => retryable", () => {
    expect(isTerminalEnrichResult({ ok: false, body: null })).toBe(false);
  });

  it("5xx (server fault) => retryable", () => {
    expect(isTerminalEnrichResult({ ok: false, body: null })).toBe(false);
  });

  it("network/parse error (ok:false, no body) => retryable", () => {
    expect(isTerminalEnrichResult({ ok: false })).toBe(false);
  });

  // ── 200 but an untrusted body => retryable (never a fabricated success) ───
  it("res.ok but {enriched:false} with no known reason => retryable", () => {
    expect(isTerminalEnrichResult({ ok: true, body: { enriched: false } })).toBe(false);
  });

  it('res.ok but an unrecognized reason => retryable', () => {
    expect(isTerminalEnrichResult({ ok: true, body: { enriched: false, reason: "whatever" } })).toBe(false);
  });

  it("res.ok but null body (unparseable 200) => retryable", () => {
    expect(isTerminalEnrichResult({ ok: true, body: null })).toBe(false);
  });
});
