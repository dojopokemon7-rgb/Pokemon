/**
 * Auth intent — remembers "the user just started a signup/login" across the
 * redirects that separate the click from the authenticated session (email
 * verification screen, Google OAuth round-trip). AnalyticsProvider consumes it
 * when a Better Auth session first appears, so signup_completed / login_completed
 * fire ONCE, only after a real session exists, and only after consent (identify
 * + track are no-ops before that).
 *
 * Client-safe. sessionStorage only (cleared with the tab; never holds PII —
 * just `kind` + `method`).
 */
import type { AnalyticsEvent } from "./track";

export type AuthMethod = "email" | "google";
/** "oauth" = the Google button, which lives on /login and can't tell a new
 *  account from a returning one at click time; resolved from user.createdAt. */
export type AuthKind = "signup" | "login" | "oauth";
export interface AuthIntent {
  kind: AuthKind;
  method: AuthMethod;
  at: number;
}

const KEY = "dojo-auth-intent";
/** Intents older than this are ignored (abandoned flows). */
const INTENT_TTL_MS = 30 * 60 * 1000;
/** An OAuth user created this recently counts as a fresh signup. */
const NEW_USER_WINDOW_MS = 10 * 60 * 1000;

export function setAuthIntent(kind: AuthKind, method: AuthMethod): void {
  try {
    const intent: AuthIntent = { kind, method, at: Date.now() };
    window.sessionStorage.setItem(KEY, JSON.stringify(intent));
  } catch {
    // storage disabled — we simply won't emit the completion event
  }
}

/** Read AND clear the stored intent (single-use). Null if absent/expired/corrupt. */
export function takeAuthIntent(now: number = Date.now()): AuthIntent | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(KEY);
    const v = JSON.parse(raw) as Partial<AuthIntent>;
    if (
      (v.kind !== "signup" && v.kind !== "login" && v.kind !== "oauth") ||
      (v.method !== "email" && v.method !== "google") ||
      typeof v.at !== "number" ||
      now - v.at > INTENT_TTL_MS
    ) {
      return null;
    }
    return { kind: v.kind, method: v.method, at: v.at };
  } catch {
    return null;
  }
}

/**
 * Pure: which events does this intent produce for the session user?
 * - signup  -> signup_completed
 * - login   -> login_completed
 * - oauth   -> a user created within NEW_USER_WINDOW_MS is a new signup
 *              (signup_started is emitted with signup_completed because the
 *              click could not know); an older account is a login.
 */
export function resolveAuthEvents(
  intent: Pick<AuthIntent, "kind">,
  userCreatedAt: Date | string | number | null | undefined,
  now: number = Date.now()
): AnalyticsEvent[] {
  if (intent.kind === "signup") return ["signup_completed"];
  if (intent.kind === "login") return ["login_completed"];
  const created = userCreatedAt ? new Date(userCreatedAt).getTime() : NaN;
  const isNew = Number.isFinite(created) && now - created < NEW_USER_WINDOW_MS;
  return isNew ? ["signup_started", "signup_completed"] : ["login_completed"];
}
