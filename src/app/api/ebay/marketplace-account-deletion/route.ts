/**
 * eBay Marketplace Account Deletion Notification Endpoint
 * ─────────────────────────────────────────────────────────
 *
 * eBay requires every production app to expose a publicly-accessible
 * HTTPS endpoint where they can:
 *
 *   1. GET  ?challenge_code=<abc>
 *      Validate that we own the endpoint. Their spec:
 *      https://developer.ebay.com/marketplace-account-deletion
 *
 *      Response must be JSON:
 *        { "challengeResponse": "<sha256_hex>" }
 *      where the hash input is the exact string:
 *        challenge_code + verification_token + endpoint_url
 *      (all three concatenated, no separators, no trailing slash on URL).
 *
 *   2. POST { notification: { data: { userId, ... }, ... } }
 *      Real account-deletion notifications. Any 2xx acknowledges receipt.
 *      For a small MVP with no PII beyond the eBay OAuth token, we don't
 *      currently store any per-user eBay data, so there is nothing to
 *      delete on receipt — we just log the event and reply 200.
 *
 * Environment variables:
 *   EBAY_MARKETPLACE_DELETION_TOKEN     — 32-80 char verification token
 *                                          (also pasted into eBay dashboard)
 *   EBAY_MARKETPLACE_DELETION_ENDPOINT  — the exact public URL of this
 *                                          route (also pasted into
 *                                          eBay dashboard). Must match
 *                                          byte-for-byte in the hash.
 */

import { type NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";

/**
 * eBay's spec calls this endpoint publicly (no auth). We must respond
 * fast (they retry aggressively if a 200 doesn't come back in ~2s).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const challengeCode = request.nextUrl.searchParams.get("challenge_code");

  const token = process.env.EBAY_MARKETPLACE_DELETION_TOKEN;
  const endpoint = process.env.EBAY_MARKETPLACE_DELETION_ENDPOINT;

  if (!challengeCode) {
    return NextResponse.json(
      { error: "Missing challenge_code query parameter" },
      { status: 400 }
    );
  }
  if (!token || !endpoint) {
    // Log — this is a config error on our side and must be fixed before
    // eBay's validation retry cycle succeeds.
    console.error(
      "[ebay-mp-deletion] Missing EBAY_MARKETPLACE_DELETION_TOKEN or " +
        "EBAY_MARKETPLACE_DELETION_ENDPOINT env var — cannot compute challenge response."
    );
    return NextResponse.json(
      { error: "Endpoint not configured" },
      { status: 500 }
    );
  }

  // Hash input = challenge_code + verification_token + endpoint_url
  // (order matters, no separators, no encoding)
  const hash = createHash("sha256")
    .update(challengeCode)
    .update(token)
    .update(endpoint)
    .digest("hex");

  return NextResponse.json({ challengeResponse: hash }, { status: 200 });
}

/**
 * Actual account-deletion notification from eBay. We currently store
 * no eBay user PII — the OAuth Application Access Token is
 * app-scoped, not per-user — so there is nothing to delete. We just
 * log and 200 to acknowledge receipt.
 *
 * If we later store per-user eBay tokens (e.g. for the "sell on the
 * Floor" flow), delete-by-userId logic goes HERE.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json().catch(() => null);
    console.log(
      "[ebay-mp-deletion] Received account deletion notification:",
      JSON.stringify(body)?.slice(0, 500)
    );
    return NextResponse.json({ received: true }, { status: 200 });
  } catch (err) {
    console.error(
      "[ebay-mp-deletion] Failed to process notification:",
      err instanceof Error ? err.message : err
    );
    // Still return 200 — eBay retries aggressively on non-2xx and we
    // don't want a retry storm if the notification body is malformed.
    return NextResponse.json({ received: true }, { status: 200 });
  }
}
