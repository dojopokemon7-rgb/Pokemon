import { Game } from "@prisma/client";

export interface TCGdexSet {
  id: string;
  name: string;
  logo?: string;
  symbol?: string;
  cardCount: {
    total: number;
    official: number;
  };
  releaseDate?: string;
}

export interface TCGdexCard {
  id: string;
  localId: string;
  name: string;
  image?: string;
  illustrator?: string;
  rarity?: string;
  category: string;
  variants?: {
    normal?: boolean;
    reverse?: boolean;
    holo?: boolean;
    firstEdition?: boolean;
  };
  set: {
    id: string;
    name: string;
    logo?: string;
    symbol?: string;
  };
}

const TCGDEX_BASE_URL = "https://api.tcgdex.net/v2/en";

/**
 * Fetches all Pokémon sets from TCGdex.
 */
export async function fetchSets(): Promise<TCGdexSet[]> {
  const response = await fetch(`${TCGDEX_BASE_URL}/sets`);
  if (!response.ok) {
    throw new Error(`TCGdex /sets HTTP ${response.status}`);
  }
  const data = await response.json();
  return data as TCGdexSet[];
}

/**
 * Fetches all Pokémon cards in a specific set from TCGdex.
 */
export async function fetchCardsBySet(setId: string): Promise<TCGdexCard[]> {
  const response = await fetch(`${TCGDEX_BASE_URL}/sets/${setId}`);
  if (!response.ok) {
    throw new Error(`TCGdex /sets/${setId} HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.cards as TCGdexCard[];
}
