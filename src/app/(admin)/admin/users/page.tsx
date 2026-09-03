/**
 * Admin — Users
 *
 * Server-rendered list of every user in the system, newest first.
 * No pagination yet — kept simple for the current scale. Swap to
 * cursor pagination when user count grows past a few thousand.
 */

import Link from "next/link";
import { prisma } from "@/lib/db";
import { getPortfolioValuesByUser } from "@/lib/services/admin-metrics";
import { formatCurrency, formatDate } from "@/lib/utils/format";

export default async function AdminUsersPage() {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      isAdmin: true,
      createdAt: true,
    },
  });

  // One aggregated SQL query — avoids an N+1 loop over each user.
  const portfolioValues = await getPortfolioValuesByUser(
    users.map((u) => u.id)
  );

  return (
    <div className="px-10 py-10">
      <header className="mb-8">
        <div
          className="dojo-step-label"
          style={{ fontSize: "10px", marginBottom: "8px" }}
        >
          Admin
        </div>
        <h1 className="dojo-heading" style={{ fontSize: "32px" }}>
          Users
        </h1>
        <p className="dojo-body" style={{ marginTop: "6px" }}>
          {users.length.toLocaleString()} total
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
            <col style={{ width: "36%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "16%" }} />
            <col style={{ width: "18%" }} />
            <col style={{ width: "18%" }} />
          </colgroup>
          <thead>
            <tr>
              <Th>User</Th>
              <Th>Role</Th>
              <Th>Joined</Th>
              <Th align="right">Portfolio Value</Th>
              <Th align="right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="dojo-faint"
                  style={{ padding: "40px 20px", textAlign: "center" }}
                >
                  No users yet.
                </td>
              </tr>
            ) : (
              users.map((u) => (
                <tr
                  key={u.id}
                  style={{
                    borderTop: "1px solid var(--color-dojo-divider)",
                  }}
                >
                  <Td>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "14px",
                      }}
                    >
                      <UserAvatar name={u.name} image={u.image} />
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            color: "var(--color-dojo-ink)",
                            fontWeight: 600,
                            fontSize: "13px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {u.name || "—"}
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
                          {u.email}
                        </div>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    {u.isAdmin ? (
                      <span
                        className="dojo-tag acc"
                        style={{ fontSize: "8.5px" }}
                      >
                        Admin
                      </span>
                    ) : (
                      <span className="dojo-tag" style={{ fontSize: "8.5px" }}>
                        User
                      </span>
                    )}
                  </Td>
                  <Td>
                    <span
                      style={{
                        color: "var(--color-dojo-body)",
                        fontSize: "12.5px",
                      }}
                    >
                      {formatDate(u.createdAt)}
                    </span>
                  </Td>
                  <Td align="right">
                    {(() => {
                      const value = portfolioValues.get(u.id);
                      const hasValue = value != null && value > 0;
                      return (
                        <span
                          className="dojo-count-up"
                          style={{
                            color: hasValue
                              ? "var(--color-dojo-gold)"
                              : "var(--color-dojo-faint)",
                            fontWeight: hasValue ? 700 : 400,
                            fontSize: "13px",
                          }}
                        >
                          {hasValue ? formatCurrency(value) : "—"}
                        </span>
                      );
                    })()}
                  </Td>
                  <Td align="right">
                    <Link
                      href={`/admin/users/${u.id}`}
                      className="dojo-btn dojo-btn-outline-sm"
                      style={{ display: "inline-flex" }}
                    >
                      View
                    </Link>
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
// Table primitives — kept local to this page. Extract into a shared
// component if a second admin table needs them beyond Users/Cards.
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
        padding: "16px 20px",
        textAlign: align,
        verticalAlign: "middle",
      }}
    >
      {children}
    </td>
  );
}

function UserAvatar({
  name,
  image,
}: {
  name: string | null;
  image: string | null;
}) {
  const initial = (name?.trim()?.[0] ?? "?").toUpperCase();

  if (image) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={image}
        alt=""
        style={{
          width: 36,
          height: 36,
          objectFit: "cover",
          border: "1px solid var(--color-dojo-stroke)",
          flex: "none",
        }}
      />
    );
  }

  return (
    <div
      aria-hidden
      style={{
        width: 36,
        height: 36,
        flex: "none",
        background: "var(--color-dojo-raised)",
        border: "1px solid var(--color-dojo-stroke)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-serif)",
        fontSize: "15px",
        color: "var(--color-dojo-gold)",
      }}
    >
      {initial}
    </div>
  );
}
