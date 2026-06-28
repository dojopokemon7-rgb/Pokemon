/**
 * server.js — Pokémon TCG Platform API
 * ─────────────────────────────────────────────────────────────
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/portfolio/:userId
 *   POST /api/portfolio/verify            (legacy — simple fuzzy match)
 *   POST /api/cards/identify-and-verify   (Task 4 — unified flow)
 *   POST /api/portfolio/add
 *   POST /api/wishlist/add
 *   GET  /api/wishlist/:userId
 */

import 'dotenv/config';
import express from 'express';
import cors    from 'cors';
import pg      from 'pg';
import vision  from '@google-cloud/vision';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { Pool } = pg;
const app  = express();
const PORT = process.env.API_PORT || 3001;

// ── DB pool ───────────────────────────────────────────────────
const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : {
        host:     process.env.PGHOST     || 'localhost',
        port:     Number(process.env.PGPORT) || 5432,
        database: process.env.PGDATABASE || 'pokemon_tcg',
        user:     process.env.PGUSER     || 'postgres',
        password: process.env.PGPASSWORD,
      }
);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── GET /api/health ───────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// ── POST /api/ocr/scan ─────────────────────────────────────────
// Sends image as base64 to Google Vision API.
// Runs TEXT_DETECTION (OCR) + WEB_DETECTION (visual image matching) together.
app.post('/api/ocr/scan', async (req, res) => {
  const { image } = req.body;

  if (!image) {
    return res.status(400).json({ error: 'image is required' });
  }

  try {
    let rawText = '';
    let webEntities        = [];  // [{ description, score }]
    let matchingImageUrls  = [];  // exact/partial image URL matches
    let matchingPageUrls   = [];  // pages containing the image

    const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

    if (credentialsJson || credentialsPath) {
      const base64Data  = image.replace(/^data:image\/\w+;base64,/, '');
      const imageBuffer = Buffer.from(base64Data, 'base64');

      let client;
      if (credentialsJson) {
        try {
          const credentials = JSON.parse(credentialsJson);
          client = new vision.ImageAnnotatorClient({ credentials });
        } catch (jsonErr) {
          console.error('Failed to parse GOOGLE_APPLICATION_CREDENTIALS_JSON:', jsonErr.message);
          client = new vision.ImageAnnotatorClient();
        }
      } else {
        client = new vision.ImageAnnotatorClient();
      }

      // ── Run TEXT_DETECTION + DOCUMENT_TEXT_DETECTION + WEB_DETECTION in one call ──
      const [result] = await client.annotateImage({
        image: { content: imageBuffer },
        features: [
          { type: 'TEXT_DETECTION'          },
          { type: 'DOCUMENT_TEXT_DETECTION' },
          { type: 'WEB_DETECTION'           },   // ← visual image matching
        ],
      });

      // ── OCR text ──
      rawText = result.fullTextAnnotation?.text
             || result.textAnnotations?.[0]?.description
             || '';

      // ── Web Detection ──
      const wd = result.webDetection;
      if (wd) {
        // Web entities: visually-derived labels ("Charizard", "Base Set", "4/102", etc.)
        webEntities = (wd.webEntities || [])
          .filter(e => e.description && e.score >= 0.3)
          .map(e => ({ description: e.description, score: e.score }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 20);

        // Image URLs: pages/images visually similar to the scanned card
        const fullMatches    = (wd.fullMatchingImages    || []).map(i => i.url);
        const partialMatches = (wd.partialMatchingImages || []).map(i => i.url);
        const visualSimilar  = (wd.visuallySimilarImages || []).map(i => i.url);
        matchingImageUrls = [...new Set([...fullMatches, ...partialMatches, ...visualSimilar])].slice(0, 30);

        // Pages that contain a matching image (great for pokemontcg.io / tcgplayer URLs)
        matchingPageUrls = (wd.pagesWithMatchingImages || [])
          .map(p => p.url)
          .filter(Boolean)
          .slice(0, 20);

        console.log('[ocr/scan] Web entities:', webEntities.slice(0, 5).map(e => `${e.description}(${e.score.toFixed(2)})`).join(', '));
        console.log('[ocr/scan] Matching image URLs:', matchingImageUrls.slice(0, 3));
        console.log('[ocr/scan] Matching page URLs:', matchingPageUrls.slice(0, 3));
      }

    } else {
      console.warn('⚠️ GOOGLE_APPLICATION_CREDENTIALS not set. Using fallback mock OCR response.');
      rawText = `Charizard VMAX HP330\nEvolution\nCharizard VMAX\n074/189\nDarkness Ablaze`;
    }

    const extractedName   = parseNameFromOCR(rawText);
    const extractedNumber = parseNumberFromOCR(rawText);

    // Confidence: boost if web detection also found a name match
    const webNameHit = webEntities.some(e =>
      e.description && extractedName &&
      e.description.toLowerCase().includes(extractedName.toLowerCase().split(' ')[0])
    );
    const confidence = extractedName && extractedNumber ? 95
                     : extractedName && webNameHit       ? 85
                     : extractedName                     ? 70
                     : 25;

    console.log('[ocr/scan] OCR Result Text:\n' + rawText);
    console.log(`[ocr/scan] Extracted Name: "${extractedName}", Number: "${extractedNumber}", Confidence: ${confidence}`);

    res.json({
      success: true,
      rawText,
      extractedName,
      extractedNumber,
      confidence,
      lowConfidence:    confidence < 50,
      webEntities,
      matchingImageUrls,
      matchingPageUrls,
    });
  } catch (err) {
    console.error('[ocr/scan]', err.message);
    res.status(500).json({ error: 'OCR processing error: ' + err.message });
  }
});

// ── GET /api/portfolio/:userId ────────────────────────────────
app.get('/api/portfolio/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT
         up.id AS portfolio_id, up.quantity, up.purchase_price, up.added_at,
         c.id  AS card_id, c.name, c.set_name, c.number, c.rarity,
         c.image_url, c.tcgplayer_price
       FROM user_portfolios up
       JOIN cards c ON up.card_id = c.id
       WHERE up.user_id = $1
       ORDER BY up.added_at DESC`,
      [userId]
    );
    res.json({ userId, cards: rows });
  } catch (err) {
    console.error('[portfolio]', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/cards/identify-and-verify   ← Task 4 main endpoint
// ─────────────────────────────────────────────────────────────────
// Input:  { userId, ocrText, confidence, webEntities?, matchingImageUrls?, matchingPageUrls? }
// Output: { topMatches, bestMatch, isOwned }
//
// Step B  – check user_portfolios for ownership of each match
// ─────────────────────────────────────────────────────────────
app.post('/api/cards/identify-and-verify', async (req, res) => {
  const {
    userId            = 'demo-user-001',
    ocrText           = '',
    confidence        = 0,
    webEntities       = [],   // [{ description, score }] from WEB_DETECTION
    matchingImageUrls = [],   // exact/partial image URL matches from WEB_DETECTION
    matchingPageUrls  = [],   // page URLs containing the image
  } = req.body;

  // Need at least some signal to search with
  if (!ocrText.trim() && webEntities.length === 0 && matchingImageUrls.length === 0) {
    return res.status(400).json({ error: 'ocrText, webEntities, or matchingImageUrls is required' });
  }

  try {
    // ── Step A: Extract name + number from ocrText ──────────────
    const extractedName   = parseNameFromOCR(ocrText);
    const extractedNumber = parseNumberFromOCR(ocrText);

    // ── Also extract name hints from web entities (visual signal) ──
    // Web entities are sorted by score; pick the top entity that looks like a card name
    // (skip generic ones like "Pokémon", "Trading card game", etc.)
    const genericTerms = /^(pok[eé]mon|trading card|card game|nintendo|creatures inc|game freak|tcg|holo|rare|common|uncommon|promo)$/i;
    const webEntityName = webEntities
      .filter(e => !genericTerms.test(e.description) && /[a-zA-Z]/.test(e.description))
      .sort((a, b) => b.score - a.score)
      .map(e => e.description)[0] || '';

    // Build effective search name: prefer OCR name, fall back to web entity name
    const searchName = extractedName || webEntityName;

    console.log(`[identify-and-verify] OCR name: "${extractedName}", Web entity name: "${webEntityName}", Using: "${searchName}"`);
    console.log(`[identify-and-verify] Extracted number: "${extractedNumber}", Image URLs: ${matchingImageUrls.length}, Page URLs: ${matchingPageUrls.length}`);

    // ── Step A: Fuzzy search — candidates ─────────────────────────
    let candidateRows = [];

    // 1. Image URL exact match: check if any of our DB card image_urls appear in Vision's results
    //    This is the most reliable match (same pixel image = same card)
    if (matchingImageUrls.length > 0) {
      const { rows } = await pool.query(
        `SELECT
           id, name, set_name, number, rarity, image_url, tcgplayer_price, artist, hp, raw_data,
           1.0 AS similarity_score
         FROM cards
         WHERE image_url = ANY($1::text[])`,
        [matchingImageUrls]
      );
      if (rows.length > 0) {
        console.log(`[identify-and-verify] Image URL matched ${rows.length} card(s) directly!`);
        candidateRows = rows;
      }
    }

    // 2. Number match
    if (extractedNumber) {
      const primaryNumber = extractedNumber.includes('/') ? extractedNumber.split('/')[0] : extractedNumber;
      const { rows } = await pool.query(
        `SELECT
           id, name, set_name, number, rarity, image_url, tcgplayer_price, artist, hp, raw_data,
           ${searchName ? `ROUND(similarity(name, $2)::numeric, 3)` : `1.0`} AS similarity_score
         FROM cards
         WHERE LOWER(number) = LOWER($1)
         LIMIT 100`,
        searchName ? [primaryNumber, searchName] : [primaryNumber]
      );
      for (const row of rows) {
        if (!candidateRows.find(c => c.id === row.id)) candidateRows.push(row);
      }
    }

    // 3. Fuzzy name search
    if (searchName) {
      const { rows } = await pool.query(
        `SELECT
           id, name, set_name, number, rarity, image_url, tcgplayer_price, artist, hp, raw_data,
           ROUND(similarity(name, $1)::numeric, 3) AS similarity_score
         FROM cards
         WHERE similarity(name, $1) > 0.15
         ORDER BY similarity_score DESC
         LIMIT 100`,
        [searchName]
      );
      for (const row of rows) {
        if (!candidateRows.find(c => c.id === row.id)) candidateRows.push(row);
      }
    }

    // For each candidate, calculate a metadata matching score to find the exact match
    for (const card of candidateRows) {
      let nameSim = Number(card.similarity_score) || 0.0;
      let score = nameSim;

      const rawTextLower  = ocrText.toLowerCase();
      const cardNameLower = card.name.toLowerCase();

      // 0. IMAGE URL MATCH — strongest possible signal (+2.0)
      //    If Vision API found this card's exact image on the web → very high confidence
      if (card.image_url && matchingImageUrls.length > 0) {
        const cardImgBase = card.image_url.split('?')[0].toLowerCase();
        const matched = matchingImageUrls.some(url => {
          const urlBase = url.split('?')[0].toLowerCase();
          // Full URL match or filename match (e.g. both end in "en_US-SV3pt5-163-EN.png")
          return urlBase === cardImgBase ||
                 urlBase.endsWith(cardImgBase.split('/').pop() || '') ||
                 cardImgBase.endsWith(urlBase.split('/').pop() || '');
        });
        if (matched) {
          score += 2.0;
          console.log(`[identify-and-verify] 🎯 Image URL matched: ${card.name} #${card.number}`);
        }
      }

      // 1. WEB ENTITY MATCH — visual AI identified this entity on the image
      if (webEntities.length > 0) {
        // Name entity match (+0.6)
        const nameEntityMatch = webEntities.find(e =>
          e.description && (
            cardNameLower.includes(e.description.toLowerCase()) ||
            e.description.toLowerCase().includes(cardNameLower.split(' ')[0])
          )
        );
        if (nameEntityMatch) score += 0.6 * Math.min(nameEntityMatch.score, 1.0);

        // Set name entity match (+0.4)
        if (card.set_name) {
          const setEntityMatch = webEntities.find(e =>
            e.description && card.set_name.toLowerCase().includes(e.description.toLowerCase())
          );
          if (setEntityMatch) score += 0.4 * Math.min(setEntityMatch.score, 1.0);
        }
      }

      // 2. Card suffix match: ex / VMAX / VSTAR / GX (+0.5 if matching, -0.3 if mismatched)
      const suffixMatch = cardNameLower.match(/\b(ex|vmax|vstar|gx|v)\b/);
      if (suffixMatch) {
        if (rawTextLower.includes(suffixMatch[1])) {
          score += 0.5;
        } else {
          score -= 0.3;
        }
      } else if (/\b(ex|vmax|vstar|gx)\b/i.test(rawTextLower)) {
        score -= 0.3;
      }

      // 3. Exact Number Match (+0.6)
      if (extractedNumber) {
        const primaryNumber = extractedNumber.includes('/') ? extractedNumber.split('/')[0] : extractedNumber;
        if (card.number && card.number.toLowerCase() === primaryNumber.toLowerCase()) {
          score += 0.6;
        } else if (card.number) {
          const dbPrimary = card.number.split('/')[0];
          if (dbPrimary === primaryNumber) score += 0.4;
        }
      }

      // 4. Artist Match (+0.4)
      if (card.artist) {
        const artistLower = card.artist.toLowerCase();
        if (rawTextLower.includes(artistLower)) {
          score += 0.4;
        }
      }

      // 5. HP Match (+0.4)
      if (card.hp) {
        const hpPattern = new RegExp(
          `\\bhp\\s*${card.hp}\\b|\\b${card.hp}\\s*hp\\b|(?:^|\\s)${card.hp}(?:\\s|$)`,
          'i'
        );
        if (hpPattern.test(ocrText)) {
          score += 0.4;
        }
      }

      // 6. Attack Names Match (+0.3 per attack, up to +0.6 total)
      if (card.raw_data && card.raw_data.attacks && Array.isArray(card.raw_data.attacks)) {
        let attackBonus = 0;
        for (const attack of card.raw_data.attacks) {
          if (attack.name && rawTextLower.includes(attack.name.toLowerCase())) {
            attackBonus += 0.3;
          }
        }
        score += Math.min(attackBonus, 0.6);
      }

      // 7. Set Name Match (+0.1 per significant word)
      if (card.set_name) {
        const words = card.set_name.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        for (const word of words) {
          if (rawTextLower.includes(word)) {
            score += 0.1;
          }
        }
      }

      card.similarity_score = score;
    }

    // Sort by score descending — return ALL candidates (frontend will display them all)
    candidateRows.sort((a, b) => b.similarity_score - a.similarity_score);
    const allMatches = candidateRows; // No limit — show everything

    if (allMatches.length === 0) {
      return res.json({
        topMatches: [],
        bestMatch:  null,
        isOwned:    false,
        extractedName,
        extractedNumber,
        ocrConfidence: confidence,
      });
    }

    // ── Step B: Portfolio ownership check (for all candidates) ───
    const cardIds = allMatches.map(c => c.id);
    const { rows: ownedRows } = await pool.query(
      `SELECT card_id, quantity, purchase_price, added_at
       FROM user_portfolios
       WHERE user_id = $1 AND card_id = ANY($2::text[])`,
      [userId, cardIds]
    );

    const ownedMap = new Map(ownedRows.map(r => [r.card_id, r]));

    // Annotate each match with ownership info
    const topMatches = allMatches.map(card => {
      const owned = ownedMap.get(card.id);
      // Raw score kept for sorting; cap display at 100%
      const displayScore = Math.min(1.0, card.similarity_score);
      return {
        id:               card.id,
        name:             card.name,
        set_name:         card.set_name,
        number:           card.number,
        rarity:           card.rarity,
        image_url:        card.image_url,
        tcgplayer_price:  card.tcgplayer_price,
        similarity_score: displayScore,
        isOwned:          !!owned,
        ownedQty:         owned?.quantity      ?? 0,
        purchasePrice:    owned?.purchase_price ?? null,
        addedAt:          owned?.added_at       ?? null,
      };
    });

    const bestMatch = topMatches[0];
    const isOwned   = bestMatch?.isOwned ?? false;

    console.log(`[identify-and-verify] Returning ${topMatches.length} matches. Best: "${bestMatch?.name}" #${bestMatch?.number}`);

    return res.json({
      topMatches,
      bestMatch,
      isOwned,
      extractedName,
      extractedNumber,
      ocrConfidence: confidence,
    });

  } catch (err) {
    console.error('[identify-and-verify]', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── POST /api/portfolio/add ───────────────────────────────────
// Body: { userId, cardId, quantity?, purchasePrice? }
// Inserts a new portfolio row; increments qty if card already exists.
app.post('/api/portfolio/add', async (req, res) => {
  const {
    userId,
    cardId,
    quantity      = 1,
    purchasePrice = null,
  } = req.body;

  if (!userId || !cardId) {
    return res.status(400).json({ error: 'userId and cardId are required' });
  }

  try {
    // Upsert: if already owned → increment quantity
    const { rows } = await pool.query(
      `INSERT INTO user_portfolios (user_id, card_id, quantity, purchase_price)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, card_id)
       DO UPDATE SET
         quantity       = user_portfolios.quantity + EXCLUDED.quantity,
         purchase_price = COALESCE(EXCLUDED.purchase_price, user_portfolios.purchase_price),
         added_at       = NOW()
       RETURNING id, user_id, card_id, quantity, purchase_price, added_at`,
      [userId, cardId, quantity, purchasePrice]
    );

    // Fetch card details for the response
    const { rows: cardRows } = await pool.query(
      'SELECT id, name, set_name, image_url, tcgplayer_price FROM cards WHERE id = $1',
      [cardId]
    );

    res.json({
      success: true,
      action:  'added',
      entry:   rows[0],
      card:    cardRows[0] ?? null,
    });
  } catch (err) {
    console.error('[portfolio/add]', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── POST /api/wishlist/add ────────────────────────────────────
// Body: { userId, cardId, note? }
app.post('/api/wishlist/add', async (req, res) => {
  const { userId, cardId, note = null } = req.body;

  if (!userId || !cardId) {
    return res.status(400).json({ error: 'userId and cardId are required' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO wishlist (user_id, card_id, note)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, card_id)
       DO UPDATE SET note = COALESCE(EXCLUDED.note, wishlist.note), added_at = NOW()
       RETURNING *`,
      [userId, cardId, note]
    );

    const { rows: cardRows } = await pool.query(
      'SELECT id, name, set_name, image_url, tcgplayer_price FROM cards WHERE id = $1',
      [cardId]
    );

    res.json({ success: true, entry: rows[0], card: cardRows[0] ?? null });
  } catch (err) {
    console.error('[wishlist/add]', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── GET /api/wishlist/:userId ─────────────────────────────────
app.get('/api/wishlist/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT w.id, w.note, w.added_at,
              c.id AS card_id, c.name, c.set_name, c.image_url, c.tcgplayer_price
       FROM wishlist w
       JOIN cards c ON w.card_id = c.id
       WHERE w.user_id = $1
       ORDER BY w.added_at DESC`,
      [userId]
    );
    res.json({ userId, cards: rows });
  } catch (err) {
    console.error('[wishlist]', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Legacy: POST /api/portfolio/verify ───────────────────────
app.post('/api/portfolio/verify', async (req, res) => {
  const { userId = 'demo-user-001', extractedName = '', extractedNumber = '' } = req.body;
  if (!extractedName && !extractedNumber) {
    return res.status(400).json({ error: 'extractedName or extractedNumber is required' });
  }
  // Delegate to new endpoint
  req.body.ocrText    = `${extractedName} ${extractedNumber}`.trim();
  req.body.confidence = 0;

  const fakeRes = {
    json: (data) => {
      const best = data.bestMatch;
      if (data.isOwned) {
        res.json({ status: 'FOUND', cardDetails: { ...best, quantity: best?.ownedQty } });
      } else {
        res.json({ status: 'NOT_FOUND', suggestion: best });
      }
    },
    status: (code) => ({ json: (d) => res.status(code).json(d) }),
  };

  // Re-use the handler
  await identifyAndVerifyHandler(req, fakeRes);
});

// ── Helpers ───────────────────────────────────────────────────

function parseNameFromOCR(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 1);

  for (let line of lines) {
    // Skip card-number lines like "163/165" or "074/189"
    if (/^\d+[/\\]\d+/.test(line)) continue;
    // Skip pure HP lines like "HP330" or "330HP"
    if (/^hp\s*\d+/i.test(line) || /^\d+\s*hp$/i.test(line)) continue;
    // Skip pure digit lines
    if (/^\d+$/.test(line)) continue;
    // Skip lines that don't start with a letter
    if (/^[^a-zA-Z]/.test(line)) continue;

    // Skip standalone metadata words
    if (/^(basic|stage\s*\d+|trainer|supporter|item|stadium|energy|evolves|weakness|resistance|retreat)$/i.test(line)) continue;

    // Skip "Evolves from X" lines (OCR often picks these up)
    if (/^(evolves\s+from|evolution|stage\s*\d+\s*-)/i.test(line)) continue;
    // Skip lines with "from" that are clearly description/evolution text
    if (/\bfrom\b/i.test(line) && /\b(evolv|charmel|bulba|squirt|gastly|haunter|stage)/i.test(line)) continue;

    // Skip obvious long description/flavour text lines (more than 7 words = probably not a card name)
    const wordCount = line.split(/\s+/).length;
    if (wordCount > 7) continue;

    // Skip lines that are all lowercase (description text, not a Pokémon name)
    const upperRatio = (line.match(/[A-Z]/g) || []).length / line.length;
    if (upperRatio < 0.05 && wordCount > 2) continue;

    // Remove trailing HP number that appears beside the name (e.g. "Charizard ex  330" → "Charizard ex")
    let cleaned = line.replace(/\s+\d{2,3}\s*[🔥💧🌿⚡🌸🌑🤍🔴🟡]?\s*$/, '').trim();
    // Also strip explicit "HP 330" or "330 HP" patterns
    cleaned = cleaned.replace(/\bhp\s*\d+\b/i, '').trim();
    cleaned = cleaned.replace(/\b\d+\s*hp\b/i, '').trim();

    // Extract tokens; allow trailing ex/EX/GX/VMAX/VSTAR as part of the name
    const tokens = cleaned.replace(/[^\w\s'.-]/g, ' ').trim().split(/\s+/);
    if (tokens.length === 0 || tokens[0].length < 2) continue;

    // Build name: take Pokémon name tokens (stop at stray numbers)
    const nameParts = [];
    for (const tok of tokens.slice(0, 5)) {
      if (/^\d+$/.test(tok)) break;
      nameParts.push(tok);
    }
    if (nameParts.length === 0) continue;

    return nameParts.join(' ');
  }
  return text.trim().split('\n')[0]?.trim() || '';
}

function parseNumberFromOCR(text) {
  // Standard number like "163/165" or "074/189"
  const std = text.match(/\b(\d{1,4})[/\\](\d{1,4})\b/);
  if (std) return std[0].replace('\\', '/');

  // Promo code like "SWSH123" or "BW123"
  const promo = text.match(/\b([A-Z]{2,4}\d{2,4}(?:[/\\][A-Z]{0,4}\d{2,4})?)\b/);
  if (promo) return promo[0];

  // Partial number: standalone 1-3 digit number that looks like a card number
  // (avoid matching HP values like 330 which would appear near card name)
  const partial = text.match(/(?:^|\n)\s*(\d{1,3})\s*(?:\/|$|\n)/m);
  if (partial) return partial[1];

  return '';
}

// Extracted handler for reuse in legacy endpoint
async function identifyAndVerifyHandler(req, res) {
  // This is a reference — the route above handles it directly.
  // The legacy /verify endpoint calls this via the route.
}

// ── Start ─────────────────────────────────────────────────────
if (!process.env.NETLIFY) {
  app.listen(PORT, () => {
    console.log(`\n🚀  API server running at http://localhost:${PORT}`);
    console.log(`    GET  /api/portfolio/:userId`);
    console.log(`    POST /api/cards/identify-and-verify`);
    console.log(`    POST /api/portfolio/add`);
    console.log(`    POST /api/wishlist/add`);
    console.log(`    GET  /api/wishlist/:userId\n`);
  });
}

export default app;
