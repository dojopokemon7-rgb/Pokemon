import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { scoreCandidate } from "@/lib/utils/fuzzy-match";

/**
 * POST /api/cards/recognize
 *
 * Card recognition matcher (F-14). The CLIENT runs OCR (tesseract.js) on the
 * captured photo and sends the extracted text here; this route fuzzy-matches
 * that text against real catalog card names and returns the TOP 3 candidates
 * with confidence scores. No hardcoded results.
 *
 *   Request:  { text: string, game?: "pokemon" | "onepiece" }
 *   Response: { success: true, candidates: [{ id, name, set, imageUrl, confidence }] }
 *             — candidates is [] when nothing scores above threshold.
 *
 * Confidence is the normalized similarity (0..1). The client shows a
 * confirmation list and treats < 0.40 / empty as "not recognized".
 */

// Only consider candidates at/above this similarity; the client also
// enforces the 0.40 product threshold before auto-showing confirmation.
const MIN_CONFIDENCE = 0.4;
const TOP_N = 3;
// Cap how many catalog rows we score per request (recognition is best-effort;
// scanning the whole 6k-row catalog per scan would be wasteful).
const SCORE_POOL = 400;

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const b = body as { text?: unknown; game?: unknown } | null;
  const text = typeof b?.text === "string" ? b.text.trim() : "";
  if (!text) {
    return NextResponse.json(
      { success: false, error: "`text` (OCR result string) is required." },
      { status: 400 }
    );
  }
  const game = b?.game === "onepiece" || b?.game === "pokemon" ? b.game : undefined;

  try {
    // Narrow the scoring pool with a cheap DB prefilter: any card whose name
    // shares a token with the OCR text. Falls back to a recent slice when the
    // OCR text has no usable tokens.
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
        imageUrl: true,
        imageUrlHi: true,
        set: { select: { name: true } },
      },
    });

    const candidates = rows
      .map((r) => ({
        id: r.externalId,
        name: r.name,
        set: r.set?.name ?? "",
        imageUrl: r.imageUrl ?? r.imageUrlHi ?? "",
        confidence: scoreCandidate(text, r.name),
      }))
      .filter((c) => c.confidence >= MIN_CONFIDENCE)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, TOP_N);

    return NextResponse.json({ success: true, candidates });
  } catch (err) {
    console.error("[cards/recognize] match failed:", err instanceof Error ? err.message : err);
    // Never 500 the scanner — degrade to "no candidates".
    return NextResponse.json({ success: true, candidates: [] });
  }
}
