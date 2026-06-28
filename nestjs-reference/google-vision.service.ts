import { Injectable, BadRequestException } from '@nestjs/common';
import { ImageAnnotatorClient } from '@google-cloud/vision';

@Injectable()
export class GoogleVisionService {
  private client: ImageAnnotatorClient;

  constructor() {
    // The @google-cloud/vision client automatically resolves the JSON credentials file
    // via the GOOGLE_APPLICATION_CREDENTIALS environment variable.
    this.client = new ImageAnnotatorClient();
  }

  /**
   * Scans a base64 encoded image or raw buffer using Google Cloud Vision.
   * Uses both TEXT_DETECTION and DOCUMENT_TEXT_DETECTION features.
   */
  async scanImage(imagePayload: string | Buffer): Promise<{
    rawText: string;
    extractedName: string;
    extractedNumber: string;
    confidence: number;
    lowConfidence: boolean;
  }> {
    try {
      let imageBuffer: Buffer;

      if (Buffer.isBuffer(imagePayload)) {
        imageBuffer = imagePayload;
      } else {
        // Strip data URL scheme prefix if present
        const base64Data = imagePayload.replace(/^data:image\/\w+;base64,/, '');
        imageBuffer = Buffer.from(base64Data, 'base64');
      }

      // Configure request features as requested (TEXT_DETECTION and DOCUMENT_TEXT_DETECTION)
      const [result] = await this.client.annotateImage({
        image: { content: imageBuffer },
        features: [
          { type: 'TEXT_DETECTION' },
          { type: 'DOCUMENT_TEXT_DETECTION' },
        ],
      });

      const fullTextAnnotation = result.fullTextAnnotation;
      const textAnnotations = result.textAnnotations;

      // Extract full text from annotations
      const rawText = fullTextAnnotation?.text || (textAnnotations && textAnnotations[0]?.description) || '';

      if (!rawText.trim()) {
        return {
          rawText: '',
          extractedName: '',
          extractedNumber: '',
          confidence: 0,
          lowConfidence: true,
        };
      }

      // Parse name and number using specific heuristics
      const extractedName = this.extractCardName(rawText);
      const extractedNumber = this.extractCardNumber(rawText);

      // Determine confidence (e.g. based on presence of key card components)
      const confidence = extractedName && extractedNumber ? 95 : extractedName || extractedNumber ? 70 : 30;

      return {
        rawText,
        extractedName,
        extractedNumber,
        confidence,
        lowConfidence: confidence < 50,
      };
    } catch (error) {
      throw new BadRequestException(`Google Cloud Vision API failed: ${error.message}`);
    }
  }

  /**
   * Filters the text blocks to find the card name.
   * In Google Vision, the text at the top of the card (usually the name) is returned first.
   * We filter out lines starting with numbers, stage, HP, or symbols, and take the first valid line.
   */
  private extractCardName(text: string): string {
    const lines = text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 1);

    for (let line of lines) {
      // Skip lines matching standard card numbers (e.g., 074/189)
      if (/\d+([/\\])\d+/.test(line)) continue;
      // Skip HP lines (e.g., "220 HP", "HP 220")
      if (/^hp\s*\d+/i.test(line) || /\d+\s*hp/i.test(line)) continue;
      // Skip lone numbers
      if (/^\d+$/.test(line)) continue;
      // Skip stage definitions (e.g., "BASIC", "STAGE 1", "STAGE 2", "VMAX", "VSTAR", etc.)
      if (/^(basic|stage\s*\d+|mega|vmax|vstar|ex|gx|trainer|supporter|item|stadium|energy)$/i.test(line)) continue;
      // Skip lines starting with special non-alphabetic chars (noise)
      if (/^[^a-zA-Z]/.test(line)) continue;

      // Clean the line (strip HP info inline if present, keep alphanumeric, space, dot, hyphen, single quotes)
      let cleaned = line
        .replace(/\bhp\s*\d+\b/i, '')
        .replace(/\b\d+\s*hp\b/i, '')
        .replace(/[^\w\s'.\-]/g, ' ')
        .trim();

      // Split into words, take first 5 words max to avoid long flavor/rule text
      const words = cleaned.split(/\s+/).slice(0, 5);
      if (words.length > 0 && words[0].length > 1) {
        return words.join(' ');
      }
    }

    return '';
  }

  /**
   * Identifies card numbers matching patterns:
   * - standard: NNN/NNN (e.g. 074/189)
   * - promo/alternative: SWSH001, TG01/TG30
   */
  private extractCardNumber(text: string): string {
    // 1. Standard pattern: e.g. 074/189
    const stdMatch = text.match(/\b(\d{1,4})[/\\](\d{1,4})\b/);
    if (stdMatch) {
      return stdMatch[0].replace('\\', '/');
    }

    // 2. Alternative patterns: Trainer Gallery (TG01/TG30) or Promos (SWSH001, SV001)
    const altMatch = text.match(/\b([A-Z]{2,4}\d{2,4}(?:[/\\][A-Z]{0,4}\d{2,4})?)\b/);
    if (altMatch) {
      return altMatch[0];
    }

    return '';
  }
}
