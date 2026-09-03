/**
 * Admin — Card Database
 *
 * Server-rendered list of cards, filterable via a `?q=` query string.
 * The search input is a plain HTML form (client component), submitting
 * to the same URL — no client JS needed for the filter itself. Inline
 * editing (price + image URL) is delegated to a client component that
 * uses React Query for the mutation.
 *
 * "Game" is derived from the parent set's `externalId` prefix
 * (`pokemon-*` vs `onepiece-*`). See prisma/seed.ts for the convention.
 */

import { prisma } from "@/lib/db";
import { formatCurrency } from "@/lib/utils/format";
import { CardSearchInput } from "./_components/CardSearchInput";
import { EditCardButton } from "./_components/EditCardButton";

const RESULT_LIMIT = 50;

function inferGame(setExternalId: string): "Pokémon" | "One Piece" | "—" {
  if (setExternalId.startsWith("pokemon-")) return "Pokémon";
  if (setExternalId.startsWith("onepiece-")) return "One Piece";
  return "—";
}

interface PageProps {
  searchParams: Promise<{ q?: string }>;
}

export default async function AdminCardsPage({ searchParams }: PageProps) {
  const { q } = await searchParams;
  const query = q?.trim() ?? "";

  const cards = await prisma.card.findMany({
    take: RESULT_LIMIT,
    orderBy: { name: "asc" },
    where: query
      ? {
          OR: [
            { name: { contains: query, mode: "insensitive" } },
            { set: { name: { contains: query, mode: "insensitive" } } },
          ],
        }
      : undefined,
    select: {
      id: true,
      name: true,
      imageUrl: true,
      marketPrice: true,
      set: { select: { name: true, externalId: true } },
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
          Card Database
        </h1>
        <p className="dojo-body" style={{ marginTop: "6px" }}>
          {query
            ? `Matching “${query}” — showing ${cards.length} of first ${RESULT_LIMIT}.`
            : `Showing first ${cards.length} cards (alphabetical).`}
        </p>
      </header>

      <div style={{ marginBottom: "18px", maxWidth: "420px" }}>
        <CardSearchInput initialQuery={query} />
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
            <col style={{ width: "42%" }} />
            <col style={{ width: "15%" }} />
            <col style={{ width: "18%" }} />
            <col style={{ width: "25%" }} />
          </colgroup>
          <thead>
            <tr>
              <Th>Card</Th>
              <Th>Game</Th>
              <Th align="right">Market Price</Th>
              <Th align="right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {cards.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="dojo-faint"
                  style={{ padding: "40px 20px", textAlign: "center" }}
                >
                  {query ? "No cards match this search." : "No cards seeded yet."}
                </td>
              </tr>
            ) : (
              cards.map((c) => {
                const game = inferGame(c.set.externalId);
                return (
                  <tr
                    key={c.id}
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
                        <CardThumb name={c.name} image={c.imageUrl} />
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
                            {c.name}
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
                            {c.set.name}
                          </div>
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <span
                        style={{
                          color: "var(--color-dojo-body)",
                          fontSize: "12.5px",
                        }}
                      >
                        {game}
                      </span>
                    </Td>
                    <Td align="right">
                      <span
                        className="dojo-count-up"
                        style={{
                          color:
                            c.marketPrice != null
                              ? "var(--color-dojo-gold)"
                              : "var(--color-dojo-faint)",
                          fontWeight: 700,
                          fontSize: "13px",
                        }}
                      >
                        {c.marketPrice != null
                          ? formatCurrency(c.marketPrice)
                          : "—"}
                      </span>
                    </Td>
                    <Td align="right">
                      <EditCardButton
                        card={{
                          id: c.id,
                          name: c.name,
                          marketPrice: c.marketPrice,
                          imageUrl: c.imageUrl,
                        }}
                      />
                    </Td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local table primitives
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

function CardThumb({
  name,
  image,
}: {
  name: string;
  image: string | null;
}) {
  if (image) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={image}
        alt={name}
        style={{
          width: 36,
          height: 50,
          objectFit: "cover",
          border: "1px solid var(--color-dojo-stroke)",
          background: "var(--color-dojo-raised)",
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
        height: 50,
        flex: "none",
        background: "var(--color-dojo-raised)",
        border: "1px solid var(--color-dojo-stroke)",
      }}
    />
  );
}
