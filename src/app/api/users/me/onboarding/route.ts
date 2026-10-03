/**
 * /api/users/me/onboarding — account-persisted first-login onboarding (plan §6).
 *
 *   GET  → { completed: boolean } for the authenticated user.
 *   POST → { action: "continue" | "skip" } marks onboarding complete (idempotent,
 *          one-time) and returns { completed: true, next }.
 *
 * Persisting completion on the ACCOUNT (User.onboardingCompletedAt) — not
 * localStorage — means the first-login prompt never reappears across devices.
 * The user is identified from the Better Auth server session (never client
 * input). "continue" → the user wants to add cards (next: "/collection/add");
 * "skip" → straight to the dashboard (next: "/dashboard"). Both complete the
 * step permanently; the choice only decides where we send them this once.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/utils/auth-guard";
import { prisma } from "@/lib/db";

export async function GET(request: Request): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;

  const user = await prisma.user.findUnique({
    where: { id: guard.session.user.id },
    select: { onboardingCompletedAt: true },
  });

  return NextResponse.json(
    { completed: user?.onboardingCompletedAt != null },
    { headers: { "Cache-Control": "no-store" } }
  );
}

const OnboardingActionSchema = z.object({
  action: z.enum(["continue", "skip"]),
});

export async function POST(request: Request): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;
  const userId = guard.session.user.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad Request", message: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = OnboardingActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Bad Request", message: "action must be 'continue' or 'skip'." },
      { status: 400 }
    );
  }

  // Idempotent, one-time: set the completion timestamp only if not already set,
  // via a conditional update so a double-submit can't move the timestamp.
  await prisma.user.updateMany({
    where: { id: userId, onboardingCompletedAt: null },
    data: { onboardingCompletedAt: new Date() },
  });

  const next = parsed.data.action === "continue" ? "/collection/add" : "/dashboard";
  return NextResponse.json(
    { completed: true, next },
    { headers: { "Cache-Control": "no-store" } }
  );
}
