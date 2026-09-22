import { NextResponse } from "next/server";

/**
 * POST /api/cards/recognize
 *
 * Card recognition endpoint (F-14, MVP).
 *
 * Contract:
 *   Request:  { image: string }   // base64 image or a mock identifier
 *   Response: { success: true, card: { id, name, set, imageUrl } }
 *
 * MVP NOTE: real OCR/Vision is out of scope for this TDD step. This
 * handler validates the payload shape and returns a fixed mocked match
 * (the seeded "Charizard"). Swapping in a real Vision provider later is
 * a server-only change — the request/response contract and the whole
 * frontend flow (camera → scan → result) stay identical.
 * ponytail: hardcoded single match — replace with a Vision call keyed on
 * `image` when F-17+ wires real recognition.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  // Trust boundary: require the documented `image` field.
  const image = (body as { image?: unknown } | null)?.image;
  if (typeof image !== "string" || image.length === 0) {
    return NextResponse.json(
      { success: false, error: "`image` (string) is required." },
      { status: 400 }
    );
  }

  return NextResponse.json({
    success: true,
    card: {
      id: "charizard-base",
      name: "Charizard",
      set: "Base Set",
      imageUrl: "/mock-charizard.jpg",
    },
  });
}
