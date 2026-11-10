import { describe, it, expect } from "vitest";
import { csvCell, csvRow, CSV_BOM } from "@/lib/utils/csv";

describe("csv", () => {
  it.each(["=1+1", "+x", "-x", "@x", "\tx", "\rx"])("neutralizes %j", (v) => {
    expect(csvCell(v).replace(/^"/, "").startsWith("'")).toBe(true);
  });
  it("quotes commas, quotes, newlines; leaves plain text", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(null)).toBe("");
    expect(csvCell(new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02T03:04:05.000Z");
  });
  it("rows end CRLF; BOM constant", () => {
    expect(csvRow(["a", "b"])).toBe("a,b\r\n");
    expect(CSV_BOM).toBe("\uFEFF");
  });
});
