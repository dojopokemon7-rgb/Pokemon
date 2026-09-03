/**
 * Admin — User Detail
 *
 * Deep view for a single client: header, financial summary, portfolio
 * table, and a recent-activity feed. All data fetching is server-side.
 *
 * The "Recent Activity" list is stubbed: it currently surfaces the
 * user's account created + collection add events derived from existing
 * timestamps. Once we ship a real event/audit stream, swap the
 * `deriveRecentActivity` call for a query against that store.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { getUserFinancials } from "@/lib/services/admin-metrics";
import { formatCurrency, formatDate, formatRelative } from "@/lib/utils/format";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function AdminUserDetailPage({ params }: PageProps) {
  const { id } = await params;

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      isAdmin: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!user) notFound();

  const [financials, collection] = await Promise.all([
    getUserFinancials(id),
    prisma.userCollection.findMany({
      where: { userId: id },
      orderBy: { addedAt: "desc" },
      select: {
        id: true,
        quantity: true,
        condition: true,
        purchasePrice: true,
        isFoil: true,
        addedAt: true,
        card: {
          select: {
            id: true,
            name: true,
            marketPrice: true,
            imageUrl: true,
            set: { select: { name: true } },
          },
        },
      },
    }),
  ]);

  const activity = deriveRecentActivity({
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    latestAdds: collection.slice(0, 5),
  });

  return (
    <div className="px-10 py-10">
      {/* --- Breadcrumb --- */}
      <div style={{ marginBottom: "18px" }}>
        <Link
          href="/admin/users"
          className="dojo-link"
          style={{ fontSize: "10px" }}
        >
          ← All Users
        </Link>
      </div>

      {/* --- Header --- */}
      <ClientHeader user={user} />

      {/* --- Financial summary --- */}
      <section
        className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4"
        style={{ marginTop: "28px" }}
      >
        <StatCard
          label="Portfolio Value"
          value={formatCurrency(financials.portfolioValue)}
          highlight
        />
        <StatCard
          label="Total Invested"
          value={
            financials.totalInvested == null
              ? "N/A"
              : formatCurrency(financials.totalInvested)
          }
          note={
            financials.totalInvested == null
              ? "No purchase price recorded"
              : undefined
          }
          highlight={financials.totalInvested != null}
        />
        <ProfitLossCard profitLoss={financials.profitLoss} />
        <StatCard
          label="Cards Owned"
          value={financials.cardsOwned.toLocaleString()}
          note="Includes duplicates"
        />
      </section>

      {/* --- Portfolio table --- */}
      <section style={{ marginTop: "36px" }}>
        <SectionHeading>Portfolio</SectionHeading>
        <PortfolioTable rows={collection} />
      </section>

      {/* --- Recent activity --- */}
      <section style={{ marginTop: "36px" }}>
        <SectionHeading>Recent Activity</SectionHeading>
        <ActivityFeed items={activity} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function ClientHeader({
  user,
}: {
  user: {
    name: string | null;
    email: string;
    image: string | null;
    isAdmin: boolean;
    createdAt: Date;
  };
}) {
  const initial = (user.name?.trim()?.[0] ?? user.email[0] ?? "?").toUpperCase();

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "20px",
        background: "var(--color-dojo-card)",
        border: "1px solid var(--color-dojo-stroke)",
        padding: "24px",
      }}
    >
      {user.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={user.image}
          alt=""
          style={{
            width: 72,
            height: 72,
            objectFit: "cover",
            border: "1px solid var(--color-dojo-stroke)",
            flex: "none",
          }}
        />
      ) : (
        <div
          aria-hidden
          style={{
            width: 72,
            height: 72,
            flex: "none",
            background: "var(--color-dojo-raised)",
            border: "1px solid var(--color-dojo-stroke)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "var(--font-serif)",
            fontSize: "28px",
            color: "var(--color-dojo-gold)",
          }}
        >
          {initial}
        </div>
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <h1
            className="dojo-heading"
            style={{ fontSize: "24px", lineHeight: 1.2 }}
          >
            {user.name || "Unnamed user"}
          </h1>
          {user.isAdmin ? (
            <span className="dojo-tag acc" style={{ fontSize: "8.5px" }}>
              Admin
            </span>
          ) : null}
        </div>
        <div className="dojo-body" style={{ marginTop: "4px" }}>
          {user.email}
        </div>
        <div className="dojo-faint" style={{ marginTop: "6px" }}>
          Joined {formatDate(user.createdAt)}
        </div>
      </div>

      <button
        type="button"
        className="dojo-btn dojo-btn-outline-sm"
        disabled
        title="Coming soon"
        style={{ flex: "none" }}
      >
        Suspend Account
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat cards (local — different sizing than the overview page)
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  note,
  highlight,
}: {
  label: string;
  value: string;
  note?: string;
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        background: "var(--color-dojo-card)",
        border: "1px solid var(--color-dojo-stroke)",
        padding: "20px 22px 24px",
      }}
    >
      <div
        className="dojo-step-label"
        style={{ fontSize: "10px", color: "var(--color-dojo-body)" }}
      >
        {label}
      </div>
      <div
        className="dojo-count-up"
        style={{
          marginTop: "12px",
          fontFamily: "var(--font-serif)",
          fontSize: "32px",
          lineHeight: 1.15,
          color: highlight
            ? "var(--color-dojo-gold)"
            : "var(--color-dojo-ink)",
        }}
      >
        {value}
      </div>
      {note ? (
        <div className="dojo-faint" style={{ marginTop: "8px" }}>
          {note}
        </div>
      ) : null}
    </div>
  );
}

