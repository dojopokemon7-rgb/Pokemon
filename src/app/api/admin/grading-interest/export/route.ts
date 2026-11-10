/**
 * GET /api/admin/grading-interest/export
 *
 * Admin-only (requireAdmin -> isolated admin session cookie, 401 otherwise).
 * Streams ALL grading_interest rows as an Excel-compatible CSV (UTF-8 BOM,
 * CRLF, RFC 4180 quoting, ISO dates, formula-injection neutralized — see
 * src/lib/utils/csv.ts). Opens directly in Excel; no .xlsx dependency.
 * The export is audit-logged (admin, row count, time — no row data).
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/utils/auth-guard";
import { writeAuditLog } from "@/lib/utils/audit-log";
import { CSV_BOM, csvRow } from "@/lib/utils/csv";
import { isMissingTable } from "@/lib/services/grading-interest.service";

export const dynamic = "force-dynamic";

const BATCH = 1000;
const HEADER = ["email", "category", "volume", "joined_at", "updated_at", "source"];

export async function GET(request: Request): Promise<Response> {
  const guard = await requireAdmin(request);
  if (guard.unauthorized) return guard.unauthorized;

  let total: number;
  try {
    total = await prisma.gradingInterest.count();
  } catch (err) {
    const missing = isMissingTable(err);
    console.error(`[grading-export] count failed (missing=${missing})`);
    return NextResponse.json(
      { error: missing ? "Table not created — run the grading_interest migration" : "Export failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  await writeAuditLog({
    adminId: guard.session.user.id,
    adminEmail: guard.session.user.email,
    action: "grading_interest.export",
    targetType: "grading_interest",
    details: { rowCount: total },
    request,
  });

  const encoder = new TextEncoder();
  let offset = 0;
  let sentBom = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!sentBom) {
          sentBom = true;
          controller.enqueue(encoder.encode(CSV_BOM + csvRow(HEADER)));
          return;
        }
        const rows = await prisma.gradingInterest.findMany({
          orderBy: [{ joinedAt: "desc" }, { id: "desc" }],
          skip: offset,
          take: BATCH,
        });
        if (rows.length === 0) return controller.close();
        offset += rows.length;
        controller.enqueue(
          encoder.encode(
            rows
              .map((r) => csvRow([r.email, r.category, r.volume, r.joinedAt, r.updatedAt, r.source]))
              .join("")
          )
        );
      } catch (err) {
        controller.error(err);
      }
    },
  });

  const day = new Date().toISOString().slice(0, 10);
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="grading-interest-${day}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
