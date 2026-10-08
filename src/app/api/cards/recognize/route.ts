import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { recognize, type CatalogCard } from "@/lib/services/card-recognition.service";
import { identifyCard } from "@/lib/services/scrydex.service";
import {
  getScanAllowance,
  reserveSuccessfulScan,
} from "@/lib/services/scan-allowance.service";
import { base64ToBytes, validateScanUpload } from "@/lib/utils/scan-upload";
import { isScrydexLiveApproved } from "@/lib/services/scrydex-credit-gate";
import { enforceRateLimit, creditTier } from "@/lib/utils/rate-limit";
import { ScanLanguageSchema } from "@/lib/utils/scan-language";

/**
 * POST /api/cards/recognize
 *
 * Multi-signal card recognition (F-14). Accepts EITHER:
 *   - `image`: a base64 card photo — identified server-side via the Scrydex
 *     Vision API (POST /vision/v1/cards/identify). The Scrydex key is a server
 *     secret, so identification can't run in the browser. The image path is
 *     session-scoped and governed by a lifetime successful-scan allowance
 *     (plan §3), server-side upload validation (<=20MB, JPEG/PNG/WebP by
 *     signature), and the owner credit-approval gate (Vision = 5 credits).
 *     On no-match / provider-unavailable it returns `ocrSource: "unavailable"`
 *     so the client falls back to on-device tesseract.js and re-submits `text`.
 *   - `text`: pre-extracted OCR text (tesseract fallback, or a manual query).
 *     This path is anonymous and does NOT consume the scan allowance.
 *
 * The recognition ENGINE (card-recognition.service) scores every candidate
 * card on three independent signals — collector number (+50), set (+20), and
 * fuzzy name similarity (+30·sim) — and returns the TOP 5 with a confidence %.
 *
 * Every scan is logged to ScanFeedback (OCR text + candidates), returning a
 * `feedbackId` the client PATCHes with the card the user finally picked — the
 * ground-truth loop for tuning the scoring weights later.
 *
 *   Response: { success, candidates: [{ id, name, set, imageUrl, confidence }],
 *               feedbackId, ocrSource }
 */

// Cap how many catalog rows we score per request — scanning the whole
// multi-thousand-row catalog per scan would be wasteful.
const SCORE_POOL = 500;
const TOP_N = 5;

