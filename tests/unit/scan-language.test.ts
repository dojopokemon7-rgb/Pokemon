import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ScanLanguageSchema,
  SCAN_LANGUAGE_STORAGE_KEY,
  readScanLanguage,
  writeScanLanguage,
} from "@/lib/utils/scan-language";

afterEach(() => vi.unstubAllGlobals());

describe("ScanLanguageSchema", () => {
  it("accepts all|en|ja and defaults undefined to all", () => {
    expect(ScanLanguageSchema.parse("en")).toBe("en");
    expect(ScanLanguageSchema.parse("ja")).toBe("ja");
    expect(ScanLanguageSchema.parse("all")).toBe("all");
    expect(ScanLanguageSchema.parse(undefined)).toBe("all");
  });
  it("rejects anything else", () => {
    expect(ScanLanguageSchema.safeParse("fr").success).toBe(false);
    expect(ScanLanguageSchema.safeParse(1).success).toBe(false);
    expect(ScanLanguageSchema.safeParse(null).success).toBe(false);
  });
});

describe("read/writeScanLanguage", () => {
  it("round-trips through localStorage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    writeScanLanguage("ja");
    expect(store.get(SCAN_LANGUAGE_STORAGE_KEY)).toBe("ja");
    expect(readScanLanguage()).toBe("ja");
  });

  it("falls back to all for missing or corrupt values", () => {
    vi.stubGlobal("localStorage", { getItem: () => "klingon", setItem: () => {} });
    expect(readScanLanguage()).toBe("all");
  });

  it("is safe when localStorage throws", () => {
    const boom = () => {
      throw new Error("denied");
    };
    vi.stubGlobal("localStorage", { getItem: boom, setItem: boom });
    expect(readScanLanguage()).toBe("all");
    expect(() => writeScanLanguage("en")).not.toThrow();
  });
});
