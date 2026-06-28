/**
 * usePortfolio.js
 * Custom hook — fetches the demo user's portfolio from the API.
 */
import { useState, useEffect, useCallback } from 'react';

export function usePortfolio(userId = 'demo-user-001') {
  const [cards,   setCards]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [tick,    setTick]    = useState(0);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/portfolio/${userId}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => { setCards(data.cards || []); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, [userId, tick]);

  const refetch = useCallback(() => setTick(t => t + 1), []);

  return { cards, loading, error, refetch };
}

/**
 * verifyCard — POST /api/portfolio/verify
 * @param {{ userId, extractedName, extractedNumber }} payload
 * @returns {Promise<{ status, cardDetails?, suggestion? }>}
 */
export async function verifyCard(payload) {
  const res = await fetch('/api/portfolio/verify', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
