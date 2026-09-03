/**
 * PATCH /api/admin/cards/[id]
 *
 * Admin-only inline edit for a card's market price and image URL.
 * Values are optional in the body — send only the fields you want
 * to change. When `marketPrice` is included, `lastPricedAt` is
 * refreshed so downstream views can distinguish manual overrides
 * from stale cache values.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/utils/auth-guard";
import { writeAuditLog } from "@/lib/utils/audit-log";
import { prisma } from "@/lib/db";

const bodySchema = z
  .object({
    // Nullable so admins can explicitly clear a bad price.
    marketPrice: z
      .number()
      .finite()
      .nonnegative()
      .max(1_000_000_000)
      .nullable()
      .optional(),
    imageUrl: z
      .string()
      .trim()
      .url()
      .max(2048)
      .nullable()
      .optional(),
  })
  .refine(
    (v) => v.marketPrice !== undefined || v.imageUrl !== undefined,
    { message: "Provide at least one of `marketPrice` or `imageUrl`." }
  );

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(
  request: Request,
  ctx: RouteContext
): Promise<NextResponse> {
  const guard = await requireAdmin(request);
  if (guard.unauthorized) return guard.unauthorized;

  const { id } = await ctx.params;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "BadRequest", message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "ValidationError",
        message: "Invalid request body.",
        issues: parsed.error.issues,
      },
      { status: 400 }
    );
  }

  const data: {
    marketPrice?: number | null;
    lastPricedAt?: Date;
    imageUrl?: string | null;
  } = {};

  if (parsed.data.marketPrice !== undefined) {
    data.marketPrice = parsed.data.marketPrice;
    data.lastPricedAt = new Date();
  }
  if (parsed.data.imageUrl !== undefined) {
    data.imageUrl = parsed.data.imageUrl;
  }

  try {
    // Capture the "before" snapshot for the audit trail before mutating.
    const before = await prisma.card.findUnique({
      where: { id },
      select: { marketPrice: true, imageUrl: true },
    });

    const updated = await prisma.card.update({
      where: { id },
      data,
      select: {
        id: true,
        name: true,
        marketPrice: true,
        imageUrl: true,
        lastPricedAt: true,
      },
    });

    // Log which fields changed. Fire-and-forget; failures are swallowed
    // by the helper so they never break the admin's save action.
    await writeAuditLog({
      adminId: guard.session.user.id,
      adminEmail: guard.session.user.email,
      action: "card.update",
      targetType: "card",
      targetId: id,
      details: {
        cardName: updated.name,
        changes: {
          ...(parsed.data.marketPrice !== undefined
            ? {
                marketPrice: {
                  from: before?.marketPrice ?? null,
                  to: updated.marketPrice ?? null,
                },
              }
            : {}),
          ...(parsed.data.imageUrl !== undefined
            ? {
                imageUrl: {
                  from: before?.imageUrl ?? null,
                  to: updated.imageUrl ?? null,
                },
              }
            : {}),
        },
      },
      request,
    });

    return NextResponse.json({ card: updated });
  } catch (err) {
    // Prisma throws P2025 when the target row doesn't exist.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2025"
    ) {
      return NextResponse.json(
        { error: "NotFound", message: "Card not found." },
        { status: 404 }
      );
    }
    console.error("[admin cards PATCH] Unexpected error", err);
    return NextResponse.json(
      { error: "InternalError", message: "Failed to update card." },
      { status: 500 }
    );
  }
}
