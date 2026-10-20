/**
 * BUG 2 — pure URL-param ↔ list-control mapping (no React, no window). The
 * portfolio + search pages persist their in-memory controls (portfolio
 * cardType/selectedColl/view, search sort) through URL query params so they
 * survive the Back remount after opening a card. The validation is pure and
 * lives here so it is unit-testable (a page.tsx may only export framework
 * symbols — AGENTS.md NEXT.JS PAGE EXPORT GUARD).
 */

/**
 * Return `value` when it is one of `allowed`, else `fallback`. The generic
 * primitive both pages use to validate a param against a known option set —
 * an absent/unknown param falls back to the control's default (deep-link safe,
 * never trusts an arbitrary query value).
 */
export function paramOrDefault<T extends string>(
  value: string | null | undefined,
  allowed: readonly T[],
  fallback: T
): T {
  return value != null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
