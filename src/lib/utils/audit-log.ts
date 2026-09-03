/**
 * Audit-log helper — server-only.
 *
 * Call from every admin mutation to write a tamper-evident trail of
 * "who did what, when". Failures are logged but do not throw — an
 * audit-log write should never break the primary action for the admin.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export interface AuditLogInput {
  adminId: string;
  adminEmail: string;
  action: string;                 // e.g. "card.update_price"
  targetType: string;             // "card" | "user" | ...
  targetId?: string | null;
  details?: Prisma.InputJsonValue;
  request?: Request;              // optional — extracts IP + UA
}

export async function writeAuditLog(input: AuditLogInput): Promise<void> {
  const ipAddress =
    input.request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    input.request?.headers.get("x-real-ip") ??
    null;
  const userAgent = input.request?.headers.get("user-agent") ?? null;

  try {
    await prisma.auditLog.create({
      data: {
        adminId: input.adminId,
        adminEmail: input.adminEmail,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        details: input.details ?? undefined,
        ipAddress,
        userAgent,
      },
    });
  } catch (err) {
    // Non-fatal — surface for observability but don't fail the caller.
    console.error("[audit-log] Failed to write entry", err);
  }
}
