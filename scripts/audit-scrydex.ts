/**
 * Checkpoint A — read-only Scrydex audit (spec: scrydex-migration, task 1.1;
 * Reqs 1.1, 1.2, 4.4). Invoked MANUALLY (`tsx scripts/audit-scrydex.ts`),
 * NEVER by cron. Prints per-area findings that feed `docs/SCRYDEX_AUDIT.md`.
 *
 * STRICTLY READ-ONLY (Req 1.2):
 *   - Every Scrydex call is a GET. Even the Vision/identify probe uses GET —
 *     we are discovering whether a PATH EXISTS, not running an identify. A
 *     POST-only route answers GET with 405 (path exists) vs 404 (path absent),
 *     so a GET distinguishes the two WITHOUT uploading an image or burning an
 *     identify credit. The real POST shape + credit cost is confirmed in P4
 *     once a path is found. (This also keeps the whole script GET-only, which
 *     task 1.2's unit test asserts.)
 *   - No schema migration, no write path, no bulk refresh. Catalog probes hit
 *     pageSize=1 so the paid-credit burn is a trivial handful of single-card
 *     reads, not a bulk run. A bulk refresh is a Checkpoint D owner-approval
 *     gate (task 1.4) — this script stops well before that.
 *
 * SECRETS (Req 4.4): referenced by NAME only. `scrydexHeaders()` (reused from
 * scrydex.service.ts — single source of truth for the X-Api-Key + X-Team-ID
 * pair and the env var names) is the ONLY thing that touches the key value,
 * and its return is passed straight to fetch. The key/team values NEVER reach
 * stdout. We print `SCRYDEX_API_KEY present: true|false`, never the value.
 *
 * CLOUDFLARE: rapid repeats to api.scrydex.com trip bot-mitigation and HANG
 * (not error). Every probe is spaced SLEEP_MS (3–5s) apart.
 *
 * ponytail: this is a probe harness, not production code — a flat sequence of
 * labelled GETs with a shared summary line. No abstraction beyond `probe()`.
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { scrydexHeaders } from "../src/lib/services/scrydex.service";

const BASE = "https://api.scrydex.com";
const SLEEP_MS = 4000; // Cloudflare pacing (contracts: space calls 3–5s apart)

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A single read-only GET probe. Prints status + a short shape summary, never
 * the response body verbatim (bodies can be large; we extract only the keys /
 * fields the audit cares about). Returns the parsed JSON (or null) so callers
 * can drill into tiers.
 */
