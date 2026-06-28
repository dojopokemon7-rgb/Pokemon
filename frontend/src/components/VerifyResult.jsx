import React, { useEffect, useRef } from 'react';
import './VerifyResult.css';

/**
 * VerifyResult
 * Shows animated FOUND ✅ or NOT_FOUND ❌ state after portfolio verification.
 *
 * Props:
 *   result  — API response { status, cardDetails?, suggestion? }
 *   onReset — callback to clear the result and scan again
 *   onAddToWishlist — callback when user clicks "Add to Wishlist"
 */
export default function VerifyResult({ result, onReset, onAddToWishlist }) {
  const panelRef = useRef(null);

  // Scroll result into view immediately on mount
  useEffect(() => {
    panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  const isFound = result.status === 'FOUND';
  const card    = isFound ? result.cardDetails : result.suggestion;

  return (
    <div
      ref={panelRef}
      className={`vr-panel ${isFound ? 'vr-panel--found' : 'vr-panel--missing'}`}
      id="verify-result-panel"
      role="alert"
      aria-live="polite"
    >
      {/* ── Animated icon ── */}
      <div className="vr-icon-wrap">
        <span className="vr-icon" aria-hidden="true">
          {isFound ? '✅' : '❌'}
        </span>
        <div className={`vr-icon-ring ${isFound ? 'vr-icon-ring--found' : 'vr-icon-ring--missing'}`} />
      </div>

      {/* ── Main message ── */}
      <div className="vr-message">
        {isFound ? (
          <>
            <h3 className="vr-title vr-title--found" id="verify-result-title">
              Yes! You already own this card!
            </h3>
            <p className="vr-subtitle">
              <strong>{card?.name}</strong> is in your collection.
            </p>
          </>
        ) : (
          <>
            <h3 className="vr-title vr-title--missing" id="verify-result-title">
              You don't have this card yet.
            </h3>
            <p className="vr-subtitle">
              {card
                ? <>Closest match: <strong>{card.name}</strong> — would you like to add it?</>
                : <>This card wasn't found in your collection.</>}
            </p>
          </>
        )}
      </div>

      {/* ── Card detail chip ── */}
      {card && (
        <div className="vr-card-chip" id="verify-result-card-chip">
          {card.image_url && (
            <img
              src={card.image_url}
              alt={card.name}
              className="vr-chip-img"
            />
          )}
          <div className="vr-chip-info">
            <span className="vr-chip-name">{card.name}</span>
            <span className="vr-chip-meta">
              {card.set_name}
              {card.number ? ` · #${card.number}` : ''}
            </span>
            {card.rarity && (
              <span className="vr-chip-rarity">{card.rarity}</span>
            )}
            {isFound && card.quantity && (
              <span className="vr-chip-qty">
                You own: <strong>{card.quantity}×</strong>
              </span>
            )}
            {card.tcgplayer_price && (
              <span className="vr-chip-price">
                ~${Number(card.tcgplayer_price).toFixed(2)}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Actions ── */}
      <div className="vr-actions">
        {!isFound && (
          <button
            className="vr-btn vr-btn--wishlist"
            onClick={() => onAddToWishlist?.(card)}
            id="btn-add-wishlist"
          >
            ⭐ Add to Wishlist
          </button>
        )}
        <button
          className="vr-btn vr-btn--scan-again"
          onClick={onReset}
          id="btn-scan-again"
        >
          🔄 Scan Another Card
        </button>
      </div>
    </div>
  );
}
