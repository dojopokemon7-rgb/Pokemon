import { z } from "zod";

/**
 * Scanner language context (client-safe). `Card` has no language column, so the
 * value is validated and echoed but NOT used to filter or restrict OCR.
 */
export const ScanLanguageSchema = z.enum(["all", "en", "ja"]).default("all");
export type ScanLanguage = z.infer<typeof ScanLanguageSchema>;

export const SCAN_LANGUAGE_STORAGE_KEY = "dojo:scan-language";

/** Stored language, or "all" when missing/corrupt/storage unavailable. */
export function readScanLanguage(): ScanLanguage {
  try {
    const r = ScanLanguageSchema.safeParse(localStorage.getItem(SCAN_LANGUAGE_STORAGE_KEY) ?? undefined);
    return r.success ? r.data : "all";
  } catch {
    return "all";
  }
}

export function writeScanLanguage(lang: ScanLanguage): void {
  try {
    localStorage.setItem(SCAN_LANGUAGE_STORAGE_KEY, lang);
  } catch {
    /* storage blocked (private mode / quota) — preference just isn't persisted */
  }
}
