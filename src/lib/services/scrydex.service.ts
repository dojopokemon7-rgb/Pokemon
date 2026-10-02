import { Game } from "@prisma/client";

export interface ScrydexPricePoint {
  date: string;
  marketPrice: number;
  lowPrice: number;
}

export interface ScrydexIdentifyResult {
  cardId: string;
  confidence: number;
  name: string;
  setCode: string;
}

const SCRYDEX_BASE_URL = "https://api.scrydex.com/v1";

function getHeaders(): HeadersInit {
  const key = process.env.SCRYDEX_API_KEY;
  const teamId = process.env.SCRYDEX_TEAM_ID;
  if (!key) throw new Error("SCRYDEX_API_KEY is not set.");
  
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json"
  };
  
  if (teamId) {
    headers["X-Team-ID"] = teamId;
  }
  
  return headers;
}

/**
 * Fetches 1-year historical pricing for a card across both games.
 */
export async function fetchPriceHistory(cardId: string, game: Game): Promise<ScrydexPricePoint[]> {
  try {
    const response = await fetch(`${SCRYDEX_BASE_URL}/prices/history/${game}/${cardId}?days=365`, {
      headers: getHeaders(),
    });
    
    if (!response.ok) {
      if (response.status === 404) return [];
      throw new Error(`Scrydex /history HTTP ${response.status}`);
    }
    
    const data = await response.json();
    return data.history as ScrydexPricePoint[];
  } catch (error) {
    console.error(`[scrydex] Error fetching price history for ${cardId}:`, error);
    return [];
  }
}

/**
 * Uses Scrydex Vision to identify a card from an image buffer or base64.
 * Base64 string should be passed here, stripped of its data URL prefix.
 */
export async function identifyCard(imageBase64: string): Promise<ScrydexIdentifyResult | null> {
  try {
    const response = await fetch(`${SCRYDEX_BASE_URL}/vision/identify`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ image: imageBase64 })
    });
    
    if (!response.ok) {
      console.warn(`[scrydex] Vision API returned ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    if (!data || !data.cardId) return null;
    
    return {
      cardId: data.cardId,
      confidence: data.confidence || 0,
      name: data.name || "",
      setCode: data.setCode || ""
    };
  } catch (error) {
    console.error(`[scrydex] Error identifying card:`, error);
    return null;
  }
}