/** Reads the session if present; recognition works anonymously too. */
async function optionalUserId(request: Request): Promise<string | null> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const b = body as { text?: unknown; image?: unknown; game?: unknown; source?: unknown } | null;
  // Optional language context (all|en|ja). Validated and echoed only: `Card`
  // has no language column and OCR isn't language-restricted, so it is never
  // applied (languageApplied: false). Absent -> "all" (old bodies unchanged).
  const parsedLang = ScanLanguageSchema.safeParse(
    (body as { language?: unknown } | null)?.language
  );
  if (!parsedLang.success) {
    return NextResponse.json({ success: false, error: "invalid-language" }, { status: 400 });
  }
  const languageEcho = { language: parsedLang.data, languageApplied: false as const };

  const game = b?.game === "onepiece" || b?.game === "pokemon" ? b.game : undefined;
  const image = typeof b?.image === "string" ? b.image : "";
  const text = typeof b?.text === "string" ? b.text.trim() : "";
  const ocrSource: "vision" | "tesseract" | "manual" =
    b?.source === "tesseract" || b?.source === "manual" ? b.source : "vision";

  // ======================================================================
  // Vision path: an image was sent -> Scrydex Vision identify.
  //
  // Enforcement order (plan §3), each step SAFE and credit-aware:
  //   1. Auth    — counted scans are session-scoped (userId from the server
  //                session, never client-supplied).
  //   2. Validate upload BEFORE any provider call: <=20MB + real MIME
  //      (JPEG/PNG/WebP by signature). A bad upload burns NO credits and does
  //      NOT consume the allowance.
  //   3. Allowance — refuse when the lifetime successful-scan limit is reached.
  //   4. Credit gate — Vision is a 5-credit live call; refuse unless owner has
  //      approved live Scrydex credit spend. ("pending-approval" state.)
  //   5. Identify — only now; a no-match returns the Tesseract fallback signal
  //      and does NOT consume the allowance.
  //   6. On SUCCESS — atomically reserve one allowance slot, then the image is
  //      discarded (held in memory only; never persisted).
  // ======================================================================
  if (image) {
    // 1. Auth — counted scans require a session.
    const userId = await optionalUserId(request);
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "auth-required" },
        { status: 401 }
      );
    }

    // Rate-limit the credit-consuming Vision path by user BEFORE upload
    // validation / allowance / the credit gate (Vision = 5 credits per call).
    // The anonymous `text` path below is NOT limited here — it spends no credit.
    const limited = await enforceRateLimit(request, creditTier(), { kind: "user", id: userId });
    if (limited) return limited;

    // 2. Validate the upload server-side (actual bytes, not declared type).
    const bytes = base64ToBytes(image);
    const valid = validateScanUpload(bytes);
    if (!valid.ok) {
      // 400 for a client input error — no credits, no allowance consumed.
      return NextResponse.json(
        { success: false, error: valid.error }, // "too-large" | "unsupported" | "empty"
        { status: 400 }
      );
    }

    // 3. Allowance pre-check (fast refuse before any paid call).
    const allowanceBefore = await getScanAllowance(userId);
    if (allowanceBefore.remaining <= 0) {
      return NextResponse.json(
        { success: false, error: "limit-reached", scanAllowance: allowanceBefore },
        { status: 200 }
      );
    }

    // 4. Credit gate — never spend Vision credits without owner approval.
    if (!(await isScrydexLiveApproved())) {
      return NextResponse.json(
        {
          success: false,
          error: "scan-pending-approval",
          scanAllowance: allowanceBefore,
        },
        { status: 200 }
      );
    }

    // 5. Identify (image used ONLY here; discarded after this scope).
    const games = game ? [game] : undefined;
    const scrydexResult = await identifyCard(
      Buffer.from(bytes),
      valid.mime!,
      games
    );

    if (!scrydexResult || !scrydexResult.cardId) {
      // No match / provider failure — NOT an allowance consumption. Tell the
      // client to try on-device Tesseract and re-submit as `text`.
      return NextResponse.json({
        success: true,
        candidates: [],
        ocrSource: "unavailable",
        feedbackId: null,
        scanAllowance: allowanceBefore,
        ...languageEcho,
      });
    }

    // 6. Successful identify — atomically reserve one allowance slot. The
    //    conditional update is the concurrency guard; if a parallel scan took
    //    the last slot we refuse rather than overrun.
    const reservation = await reserveSuccessfulScan(userId);
    if (!reservation.ok) {
      return NextResponse.json(
        { success: false, error: "limit-reached", scanAllowance: reservation.allowance },
        { status: 200 }
      );
    }

    const matchedCard = await prisma.card.findUnique({
      where: { externalId: scrydexResult.cardId },
      include: { set: true },
    });

    const candidates = matchedCard
      ? [
          {
            id: matchedCard.externalId,
            name: matchedCard.name,
            set: matchedCard.set?.name ?? "",
            imageUrl: matchedCard.imageUrl ?? matchedCard.imageUrlHi ?? "",
            confidence: scrydexResult.confidence,
          },
        ]
      : [];

    // Log feedback (match reference only — NEVER the image bytes).
    let feedbackId: string | null = null;
    try {
      const row = await prisma.scanFeedback.create({
        data: {
          userId,
          ocrText: `SCRYDEX_MATCH:${scrydexResult.cardId}`,
          ocrSource: "vision",
          candidates,
        },
        select: { id: true },
      });
      feedbackId = row.id;
    } catch {}

    // `bytes` / `image` go out of scope here — nothing is written to storage or
    // the portfolio (plan §3: use for identification then discard).
    return NextResponse.json({
      success: true,
      candidates,
      feedbackId,
      ocrSource: "vision",
      scanAllowance: reservation.allowance,
      ...languageEcho,
    });
  }

  if (!text) {
    return NextResponse.json(
      { success: false, error: "Provide an `image` (Vision OCR) or `text` (OCR result)." },
      { status: 400 }
    );
  }

  try {
    // Cheap DB prefilter: any card sharing a token with the OCR text, plus a
    // recent slice as a floor so number/set-only matches still have a pool.
    const tokens = text
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((t) => t.length >= 3)
      .slice(0, 8);

    const gameWhere = game ? { set: { externalId: { startsWith: `${game}-` } } } : {};

    const rows = await prisma.card.findMany({
      where: {
        ...gameWhere,
        ...(tokens.length
          ? { OR: tokens.map((t) => ({ name: { contains: t, mode: "insensitive" as const } })) }
          : {}),
      },
      take: SCORE_POOL,
      select: {
        externalId: true,
        name: true,
        number: true,
        imageUrl: true,
        imageUrlHi: true,
        set: { select: { name: true } },
      },
    });

    const pool: CatalogCard[] = rows.map((r) => ({
      id: r.externalId,
      name: r.name,
      number: r.number,
      set: r.set?.name ?? "",
      imageUrl: r.imageUrl ?? r.imageUrlHi ?? "",
    }));

    const scored = recognize(text, pool, TOP_N);
    const candidates = scored.map((c) => ({
      id: c.id,
      name: c.name,
      set: c.set,
      imageUrl: c.imageUrl,
      confidence: c.confidence,
    }));

    // Log the scan for the tuning loop. Best-effort — a logging failure must
    // never break recognition.
    let feedbackId: string | null = null;
    try {
      const userId = await optionalUserId(request);
      const row = await prisma.scanFeedback.create({
        data: { userId, ocrText: text, ocrSource, candidates },
        select: { id: true },
      });
      feedbackId = row.id;
    } catch (logErr) {
      console.warn(
        "[cards/recognize] scan-feedback log failed (non-fatal):",
        logErr instanceof Error ? logErr.message : logErr
      );
    }

    return NextResponse.json({ success: true, candidates, feedbackId, ocrSource, ...languageEcho });
  } catch (err) {
    console.error("[cards/recognize] match failed:", err instanceof Error ? err.message : err);
    // Never 500 the scanner — degrade to "no candidates".
    return NextResponse.json({ success: true, candidates: [], feedbackId: null, ocrSource, ...languageEcho });
  }
}

