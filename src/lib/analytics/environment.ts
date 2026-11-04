/** Maps a hostname to an `environment` tag (single free PostHog project). */
export function analyticsEnvironment(hostname: string): string {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1") return "development";
  if (h.includes("staging")) return "staging";
  if (h === "dojocollect.com" || h.endsWith(".dojocollect.com")) return "production";
  return "unknown";
}
