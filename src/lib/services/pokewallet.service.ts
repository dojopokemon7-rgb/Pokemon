export interface PokeWalletPrice {
  marketPrice: number;
  lowPrice: number;
  midPrice: number;
  highPrice: number;
  updatedAt: Date;
}

const POKEWALLET_BASE_URL = "https://api.pokewallet.com/v1";

function getHeaders(): HeadersInit {
  const key = process.env.POKEWALLET_API_KEY;
  if (!key) {
    throw new Error("POKEWALLET_API_KEY is not set.");
  }
  return {
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json"
  };
}

/**
 * Fetches price for a specific Pokemon card from PokeWallet.
 * Uses caching to avoid rate limits.
 */
export async function fetchPokemonCardPrice(cardId: string): Promise<PokeWalletPrice | null> {
  try {
    const response = await fetch(`${POKEWALLET_BASE_URL}/prices/pokemon/${cardId}`, {
      headers: getHeaders(),
      next: { revalidate: 3600 } // Cache for 1 hour to help with 1,000 req/day limit
    });
    
    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`PokeWallet /prices/pokemon HTTP ${response.status}`);
    }
    
    const data = await response.json();
    return {
      marketPrice: data.marketPrice,
      lowPrice: data.lowPrice,
      midPrice: data.midPrice,
      highPrice: data.highPrice,
      updatedAt: new Date(data.updatedAt)
    };
  } catch (error) {
    console.error(`[pokewallet] Error fetching price for ${cardId}:`, error);
    return null;
  }
}

export async function fetchOnePieceSets(): Promise<any[]> {
  const response = await fetch(`${POKEWALLET_BASE_URL}/one-piece/sets`, {
    headers: getHeaders(),
    next: { revalidate: 86400 } // Cache sets for 24 hours
  });
  
  if (!response.ok) {
    throw new Error(`PokeWallet /one-piece/sets HTTP ${response.status}`);
  }
  
  const data = await response.json();
  return data.sets;
}

export async function fetchOnePieceCards(setId: string): Promise<any[]> {
  const response = await fetch(`${POKEWALLET_BASE_URL}/one-piece/sets/${setId}/cards`, {
    headers: getHeaders(),
    next: { revalidate: 3600 } 
  });
  
  if (!response.ok) {
    throw new Error(`PokeWallet /one-piece/sets/${setId}/cards HTTP ${response.status}`);
  }
  
  const data = await response.json();
  return data.cards;
}