/**
 * PATCH /api/cards/recognize
 *
 * Records which card the user finally picked for a prior scan (the feedback
 * loop's label). `{ feedbackId, pickedCardId }`. Best-effort; returns
 * `{ success }` regardless so the add-to-collection flow never blocks on it.
 */
export async function PATCH(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
  }
  const b = body as { feedbackId?: unknown; pickedCardId?: unknown } | null;
  const feedbackId = typeof b?.feedbackId === "string" ? b.feedbackId : "";
  const pickedCardId = typeof b?.pickedCardId === "string" ? b.pickedCardId : "";
  if (!feedbackId || !pickedCardId) {
    return NextResponse.json({ success: true }); // nothing to record
  }
  try {
    await prisma.scanFeedback.update({
      where: { id: feedbackId },
      data: { pickedCardId },
    });
  } catch (err) {
    console.warn(
      "[cards/recognize] scan-feedback pick update failed (non-fatal):",
      err instanceof Error ? err.message : err
    );
  }
  return NextResponse.json({ success: true });
}

/**
 * GET /api/cards/recognize
 *
 * Returns the authenticated user's lifetime scan allowance so the scanner UI
 * can show "N of LIMIT scans used" and whether live scanning is currently
 * enabled (owner credit-approval gate). Anonymous callers get a null allowance.
 *
 *   Response: { scanAllowance: { used, limit, remaining } | null, scanEnabled }
 */
export async function GET(request: Request): Promise<NextResponse> {
  const userId = await optionalUserId(request);
  const scanEnabled = await isScrydexLiveApproved();
  if (!userId) {
    return NextResponse.json(
      { scanAllowance: null, scanEnabled },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
  const scanAllowance = await getScanAllowance(userId);
  return NextResponse.json(
    { scanAllowance, scanEnabled },
    { headers: { "Cache-Control": "no-store" } }
  );
}