function ProfitLossCard({ profitLoss }: { profitLoss: number | null }) {
  const unknown = profitLoss == null;
  const positive = !unknown && profitLoss >= 0;
  // Dojo tokens: jade #00A86B for gains, vermilion #E34234 for losses.
  const color = unknown
    ? "var(--color-dojo-ink)"
    : positive
      ? "var(--color-dojo-jade)"
      : "var(--color-dojo-vermilion)";

  const value = unknown
    ? "N/A"
    : `${positive ? "+" : "−"}${formatCurrency(Math.abs(profitLoss))}`;

  return (
    <div
      style={{
        background: "var(--color-dojo-card)",
        border: "1px solid var(--color-dojo-stroke)",
        padding: "20px 22px 24px",
      }}
    >
      <div
        className="dojo-step-label"
        style={{ fontSize: "10px", color: "var(--color-dojo-body)" }}
      >
        Profit / Loss
      </div>
      <div
        className="dojo-count-up"
        style={{
          marginTop: "12px",
          fontFamily: "var(--font-serif)",
          fontSize: "32px",
          lineHeight: 1.15,
          color,
        }}
      >
        {value}
      </div>
      {unknown ? (
        <div className="dojo-faint" style={{ marginTop: "8px" }}>
          Requires purchase prices
        </div>
      ) : null}
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="dojo-step-label"
      style={{
        fontSize: "10px",
        marginBottom: "12px",
        color: "var(--color-dojo-body)",
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Portfolio table
// ---------------------------------------------------------------------------

interface PortfolioRow {
  id: string;
  quantity: number;
  condition: string | null;
  purchasePrice: number | null;
  isFoil: boolean;
  addedAt: Date;
  card: {
    id: string;
    name: string;
    marketPrice: number | null;
    imageUrl: string | null;
    set: { name: string };
  };
}

function PortfolioTable({ rows }: { rows: readonly PortfolioRow[] }) {
  if (rows.length === 0) {
    return (
      <div
        style={{
          background: "var(--color-dojo-card)",
          border: "1px solid var(--color-dojo-stroke)",
          padding: "40px 20px",
          textAlign: "center",
        }}
        className="dojo-faint"
      >
        No cards tracked yet.
      </div>
    );
  }

  return (
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
          <col style={{ width: "38%" }} />
          <col style={{ width: "22%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "14%" }} />
          <col style={{ width: "14%" }} />
        </colgroup>
        <thead>
          <tr>
            <Th>Card</Th>
            <Th>Set</Th>
            <Th>Condition</Th>
            <Th align="right">Purchase</Th>
            <Th align="right">Market</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              style={{ borderTop: "1px solid var(--color-dojo-divider)" }}
            >
              <Td>
                <div
                  style={{ display: "flex", alignItems: "center", gap: "12px" }}
                >
                  {r.card.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={r.card.imageUrl}
                      alt={r.card.name}
                      style={{
                        width: 32,
                        height: 44,
                        objectFit: "cover",
                        border: "1px solid var(--color-dojo-stroke)",
                        flex: "none",
                      }}
                    />
                  ) : (
                    <div
                      aria-hidden
                      style={{
                        width: 32,
                        height: 44,
                        flex: "none",
                        background: "var(--color-dojo-raised)",
                        border: "1px solid var(--color-dojo-stroke)",
                      }}
                    />
                  )}
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
                      {r.card.name}
                      {r.quantity > 1 ? (
                        <span
                          className="dojo-faint"
                          style={{ marginLeft: "8px", fontWeight: 400 }}
                        >
                          ×{r.quantity}
                        </span>
                      ) : null}
                      {r.isFoil ? (
                        <span
                          className="dojo-tag acc"
                          style={{ marginLeft: "8px", fontSize: "8px" }}
                        >
                          Foil
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              </Td>
              <Td>
                <span
                  className="dojo-faint"
                  style={{ fontSize: "12.5px" }}
                >
                  {r.card.set.name}
                </span>
              </Td>
              <Td>
                <span
                  style={{
                    color: "var(--color-dojo-body)",
                    fontSize: "12.5px",
                  }}
                >
                  {r.condition ?? "—"}
                </span>
              </Td>
              <Td align="right">
                <span
                  className="dojo-count-up"
                  style={{
                    color: "var(--color-dojo-body)",
                    fontSize: "12.5px",
                  }}
                >
                  {formatCurrency(r.purchasePrice)}
                </span>
              </Td>
              <Td align="right">
                <span
                  className="dojo-count-up"
                  style={{
                    color:
                      r.card.marketPrice != null
                        ? "var(--color-dojo-gold)"
                        : "var(--color-dojo-faint)",
                    fontWeight: 700,
                    fontSize: "13px",
                  }}
                >
                  {formatCurrency(r.card.marketPrice)}
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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

// ---------------------------------------------------------------------------
// Recent-activity feed (stubbed)
// ---------------------------------------------------------------------------

interface ActivityItem {
  id: string;
  label: string;
  timestamp: Date;
}

function deriveRecentActivity({
  createdAt,
  updatedAt,
  latestAdds,
}: {
  createdAt: Date;
  updatedAt: Date;
  latestAdds: readonly PortfolioRow[];
}): ActivityItem[] {
  // TODO: replace with a query against a real event/audit stream once
  // one exists. For now we surface the concrete facts we already track:
  // account creation, most recent collection additions, and any profile
  // update reflected by `user.updatedAt`.
  const items: ActivityItem[] = [];

  for (const row of latestAdds) {
    items.push({
      id: `add-${row.id}`,
      label: `Added ${row.card.name}${
        row.quantity > 1 ? ` (×${row.quantity})` : ""
      } to portfolio`,
      timestamp: row.addedAt,
    });
  }

  if (updatedAt.getTime() !== createdAt.getTime()) {
    items.push({
      id: "profile-update",
      label: "Updated profile",
      timestamp: updatedAt,
    });
  }

  items.push({
    id: "account-created",
    label: "Account created",
    timestamp: createdAt,
  });

  return items
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, 8);
}

function ActivityFeed({ items }: { items: readonly ActivityItem[] }) {
  if (items.length === 0) {
    return (
      <div
        style={{
          background: "var(--color-dojo-card)",
          border: "1px solid var(--color-dojo-stroke)",
          padding: "24px",
        }}
        className="dojo-faint"
      >
        No activity recorded yet.
      </div>
    );
  }

  return (
    <ul
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        background: "var(--color-dojo-card)",
        border: "1px solid var(--color-dojo-stroke)",
      }}
    >
      {items.map((item, i) => (
        <li
          key={item.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "16px",
            padding: "14px 20px",
            borderTop:
              i === 0 ? "none" : "1px solid var(--color-dojo-divider)",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              background: "var(--color-dojo-gold)",
              flex: "none",
            }}
          />
          <span
            style={{
              color: "var(--color-dojo-ink)",
              fontSize: "13px",
              flex: 1,
              minWidth: 0,
            }}
          >
            {item.label}
          </span>
          <span
            className="dojo-faint"
            style={{ fontSize: "11px", flex: "none" }}
          >
            {formatRelative(item.timestamp)}
          </span>
        </li>
      ))}
    </ul>
  );
}
