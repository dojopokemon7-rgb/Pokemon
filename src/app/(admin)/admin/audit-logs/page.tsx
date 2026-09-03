/**
 * Admin — Audit Logs
 *
 * Renders entries from the `AuditLog` table (see prisma/schema.prisma).
 * The card-update API already writes here on every save, so the table
 * populates in real time as admin actions happen — no mock data.
 *
 * Wire additional admin mutations to `writeAuditLog()` in
 * src/lib/utils/audit-log.ts to expand the trail.
 */

import { prisma } from "@/lib/db";
import { formatDateTime } from "@/lib/utils/format";

// Human-readable labels for the raw `action` string. Missing entries
// fall through to the raw key so new actions are visible without a
// code change.
const ACTION_LABELS: Record<string, string> = {
  "card.update": "Updated Card",
  "user.ban": "Banned User",
  "user.unban": "Unbanned User",
  "listing.remove": "Removed Listing",
};

const PAGE_LIMIT = 100;

export default async function AdminAuditLogsPage() {
  const logs = await prisma.auditLog.findMany({
    take: PAGE_LIMIT,
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="px-10 py-10">
      <header className="mb-6">
        <div
          className="dojo-step-label"
          style={{ fontSize: "10px", marginBottom: "8px" }}
        >
          Admin
        </div>
        <h1 className="dojo-heading" style={{ fontSize: "32px" }}>
          Audit Logs
        </h1>
        <p className="dojo-body" style={{ marginTop: "6px" }}>
          {logs.length === 0
            ? "No entries yet — admin actions will appear here."
            : `Last ${logs.length} admin action${logs.length === 1 ? "" : "s"}.`}
        </p>
      </header>

      <div
        style={{
          background: "var(--color-dojo-card)",
          border: "1px solid var(--color-dojo-stroke)",
        }}
      >
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            tableLayout: "fixed",
          }}
        >
          <colgroup>
            <col style={{ width: "18%" }} />
            <col style={{ width: "22%" }} />
            <col style={{ width: "18%" }} />
            <col style={{ width: "42%" }} />
          </colgroup>
          <thead>
            <tr>
              <Th>Timestamp</Th>
              <Th>Admin</Th>
              <Th>Action</Th>
              <Th>Details</Th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="dojo-faint"
                  style={{ padding: "40px 20px", textAlign: "center" }}
                >
                  No audit entries recorded yet. Edit a card price to see
                  the first entry appear here.
                </td>
              </tr>
            ) : (
              logs.map((log) => (
                <tr
                  key={log.id}
                  style={{ borderTop: "1px solid var(--color-dojo-divider)" }}
                >
                  <Td>
                    <span
                      className="dojo-faint"
                      style={{ fontSize: "12px" }}
                    >
                      {formatDateTime(log.createdAt)}
                    </span>
                  </Td>
                  <Td>
                    <span
                      style={{
                        color: "var(--color-dojo-ink)",
                        fontWeight: 600,
                        fontSize: "12.5px",
                      }}
                    >
                      {log.adminEmail}
                    </span>
                  </Td>
                  <Td>
                    <span className="dojo-tag acc" style={{ fontSize: "8.5px" }}>
                      {ACTION_LABELS[log.action] ?? log.action}
                    </span>
                  </Td>
                  <Td>
                    <DetailsCell
                      targetType={log.targetType}
                      targetId={log.targetId}
                      details={log.details}
                    />
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        textAlign: "left",
        padding: "14px 20px",
        fontFamily: "var(--font-display)",
        fontWeight: 700,
        fontSize: "9.5px",
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: "var(--color-dojo-body)",
        borderBottom: "1px solid var(--color-dojo-stroke)",
      }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td
      style={{
        padding: "14px 20px",
        textAlign: "left",
        verticalAlign: "top",
      }}
    >
      {children}
    </td>
  );
}

/**
 * Renders `details` intelligently for the common admin actions
 * (currently `card.update`). Falls back to a compact JSON preview for
 * anything unrecognised so new actions still surface useful info.
 */
function DetailsCell({
  targetType,
  targetId,
  details,
}: {
  targetType: string;
  targetId: string | null;
  details: unknown;
}) {
  const summary = formatDetails(details);
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          color: "var(--color-dojo-ink)",
          fontSize: "12.5px",
          lineHeight: 1.5,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {summary || "—"}
      </div>
      <div
        className="dojo-faint"
        style={{
          marginTop: "2px",
          fontSize: "10.5px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {targetType}
        {targetId ? ` · ${targetId}` : ""}
      </div>
    </div>
  );
}

function formatDetails(details: unknown): string {
  if (details == null || typeof details !== "object") return "";
  const d = details as {
    cardName?: string;
    changes?: Record<
      string,
      { from?: unknown; to?: unknown } | undefined
    >;
  };

  const parts: string[] = [];
  if (d.cardName) parts.push(`"${d.cardName}"`);

  if (d.changes) {
    for (const [field, change] of Object.entries(d.changes)) {
      if (!change) continue;
      const from = renderValue(change.from);
      const to = renderValue(change.to);
      parts.push(`${field}: ${from} → ${to}`);
    }
  }

  if (parts.length > 0) return parts.join(" · ");

  try {
    return JSON.stringify(details);
  } catch {
    return "";
  }
}

function renderValue(v: unknown): string {
  if (v == null) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v.length > 40 ? `${v.slice(0, 37)}…` : v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
