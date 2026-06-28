import React, { useState, useEffect, useRef } from 'react';
import './VerificationResult.css';

const DEMO_USER_ID = 'demo-user-001';

/**
 * VerificationResult — Task 4 component
 * ──────────────────────────────────────
 * Displays the full identify-and-verify response:
 *
 *  ✅ IN COLLECTION  — green badge, market value, quantity owned
 *  ➕ NOT IN COLLECTION — blue badge, Add to Portfolio + Add to Wishlist
 *
 * Shows top 3 fuzzy-matched candidates as a selectable carousel.
 *
 * Props:
 *   data       — response from POST /api/cards/identify-and-verify
 *   onReset    — callback to scan again
 *   onPortfolioAdd — callback after successful add (to refresh portfolio)
 */
export default function VerificationResult({ data, onReset, onPortfolioAdd }) {
  const [selected,    setSelected]    = useState(0);        // index into topMatches
  const [actionState, setActionState] = useState('idle');   // idle|adding|added|wishlisted|error
  const [actionMsg,   setActionMsg]   = useState('');
  const panelRef = useRef(null);

  useEffect(() => {
    panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, []);

  if (!data) return null;

  const { topMatches = [], isOwned, extractedName, ocrConfidence } = data;
  const card    = topMatches[selected] ?? data.bestMatch;
  const ownedBy = card?.isOwned ?? isOwned;

  // ── Actions ─────────────────────────────────────────────────

  const addToPortfolio = async () => {
    if (!card) return;
    setActionState('adding');
    try {
      const res = await fetch('/api/portfolio/add', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: DEMO_USER_ID, cardId: card.id, quantity: 1 }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setActionState('added');
      setActionMsg(`✅ "${card.name}" added to your portfolio!`);
      onPortfolioAdd?.(json); // triggers refetch in UserProfile
    } catch (err) {
      setActionState('error');
      setActionMsg(`Failed: ${err.message}`);
    }
  };

  const addToWishlist = async () => {
    if (!card) return;
    setActionState('adding');
    try {
      const res = await fetch('/api/wishlist/add', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: DEMO_USER_ID, cardId: card.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setActionState('wishlisted');
      setActionMsg(`⭐ "${card.name}" added to your wishlist!`);
    } catch (err) {
      setActionState('error');
      setActionMsg(`Failed: ${err.message}`);
    }
  };

  // ── Render ───────────────────────────────────────────────────

  return (
    <div ref={panelRef} className="vr2-root" id="verification-result">

      {/* ── Status badge ── */}
      <div className={`vr2-badge-row ${ownedBy ? 'vr2-badge-row--owned' : 'vr2-badge-row--new'}`}>
        <div className={`vr2-badge ${ownedBy ? 'vr2-badge--owned' : 'vr2-badge--new'}`}>
          {ownedBy ? '✅ In Collection' : '➕ Not in Collection'}
        </div>
        {ocrConfidence > 0 && (
          <span className="vr2-confidence">
            OCR {ocrConfidence.toFixed(0)}% confidence
          </span>
        )}
        {extractedName && (
          <span className="vr2-ocr-name">Scanned: "<strong>{extractedName}</strong>"</span>
        )}
      </div>

      {/* ── Main message ── */}
      <div className={`vr2-headline ${ownedBy ? 'vr2-headline--owned' : 'vr2-headline--new'}`}>
        {ownedBy ? (
          <>
            <span className="vr2-headline-icon">🎉</span>
            <div>
              <h3 className="vr2-headline-title">You already have this card!</h3>
              <p className="vr2-headline-sub">
                You own <strong>{card?.ownedQty ?? 1}×</strong> {card?.name} in your collection.
              </p>
            </div>
          </>
        ) : (
          <>
            <span className="vr2-headline-icon">🔍</span>
            <div>
              <h3 className="vr2-headline-title">New card discovered!</h3>
              <p className="vr2-headline-sub">
                This card isn't in your collection yet. Add it or save it for later.
              </p>
            </div>
          </>
        )}
      </div>

      {/* ── All matches picker ── */}
      {topMatches.length > 0 && (
        <div className="vr2-matches">
          <div className="vr2-matches-header">
            <p className="vr2-matches-label">
              🃏 {topMatches.length} variant{topMatches.length !== 1 ? 's' : ''} found — pick your card
            </p>
            {topMatches.length > 6 && (
              <span className="vr2-matches-hint">← scroll →</span>
            )}
          </div>
          <div className="vr2-matches-row">
            {topMatches.map((match, i) => (
              <button
                key={match.id}
                className={`vr2-match-chip ${i === selected ? 'vr2-match-chip--active' : ''} ${match.isOwned ? 'vr2-match-chip--owned' : ''}`}
                onClick={() => { setSelected(i); setActionState('idle'); setActionMsg(''); }}
                id={`match-chip-${i}`}
                title={`${match.name} · ${match.set_name} · #${match.number}`}
              >
                {/* Thumbnail */}
                <div className="vr2-chip-thumb-wrap">
                  {match.image_url
                    ? <img src={match.image_url} alt={match.name} className="vr2-chip-thumb" loading="lazy" />
                    : <div className="vr2-chip-thumb-fallback">🃏</div>
                  }
                  {i === selected && <div className="vr2-chip-selected-ring" />}
                  {match.isOwned && (
                    <span className="vr2-chip-owned-badge">✓ Owned</span>
                  )}
                </div>
                {/* Text info */}
                <div className="vr2-chip-meta">
                  <span className="vr2-chip-name">{match.name}</span>
                  <span className="vr2-chip-set">
                    {match.set_name}{match.number ? ` · #${match.number}` : ''}
                  </span>
                  <span className="vr2-chip-score">
                    {(Number(match.similarity_score) * 100).toFixed(0)}%
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Selected card detail ── */}
      {card && (
        <div className="vr2-card-detail" id="selected-card-detail">
          <div className="vr2-card-img-wrap">
            {card.image_url ? (
              <img src={card.image_url} alt={card.name} className="vr2-card-img" />
            ) : (
              <div className="vr2-card-img-fallback">🃏</div>
            )}
            {ownedBy && (
              <div className="vr2-card-owned-overlay">
                <span>✅ Owned</span>
              </div>
            )}
          </div>

          <div className="vr2-card-info">
            <h4 className="vr2-card-name">{card.name}</h4>
            <p className="vr2-card-set">{card.set_name}{card.number ? ` · #${card.number}` : ''}</p>
            {card.rarity && <span className="vr2-card-rarity">{card.rarity}</span>}

            <div className="vr2-card-stats">
              {card.tcgplayer_price && (
                <div className="vr2-stat">
                  <span className="vr2-stat-label">Market Price</span>
                  <span className="vr2-stat-value vr2-stat-value--price">
                    ${Number(card.tcgplayer_price).toFixed(2)}
                  </span>
                </div>
              )}
              {ownedBy && card.purchasePrice && (
                <div className="vr2-stat">
                  <span className="vr2-stat-label">You Paid</span>
                  <span className="vr2-stat-value">
                    ${Number(card.purchasePrice).toFixed(2)}
                  </span>
                </div>
              )}
              {ownedBy && (
                <div className="vr2-stat">
                  <span className="vr2-stat-label">You Own</span>
                  <span className="vr2-stat-value vr2-stat-value--qty">
                    {card.ownedQty}×
                  </span>
                </div>
              )}
              <div className="vr2-stat">
                <span className="vr2-stat-label">Match</span>
                <span className="vr2-stat-value">
                  {(Number(card.similarity_score) * 100).toFixed(0)}%
                </span>
              </div>
            </div>

            {/* ── Action feedback ── */}
            {actionMsg && (
              <div className={`vr2-action-msg ${actionState === 'error' ? 'vr2-action-msg--error' : 'vr2-action-msg--ok'}`}>
                {actionMsg}
              </div>
            )}

            {/* ── Action buttons (not owned only) ── */}
            {!ownedBy && actionState !== 'added' && actionState !== 'wishlisted' && (
              <div className="vr2-actions">
                <button
                  className="vr2-btn vr2-btn--add"
                  onClick={addToPortfolio}
                  disabled={actionState === 'adding'}
                  id="btn-add-portfolio"
                >
                  {actionState === 'adding' ? '⏳ Adding…' : '➕ Add to Portfolio'}
                </button>
                <button
                  className="vr2-btn vr2-btn--wish"
                  onClick={addToWishlist}
                  disabled={actionState === 'adding'}
                  id="btn-add-wishlist"
                >
                  ⭐ Add to Wishlist
                </button>
              </div>
            )}

            {/* ── Already added states ── */}
            {(actionState === 'added' || ownedBy) && (
              <div className="vr2-in-collection-banner">
                ✅ In your collection
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── No match ── */}
      {topMatches.length === 0 && (
        <div className="vr2-no-match" id="no-match-panel">
          <span>🔎</span>
          <p>No cards matched "<strong>{extractedName}</strong>" in the database.</p>
          <p className="vr2-no-match-hint">Try adjusting the name or scanning again.</p>
        </div>
      )}

      {/* ── Scan again ── */}
      <button className="vr2-btn vr2-btn--reset" onClick={onReset} id="btn-scan-again">
        🔄 Scan Another Card
      </button>
    </div>
  );
}
