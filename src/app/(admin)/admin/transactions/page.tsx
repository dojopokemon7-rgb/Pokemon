/**
 * Admin — Transactions / Sales
 *
 * Marketplace ledger. The backend for this ships in Week 3; until then
 * we render realistic mock rows drawn from real users and cards in the
 * database (so counterparties + card names look believable) plus a
 * banner making it clear the data is stubbed.
 *
 * TODO: When the Floor / Offer schema lands, replace `buildMockLedger`
 * with the real Prisma query. Suggested shape:
 *
 *   const rows = await prisma.transaction.findMany({
 *     take: 100,
 *     orderBy: { createdAt: "desc" },
 *     include: {
 *       card:   { select: { name: true } },
 *       buyer:  { select: { name: true, email: true } },
 *       seller: { select: { name: true, email: true } },
 *     },
 *   });
 */

import { prisma } from "@/lib/db";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";

type TxStatus = "COMPLETED" | "PENDING";

interface LedgerRow {
  id: string;
  createdAt: Date;
  buyer: { name: string; email: string };
  seller: { name: string; email: string };
  cardName: string;
  salePrice: number;
  status: TxStatus;
}

async function buildMockLedger(): Promise<LedgerRow[]> {
  // Pull a small pool of real users + priced cards from the DB. Mixing
  // real names into the mock ledger makes the demo look grounded without
  // fabricating identities.
  const [users, cards] = await Promise.all([
    prisma.user.findMany({
      take: 8,
      orderBy: { createdAt: "desc" },
      select: { name: true, email: true },
    }),
    prisma.card.findMany({
      take: 20,
      where: { marketPrice: { not: null } },
      orderBy: { marketPrice: "desc" },
      select: { name: true, marketPrice: true },
    }),
  ]);

  // Falls back to fully synthetic rows when the DB is empty (fresh env).
  const userPool =
    users.length >= 2
      ? users.map((u) => ({ name: u.name || u.email, email: u.email }))
      : [
          { name: "Alex Rivera", email: "alex@example.com" },
          { name: "Priya Shah", email: "priya@example.com" },
          { name: "Kenji Tanaka", email: "kenji@example.com" },
          { name: "Sam Cole", email: "sam@example.com" },
        ];
  const cardPool =
    cards.length > 0
      ? cards.map((c) => ({
          name: c.name,
          marketPrice: c.marketPrice ?? 0,
        }))
      : [
          { name: "Charizard 1st Edition", marketPrice: 12400 },
          { name: "Monkey D. Luffy OP01-001", marketPrice: 240 },
          { name: "Gengar V", marketPrice: 88 },
          { name: "Roronoa Zoro OP01-025", marketPrice: 190 },
        ];

  const HOUR = 60 * 60 * 1000;
  const now = Date.now();
  const rows: LedgerRow[] = [];

  for (let i = 0; i < 8; i++) {
    const buyer = userPool[i % userPool.length];
    // Ensure buyer !== seller
    const seller = userPool[(i + 1) % userPool.length];
    const card = cardPool[i % cardPool.length];
    // Add jitter to price so consecutive rows look distinct.
    const jitter = 0.85 + ((i * 37) % 30) / 100;
    rows.push({
      id: `mock-${i}`,
      createdAt: new Date(now - (i * 5 + 2) * HOUR),
      buyer,
      seller,
      cardName: card.name,
      salePrice: Math.round(card.marketPrice * jitter * 100) / 100,
      // First 6 are complete, last 2 pending — gives the UI both states.
      status: i < 6 ? "COMPLETED" : "PENDING",
    });
  }

  return rows;
}

export default async function AdminTransactionsPage() {
  const rows = await buildMockLedger();

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
          Transactions / Sales
        </h1>
        <p className="dojo-body" style={{ marginTop: "6px" }}>
          Marketplace ledger.
        </p>
      </header>

      <div
        role="note"
        style={{
          marginBottom: "18px",
          border: "1px solid var(--color-dojo-gold)",
          background: "rgba(233,180,59,0.08)",
          padding: "12px 16px",
          color: "var(--color-dojo-gold)",
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: "10.5px",
          letterSpacing: "0.14em",
          textTransform: "uppercase",
        }}
      >
        Demo data — awaiting marketplace backend (Week 3)
      </div>

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
            <col style={{ width: "20%" }} />
            <col style={{ width: "20%" }} />
            <col style={{ width: "20%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "10%" }} />
          </colgroup>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Buyer</Th>
              <Th>Seller</Th>
              <Th>Card</Th>
              <Th align="right">Sale Price</Th>
              <Th align="right">Status</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                style={{ borderTop: "1px solid var(--color-dojo-divider)" }}
              >
                <Td>
                  <span
                    className="dojo-faint"
                    style={{ fontSize: "12.5px" }}
                  >
                    {formatDateTime(r.createdAt)}
                  </span>
                </Td>
                <Td>
                  <Party name={r.buyer.name} email={r.buyer.email} />
                </Td>
                <Td>
                  <Party name={r.seller.name} email={r.seller.email} />
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
                    {r.cardName}
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
                    {formatCurrency(r.salePrice)}
                  </span>
                </Td>
                <Td align="right">
                  <StatusTag status={r.status} />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
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

function StatusTag({ status }: { status: TxStatus }) {
  const completed = status === "COMPLETED";
  return (
    <span
      style={{
        display: "inline-block",
        border: `1px solid ${
          completed ? "var(--color-dojo-jade)" : "var(--color-dojo-gold)"
        }`,
        color: completed
          ? "var(--color-dojo-jade)"
          : "var(--color-dojo-gold)",
        padding: "3px 8px",
        fontFamily: "var(--font-display)",
        fontWeight: 700,
        fontSize: "8.5px",
        letterSpacing: "0.14em",
        textTransform: "uppercase",
      }}
    >
      {completed ? "Completed" : "Pending"}
    </span>
  );
}
