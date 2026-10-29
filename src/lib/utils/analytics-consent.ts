/**
 * Analytics consent + env-gating decision logic.
 *
 * PURE on purpose (RULE 11): no `window`, no `localStorage`, no DOM access.
 * Keeping the decision here (rather than inline in the components) makes it
 * trivially unit-testable AND SSR-safe — the same function runs on the server
 * render and in the browser with no `typeof window` guard, and the components
 * stay thin (they read localStorage + env, then defer the yes/no to `shouldInit`).
 */

/** localStorage key the consent choice persists under (user-facing contract). */
export const CONSENT_STORAGE_KEY = "dojo-analytics-consent";

export type ConsentValue = "granted" | "denied";

/**
 * Decide whether a single tracker may initialize.
 *
 * Returns `true` ONLY when consent was explicitly granted AND the tracker's env
 * key is present and non-empty (whitespace-only counts as empty — an unset
 * `NEXT_PUBLIC_*` sometimes inlines as `""` or a stray space). Any other state
 * — denied, no choice yet (null), missing/blank key — is a total no-op.
 */
export function shouldInit(
  consent: ConsentValue | null | undefined,
  key: string | null | undefined
): boolean {
  return consent === "granted" && typeof key === "string" && key.trim() !== "";
}

/**
 * Normalize a raw localStorage value into a known consent state.
 * Returns `null` for the SSR / unset / corrupt cases so the banner shows and
 * nothing initializes until the user makes a real choice.
 */
export function parseConsent(
  raw: string | null | undefined
): ConsentValue | null {
  return raw === "granted" || raw === "denied" ? raw : null;
}
