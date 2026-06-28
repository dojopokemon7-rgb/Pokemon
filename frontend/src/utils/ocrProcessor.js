/**
 * ocrProcessor.js
 * Wraps Tesseract.js — initialises a persistent worker, runs OCR,
 * parses the raw text, and returns a structured result object.
 *
 * Strategy for real Pokémon card images:
 *  - Use PSM 11 (sparse text) — works best when text is scattered over artwork
 *  - Low confidence threshold (20%) — card art noise reduces Tesseract confidence
 *  - Return a `lowConfidence` flag so the UI can show a manual-input fallback
 */

import { createWorker } from 'tesseract.js';

let workerPromise = null;

/** Lazy-initialise a shared Tesseract worker (created once, reused). */
async function getWorker() {
  if (workerPromise) return workerPromise;

  workerPromise = (async () => {
    const worker = await createWorker('eng', 1, {
      logger: () => {},
    });

    await worker.setParameters({
      // PSM 11 = sparse text — finds text anywhere, doesn't assume layout
      tessedit_pageseg_mode: '11',
      preserve_interword_spaces: '1',
      // Whitelist characters likely to appear in card names/numbers
      tessedit_char_whitelist:
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 -/.',
    });

    return worker;
  })();

  return workerPromise;
}

/**
 * Run OCR on a pre-processed canvas element.
 *
 * Always returns a result object (never null).
 * The `lowConfidence` flag tells the UI to show a manual-input fallback.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} [confidenceThreshold=20]
 * @returns {Promise<{
 *   rawText: string,
 *   extractedName: string,
 *   extractedNumber: string,
 *   confidence: number,
 *   lowConfidence: boolean
 * }>}
 */
export async function runOCR(canvas, confidenceThreshold = 20) {
  const worker = await getWorker();
  const { data } = await worker.recognize(canvas);

  const confidence = data.confidence ?? 0;
  const rawText    = data.text || '';

  return {
    rawText,
    extractedName:   extractCardName(rawText),
    extractedNumber: extractCardNumber(rawText),
    confidence,
    lowConfidence:   confidence < confidenceThreshold,
  };
}

// ── Parsing helpers ────────────────────────────────────────────

/**
 * Card name heuristic:
 *  • The name is almost always on the first non-empty line of the card.
 *  • Skip HP lines, lone numbers, and card-number patterns.
 *  • Take at most 5 words to avoid flavour text.
 */
function extractCardName(text) {
  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 1);

  for (const line of lines) {
    if (/^\d+[/\\]\d+/.test(line)) continue;    // "074/189"
    if (/^hp\s*\d+/i.test(line))   continue;    // "HP 220"
    if (/^\d+$/.test(line))        continue;    // lone number
    if (/^[^a-zA-Z]/.test(line))   continue;    // starts with symbol/digit

    const words = line
      .replace(/[^\w\s'.\-]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(w => w.length > 0)
      .slice(0, 5);

    if (words.length > 0 && words[0].length > 1) {
      return words.join(' ');
    }
  }

  return '';
}

/**
 * Card number heuristic:
 *  • Standard pattern: NNN/NNN  (e.g. 074/189)
 *  • Promo pattern: SWSH001, TG01/TG30
 */
function extractCardNumber(text) {
  const standardMatch = text.match(/\b(\d{1,4})[/\\](\d{1,4})\b/);
  if (standardMatch) return standardMatch[0].replace('\\', '/');

  const promoMatch = text.match(/\b([A-Z]{2,4}\d{2,4}(?:[/\\][A-Z]{0,4}\d{2,4})?)\b/);
  if (promoMatch) return promoMatch[0];

  return '';
}
