import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";

/**
 * Audit 02 F-S (RULE 2) — the trending tile and the search-result tile MUST
 * render the REAL weekly delta and render NOTHING when there is no real
 * change. The old tiles invented a +/-% from a char-code hash of card.id;
 * this pins that the hash is gone: a card with a null delta shows no ▲/▼ and
 * no "%" at all, and a real value renders with the correct sign + color.
 *
 * The tiles are simple <Link>-wrapped presentational components. next/link
 * renders a plain <a> in jsdom with no router provider, so no navigation mock
 * is needed (same as dashboard-collection-cards.test.tsx).
 */

import { TrendCardTile, CardTile } from "@/app/(dashboard)/search/card-tiles";

const noop = () => {};

function renderTrend(card: Parameters<typeof TrendCardTile>[0]["card"]) {
  return render(
    createElement(TrendCardTile, {
      card,
      game: "pokemon",
      tracked: false,
      onToggleTrack: noop,
      selected: false,
      onToggleSelect: noop,
      onOpen: noop,
      onPrefetch: noop,
    })
  );
}

function renderCard(card: Parameters<typeof CardTile>[0]["card"]) {
  return render(
    createElement(CardTile, {
      card,
      game: "pokemon",
      onAdd: noop,
      tracked: false,
      onToggleTrack: noop,
      onOpen: noop,
      onPrefetch: noop,
    })
  );
}

// A char-code hash of this id previously produced a non-zero fake delta, so
// "renders nothing" below proves the fabricated path is really gone.
const HASHY_ID = "base1-4";

describe("TrendCardTile delta (real value only)", () => {
  it("renders ▲ + real positive delta in jade", () => {
    const { container } = renderTrend({
      id: HASHY_ID, externalId: HASHY_ID, name: "Charizard", setImage: "Base",
      imageUrl: null, price: 100, delta: "+5.2%", up: true,
    });
    expect(screen.getByText(/▲/)).toBeTruthy();
    expect(screen.getByText(/\+5\.2%/)).toBeTruthy();
    expect(container.innerHTML).toContain("var(--color-dojo-jade)");
  });

  it("renders ▼ + real negative delta in vermilion", () => {
    const { container } = renderTrend({
      id: HASHY_ID, externalId: HASHY_ID, name: "Charizard", setImage: "Base",
      imageUrl: null, price: 100, delta: "-3.0%", up: false,
    });
    expect(screen.getByText(/▼/)).toBeTruthy();
    expect(screen.getByText(/-3\.0%/)).toBeTruthy();
    expect(container.innerHTML).toContain("var(--color-dojo-vermilion)");
  });

  it("renders NO movement indicator when the real delta is null (no fabrication)", () => {
    const { container } = renderTrend({
      id: HASHY_ID, externalId: HASHY_ID, name: "Charizard", setImage: "Base",
      imageUrl: null, price: 100, delta: null, up: null,
    });
    expect(container.textContent).not.toMatch(/[▲▼]/);
    expect(container.textContent).not.toMatch(/%/);
  });
});

describe("CardTile delta (real value only)", () => {
  it("renders ▲ + real positive delta in jade", () => {
    const { container } = renderCard({
      id: HASHY_ID, name: "Charizard", marketPrice: 100, weeklyChangePct: 5.2,
    });
    expect(screen.getByText(/▲/)).toBeTruthy();
    expect(screen.getByText(/\+5\.2%/)).toBeTruthy();
    expect(container.innerHTML).toContain("var(--color-dojo-jade)");
  });

  it("renders ▼ + real negative delta in vermilion", () => {
    const { container } = renderCard({
      id: HASHY_ID, name: "Charizard", marketPrice: 100, weeklyChangePct: -3,
    });
    expect(screen.getByText(/▼/)).toBeTruthy();
    expect(screen.getByText(/-3\.0%/)).toBeTruthy();
    expect(container.innerHTML).toContain("var(--color-dojo-vermilion)");
  });

  it("renders NO movement indicator when weeklyChangePct is null (no fabrication)", () => {
    // Previously this id hashed to a fake percentage; now null → nothing.
    const { container } = renderCard({
      id: HASHY_ID, name: "Charizard", marketPrice: 100, weeklyChangePct: null,
    });
    expect(container.textContent).not.toMatch(/[▲▼]/);
    expect(container.textContent).not.toMatch(/%/);
  });
});
