/**
 * Pure delivery-mode decision for password-reset emails.
 *
 *   'send'              — a real email provider is configured; actually send.
 *   'dev-log'           — no provider, local dev; log the link to the console
 *                         so the reset flow is testable (dev-only — the link
 *                         is a secret and must never be logged in prod).
 *   'prod-unconfigured' — no provider, NOT dev; the caller must surface a
 *                         server error, never silently "succeed" (a user who
 *                         requested a reset would otherwise wait forever).
 *
 * Side-effect-free so it can be unit-tested in isolation (AGENTS.md RULE 11).
 */
export function chooseResetDelivery(env: {
  hasProvider: boolean;
  nodeEnv: string | undefined;
}): "send" | "dev-log" | "prod-unconfigured" {
  if (env.hasProvider) return "send";
  return env.nodeEnv === "development" ? "dev-log" : "prod-unconfigured";
}
