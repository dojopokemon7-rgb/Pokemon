import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Task 1.1 self-check — the audit script's one piece of non-trivial logic is
 * `summarizeTiers`, which decodes the RAW vs PSA/BGS tiers out of a Scrydex
 * card's variants[].prices[] (Reqs 1.4/1.5 — the tier-availability the audit
 * reports). This pins that decode without any network call; importing the
 * script does NOT run the audit (it's guarded behind a direct-invocation
 * check), so no live Scrydex request fires.
 *
 * (The GET-only + no-secret-leak assertions over a mocked HTTP client are
 * task 1.2's separate property test — not duplicated here.)
 */
import { summarizeTiers } from "../../scripts/audit-scrydex";

describe("summarizeTiers (audit tier decode)", () => {
  it("names RAW and graded (company:grade) tiers from variants[].prices[]", () => {
    const card = {
      variants: [
        {
          prices: [
            { type: "raw" },
            { type: "graded", company: "PSA", grade: "10" },
            { type: "graded", company: "bgs", grade: "9.5" },
          ],
        },
      ],
    };
    const out = summarizeTiers(card);
    expect(out).toContain("RAW");
    expect(out).toContain("PSA:10");
    expect(out).toContain("BGS:9.5"); // company upper-cased
  });

  it("reports NONE when a card has no price entries (honest gap, Req 1.5)", () => {
    expect(summarizeTiers({ variants: [{ prices: [] }] })).toBe("NONE");
    expect(summarizeTiers({})).toBe("NONE"); // missing variants entirely
    expect(summarizeTiers(null)).toBe("NONE");
  });
});

/**
 * Task 1.2 (Property 1 boundary + Req 4.4) — over a MOCKED fetch, the audit's
 * main() must (1) issue ONLY GET requests and (2) never leak a secret VALUE to
 * stdout, while still printing the name-only "present: true" line. We stub
 * global fetch so no network is hit, set sentinel secrets so a leak would be
 * unmistakable, capture console.log, and run main() under fake timers so the
 * 3–5s Cloudflare pacing sleeps don't dominate the test.
 */
import { main } from "../../scripts/audit-scrydex";

const API_KEY_SENTINEL = "SECRET-KEY-abc123-DO-NOT-LEAK";
const TEAM_ID_SENTINEL = "SECRET-TEAM-xyz789-DO-NOT-LEAK";

describe("audit-scrydex main() — GET-only + no secret leak", () => {
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const logLines: string[] = [];
  const origEnv = { ...process.env };

  beforeEach(() => {
    fetchCalls.length = 0;
    logLines.length = 0;
    vi.useFakeTimers();

    process.env.SCRYDEX_API_KEY = API_KEY_SENTINEL;
    process.env.SCRYDEX_TEAM_ID = TEAM_ID_SENTINEL;

    // Minimal fake Response: records the call, returns an empty catalog so the
    // decode paths run but nothing network-shaped is needed.
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ data: [] })),
      } as Response);
    });

    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    });
    // audit calls process.exit only on missing creds — sentinels are set, so it
    // won't fire; still guard so a stray exit doesn't kill the test runner.
    vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("unexpected process.exit");
    }) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...origEnv };
  });

  it("issues only GET requests and never prints a secret value", async () => {
    // Run main() concurrently with draining its pacing sleeps.
    const done = main();
    await vi.runAllTimersAsync();
    await done;

    // (1) at least one call happened, and EVERY call used method GET
    expect(fetchCalls.length).toBeGreaterThan(0);
    for (const call of fetchCalls) {
      expect(call.init?.method).toBe("GET");
    }

    // The secret DID reach fetch headers (that's correct — the service puts the
    // key in X-Api-Key); the audit's job is to keep it out of STDOUT.
    const headerLeak = fetchCalls.some((c) =>
      JSON.stringify(c.init?.headers ?? {}).includes(API_KEY_SENTINEL)
    );
    expect(headerLeak).toBe(true);

    // (2) no captured stdout line contains either secret VALUE
    const stdout = logLines.join("\n");
    expect(stdout).not.toContain(API_KEY_SENTINEL);
    expect(stdout).not.toContain(TEAM_ID_SENTINEL);

    // (3) secrets are reported by NAME with a presence boolean, never value
    expect(stdout).toContain("SCRYDEX_API_KEY present: true");
    expect(stdout).toContain("SCRYDEX_TEAM_ID present: true");
  });
});