async function probe(
  label: string,
  path: string
): Promise<{ status: number; json: unknown } | null> {
  const url = `${BASE}${path}`;
  try {
    const res = await fetch(url, { method: "GET", headers: scrydexHeaders() });
    let json: unknown = null;
    const text = await res.text();
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text.slice(0, 200); // non-JSON (e.g. Cloudflare HTML) — truncated
    }
    console.log(`  [${res.status}] ${label}  (GET ${path})`);
    return { status: res.status, json };
  } catch (err) {
    console.log(
      `  [ERR] ${label}  (GET ${path}) — ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * Summarize the price tiers found in a card's variants[].prices[]. This is the
 * core decode the audit reports (RAW vs PSA/BGS per Reqs 1.4/1.5), so it is
 * exported and unit-tested (tests/unit/audit-scrydex.test.ts) without network.
 */
export function summarizeTiers(card: unknown): string {
  const variants =
    (card as { variants?: Array<{ prices?: Array<Record<string, unknown>> }> })?.variants ?? [];
  const tiers = new Set<string>();
  for (const v of variants) {
    for (const p of v.prices ?? []) {
      if (p.type === "raw") tiers.add("RAW");
      else if (p.company) tiers.add(`${String(p.company).toUpperCase()}:${String(p.grade ?? "?")}`);
      else tiers.add(`graded(type=${String(p.type)})`);
    }
  }
  return tiers.size ? [...tiers].join(", ") : "NONE";
}

// Exported for task 1.2's unit test (GET-only + no-secret-leak over a mocked
// fetch). Still only auto-runs on direct invocation via the guard below.
export async function main() {
  console.log("=== Scrydex read-only audit (Checkpoint A) ===\n");

  // --- Credentials present? (NAME only — Req 4.4) ---
  console.log("Credentials (by name, never value):");
  console.log(`  SCRYDEX_API_KEY present: ${Boolean(process.env.SCRYDEX_API_KEY)}`);
  console.log(`  SCRYDEX_TEAM_ID present: ${Boolean(process.env.SCRYDEX_TEAM_ID)}`);
  if (!process.env.SCRYDEX_API_KEY || !process.env.SCRYDEX_TEAM_ID) {
    console.error("\nBoth SCRYDEX_API_KEY and SCRYDEX_TEAM_ID must be set in .env. Aborting.");
    process.exit(1);
  }
  console.log("");

  // --- Area 1: catalog + current price (Pokémon) ---
  // Verified contract: GET /pokemon/v1/cards?q=name:..&include=prices → { data:[Card] }.
  // include=prices is REQUIRED or prices[] is absent. pageSize=1 = trivial credit cost.
  console.log("Area 1 — catalog + current price (Pokémon):");
  const pkmn = await probe(
    "pokemon search (charizard, include=prices)",
    "/pokemon/v1/cards?q=name:charizard&pageSize=1&include=prices"
  );
  const pkmnCard =
    (pkmn?.json as { data?: unknown[] })?.data?.[0] ?? null;
  if (pkmnCard) {
    console.log(`      tiers in variants[].prices[]: ${summarizeTiers(pkmnCard)}`);
    console.log(
      `      card id (scrydex-native): ${String((pkmnCard as { id?: string }).id ?? "?")}`
    );
  }
  await sleep(SLEEP_MS);

  // --- Area 1b: One Piece slug verification ---
  // Pokémon slug confirmed; One Piece (/onepiece/v1/...) UNVERIFIED. A 200 with
  // data confirms the slug; a 404 means the slug is wrong (record as a GAP).
  console.log("\nArea 1 — One Piece slug probe:");
  const op = await probe(
    "onepiece search (luffy, include=prices)",
    "/onepiece/v1/cards?q=name:luffy&pageSize=1&include=prices"
  );
  const opCard = (op?.json as { data?: unknown[] })?.data?.[0] ?? null;
  if (opCard) console.log(`      tiers in variants[].prices[]: ${summarizeTiers(opCard)}`);
  await sleep(SLEEP_MS);

  // --- Area: RAW/PSA/BGS tiers (Reqs 1.4, 1.5) ---
  // Tiers are not a separate endpoint — they are entries in the SAME card's
  // variants[].prices[] (type:"raw" vs company/grade). Summarized above; a card
  // showing only RAW with no PSA/BGS entry is a genuine GAP for that card. The
  // audit doc records per-game tier availability from these samples.
  console.log("\nTiers summary (from the card samples above):");
  console.log(`  Pokémon:   ${pkmnCard ? summarizeTiers(pkmnCard) : "no sample"}`);
  console.log(`  One Piece: ${opCard ? summarizeTiers(opCard) : "no sample"}`);

  // --- Area 2 (scanner): Vision / identify endpoint discovery ---
  // UNRESOLVED. Already-404'd (contracts): /v1/vision/identify,
  // /pokemon/v1/vision/match, /pokemon/v1/vision. Probe a FEW spaced candidate
  // paths with GET to see which EXIST (405 = exists but needs POST; 404 =
  // absent; 401/403 = exists, auth/other). We do NOT POST an image here — see
  // the file header for why GET is the correct, credit-safe read-only probe.
  console.log("\nArea 2 — Vision/identify endpoint discovery (GET existence probe only):");
  const visionCandidates = [
    "/v1/vision",
    "/pokemon/v1/vision/identify",
    "/v1/image/match",
    "/pokemon/v1/cards/vision",
  ];
  for (const path of visionCandidates) {
    const r = await probe(`vision candidate`, path);
    if (r) {
      const hint =
        r.status === 405
          ? "EXISTS (method not allowed — likely POST-only; confirm shape in P4)"
          : r.status === 404
            ? "absent (404)"
            : r.status === 401 || r.status === 403
              ? "exists? (auth/forbidden — not a plain 404)"
              : `other (${r.status})`;
      console.log(`      → ${hint}`);
    }
    await sleep(SLEEP_MS);
  }
  console.log(
    "  NOTE: identify-supported upload formats + max size are a POST-contract\n" +
      "  detail — record from Scrydex docs / the P4 confirmation, not a GET probe."
  );

  console.log("\n=== Audit complete. Transcribe findings into docs/SCRYDEX_AUDIT.md ===");
}

// Run only when invoked directly (`tsx scripts/audit-scrydex.ts`), NOT on
// import — so tests can import summarizeTiers without triggering live calls.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Audit run failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
