import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { detectTextWithVision, isVisionConfigured } from "@/lib/services/vision-ocr.service";
import { recognize, type CatalogCard } from "@/lib/services/card-recognition.service";

/**
 * POST /api/cards/recognize
 *
 * Multi-signal card recognition (F-14). Accepts EITHER:
 *   - `image`: a base64 card photo — OCR'd server-side via Google Cloud
 *     Vision (TEXT_DETECTION). The Vision key is a server secret, so OCR
 *     can't run in the browser. When no Vision key is configured the route
 *     returns `ocrSource: "unavailable"` so the client falls back to
 *     on-device tesseract.js and re-submits the `text`.
 *   - `text`: pre-extracted OCR text (tesseract fallback, or a manual query).
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
  const game = b?.game === "onepiece" || b?.game === "pokemon" ? b.game : undefined;
  const image = typeof b?.image === "string" ? b.image : "";
  let text = typeof b?.text === "string" ? b.text.trim() : "";
  let ocrSource: "vision" | "tesseract" | "manual" =
    b?.source === "tesseract" || b?.source === "manual" ? b.source : "vision";

  // Vision path: an image was sent and a key is configured → OCR it here.
  if (image) {
    if (!isVisionConfigured()) {
      // No server-side OCR available — tell the client to run tesseract and
      // re-submit as `text`. Not an error; a graceful fallback signal.
      return NextResponse.json({
        success: true,
        candidates: [],
        ocrSource: "unavailable",
        feedbackId: null,
      });
    }
    const visionText = await detectTextWithVision(image);
    if (visionText == null) {
      // Vision failed/empty — same fallback signal.
      return NextResponse.json({
        success: true,
        candidates: [],
        ocrSource: "unavailable",
        feedbackId: null,
      });
    }
    text = visionText;
    ocrSource = "vision";
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

    return NextResponse.json({ success: true, candidates, feedbackId, ocrSource });
  } catch (err) {
    console.error("[cards/recognize] match failed:", err instanceof Error ? err.message : err);
    // Never 500 the scanner — degrade to "no candidates".
    return NextResponse.json({ success: true, candidates: [], feedbackId: null, ocrSource });
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
