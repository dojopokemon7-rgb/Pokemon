/**
 * Admin — Recorded Sales
 *
 * Real view of user-logged portfolio sales. Each row is a genuine
 * `UserCollection` entry marked `isSold` (per-user logged sale) — not a
 * two-party marketplace ledger (no buyer/seller schema exists). Admins see
 * every user's sales because this route is behind `requireAdmin`; the auth
 * gate is the authorization boundary (RULE 5 user-scoping does not apply to
 * admin cross-user reads).
 */

import { prisma } from "@/lib/db";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";

export default async function AdminTransactionsPage() {
  const rows = await prisma.userCollection.findMany({
    where: { isSold: true },
    orderBy: [{ soldAt: "desc" }, { updatedAt: "desc" }],
    take: 100,
    select: {
      id: true,
      soldPrice: true,
      soldAt: true,
      updatedAt: true,
      user: { select: { id: true, name: true, email: true } },
      card: { select: { name: true } },
    },
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
          Recorded Sales
        </h1>
        <p className="dojo-body" style={{ marginTop: "6px" }}>
          User-logged portfolio sales.
        </p>
      </header>

      <div
        style={{
          background: "var(--color-dojo-card)",
          border: "1px solid var(--color-dojo-stroke)",
        }}
      >
        {rows.length === 0 ? (
          <div
            className="dojo-faint"
            style={{ padding: "48px 20px", textAlign: "center" }}
          >
            No recorded sales yet.
          </div>
        ) : (
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              tableLayout: "fixed",
            }}
          >
            <colgroup>
              <col style={{ width: "32%" }} />
              <col style={{ width: "40%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "12%" }} />
            </colgroup>
            <thead>
              <tr>
                <Th>User</Th>
                <Th>Card</Th>
                <Th align="right">Sale Price</Th>
                <Th align="right">Sold</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  style={{ borderTop: "1px solid var(--color-dojo-divider)" }}
                >
                  <Td>
                    <Party
                      name={r.user.name || r.user.email}
                      email={r.user.email}
                    />
                  </Td>
                  <Td>
                    <span
                      style={{
                        color: "var(--color-dojo-ink)",
                        fontSize: "13px",
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.card.name}
                    </span>
                  </Td>
                  <Td align="right">
                    <span
                      className="dojo-count-up"
                      style={{
                        color: "var(--color-dojo-gold)",
                        fontWeight: 700,
                        fontSize: "13px",
                      }}
                    >
                      {formatCurrency(r.soldPrice)}
                    </span>
                  </Td>
                  <Td align="right">
                    <span className="dojo-faint" style={{ fontSize: "12.5px" }}>
                      {formatDateTime(r.soldAt ?? r.updatedAt)}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      style={{
        textAlign: align,
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

function Td({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <td
      style={{
        padding: "14px 20px",
        textAlign: align,
        verticalAlign: "middle",
      }}
    >
      {children}
    </td>
  );
}

function Party({ name, email }: { name: string; email: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          color: "var(--color-dojo-ink)",
          fontWeight: 600,
          fontSize: "12.5px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </div>
      <div
        className="dojo-faint"
        style={{
          marginTop: "2px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {email}
      </div>
    </div>
  );
}
