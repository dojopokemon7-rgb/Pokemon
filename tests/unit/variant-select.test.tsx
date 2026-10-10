import { it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { VariantSelect } from "@/app/(dashboard)/search/[id]/variant-select";
import { listVariants } from "@/lib/utils/raw-price";

const row = (variant: string) => ({ variant, type: "raw", condition: "NM", priceMarket: 1 });

it("renders nothing when the card has a single stored variant", () => {
  const rows = [row("normal")];
  expect(listVariants(rows).length).toBe(1);
  render(<VariantSelect variants={listVariants(rows)} value="normal" onChange={() => {}} />);
  expect(screen.queryByTestId("variant-select")).toBeNull();
});

it("renders a labelled selector when >1 variants are stored", () => {
  const rows = [row("normal"), row("reverseHolofoil")];
  render(<VariantSelect variants={listVariants(rows)} value="normal" onChange={() => {}} />);
  const sel = screen.getByTestId("variant-select") as HTMLSelectElement;
  expect(sel.getAttribute("aria-label")).toBe("Variant");
  expect(Array.from(sel.options).map((o) => o.text)).toEqual(["Normal", "Reverse Holofoil"]);
});
