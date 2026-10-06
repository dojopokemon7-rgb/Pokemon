/**
 * Pure signup-allowlist predicate.
 *
 * Gates NEW-account creation against a comma-separated allowlist of exact
 * emails and/or `@domain.com` suffixes (e.g. `me@x.com,@trusted.org`).
 *
 * Empty/unset allowlist ⇒ signup is OPEN (returns true). This is the
 * load-bearing default: it keeps local dev, CI, and the existing e2e/unit
 * suites working without having to set SIGNUP_ALLOWLIST, and means the gate
 * is strictly opt-in — nobody gets locked out until an operator deliberately
 * configures the list.
 *
 * Side-effect-free so it can be unit-tested in isolation (AGENTS.md RULE 11).
 */
export function isSignupAllowed(email: string, rawAllowlist: string | undefined): boolean {
  const entries = (rawAllowlist ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);

  // Empty/unset ⇒ open (see doc comment above).
  if (entries.length === 0) return true;

  const addr = email.trim().toLowerCase();
  const domain = addr.slice(addr.lastIndexOf("@")); // includes the '@'

  return entries.some((entry) =>
    entry.startsWith("@") ? entry === domain : entry === addr
  );
}
