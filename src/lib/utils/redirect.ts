/**
 * Safe post-auth redirect validation (M-3 — OWASP A01 Open Redirect).
 *
 * The middleware records the path a user was trying to reach in a
 * `?callbackUrl=` param and redirects there after login. Trusting that value
 * blindly is an open-redirect / phishing vector: a crafted
 * `callbackUrl=https://evil.example` (or the protocol-relative `//evil.example`)
 * would bounce an authenticated user off-site.
 *
 * `isValidCallbackUrl` is the single gate. A callback is accepted ONLY when it
 * resolves to the SAME origin as `baseUrl` AND is expressed as a site-relative
 * path (a single leading `/`). Everything else — absolute URLs to other hosts,
 * protocol-relative `//host`, backslash variants browsers normalise to `//`,
 * non-http(s) schemes, and empty/garbage input — is rejected so the caller can
 * fall back to a safe default.
 */

/**
 * @param url     The untrusted `callbackUrl` value.
 * @param baseUrl The app's own origin (e.g. process.env.BETTER_AUTH_URL, or
 *                request.nextUrl.origin). Used both as the resolution base and
 *                as the allowed origin.
 * @returns true only if `url` is a safe same-origin, path-relative redirect.
 */
export function isValidCallbackUrl(url: string, baseUrl: string): boolean {
  // Must be a non-empty string that starts with a SINGLE forward slash.
  // Rejects "", absolute "http(s)://…", protocol-relative "//host", and the
  // "/\\host" / "/%2F…" backslash tricks that browsers coerce into "//host".
  if (typeof url !== "string" || url.length === 0) return false;
  if (url[0] !== "/") return false;
  if (url[1] === "/" || url[1] === "\\") return false;

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    // A malformed base origin means we cannot prove same-origin — reject.
    return false;
  }

  // Resolve the candidate against our own origin. For a legitimate relative
  // path the resolved origin equals ours; any absolute or host-bearing value
  // that slipped past the prefix checks resolves to a different origin here.
  let resolved: URL;
  try {
    resolved = new URL(url, base);
  } catch {
    return false;
  }

  return resolved.origin === base.origin;
}
