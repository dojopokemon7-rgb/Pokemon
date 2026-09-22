/**
 * POST /api/support — submit a Contact Support ticket (F-21).
 *
 * Gated to authenticated users. Delegates to submitSupportTicket, which
 * validates and persists the ticket, and always returns a result object so
 * a delivery failure becomes a graceful 502 rather than a crash.
 */

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/utils/auth-guard";
import { submitSupportTicket } from "@/lib/services/support.service";
import type { ContactSupportInput } from "@/lib/services/support.service";

export async function POST(request: Request): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Bad Request", message: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const result = await submitSupportTicket(body as ContactSupportInput, {
    userId: guard.session.user.id,
  });

  if (result.ok) {
    return NextResponse.json({ data: { ticketId: result.ticketId } }, { status: 201 });
  }

  // Validation failures read as bad input; delivery failures as upstream.
  const isValidation = result.error !== "Failed to send message, please try again later.";
  return NextResponse.json(
    { error: isValidation ? "Validation Error" : "Delivery Error", message: result.error },
    { status: isValidation ? 400 : 502 }
  );
}
