import React, { useState } from 'react';
import CardScanner        from './CardScanner';
import VerificationResult from './VerificationResult';
import { usePortfolio }   from '../hooks/usePortfolio';
import './UserProfile.css';

const DEMO_USER = {
  id:     'demo-user-001',
  name:   'Demo Collector',
  email:  'demo@tcgplatform.com',
  avatar: '🧢',
};

/**
 * UserProfile
 * ───────────────────────────────────────────────────
 * • Fetches the demo user's portfolio from the API
 * • Renders cards in a responsive grid
 * • Integrates CardScanner for "Scan to Verify" flow
 * • Shows VerifyResult with Found / Not-Found state
 */
export default function UserProfile() {
  const { cards, loading, error, refetch } = usePortfolio(DEMO_USER.id);

  // Verification state
  const [verifying,    setVerifying]    = useState(false);
  const [verifyResult, setVerifyResult] = useState(null);   // full API response
  const [verifyError,  setVerifyError]  = useState('');
  const [scannerOpen,  setScannerOpen]  = useState(false);

  // ── Handlers ─────────────────────────────────────

  const handleScanResult = async (ocrResult) => {
    setVerifying(true);
    setVerifyResult(null);
    setVerifyError('');

    try {
      const res = await fetch('/api/cards/identify-and-verify', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId:            DEMO_USER.id,
          ocrText:           ocrResult.rawText || '',
          confidence:        ocrResult.confidence,
          webEntities:       ocrResult.webEntities       || [],
          matchingImageUrls: ocrResult.matchingImageUrls || [],
          matchingPageUrls:  ocrResult.matchingPageUrls  || [],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setVerifyResult(data);
    } catch (err) {
      setVerifyError(`Verification failed: ${err.message}`);
    } finally {
      setVerifying(false);
    }
  };

  const handleReset = () => {
    setVerifyResult(null);
    setVerifyError('');
    setScannerOpen(true);
  };

  const handlePortfolioAdd = () => {
    refetch(); // re-fetch portfolio so the grid updates immediately
  };

  // ── Render ────────────────────────────────────────

  return (
    <div className="up-root">

      {/* ── Profile header ── */}
      <div className="up-profile-header">
        <div className="up-avatar">{DEMO_USER.avatar}</div>
        <div className="up-profile-info">
          <h2 className="up-name">{DEMO_USER.name}</h2>
          <p className="up-email">{DEMO_USER.email}</p>
          {!loading && (
            <div className="up-stats">
              <span className="up-stat">
                <strong>{cards.length}</strong> cards
              </span>
              <span className="up-stat-sep">·</span>
              <span className="up-stat">
                <strong>
                  ${cards.reduce((sum, c) =>
                    sum + (Number(c.purchase_price) || 0) * (c.quantity || 1), 0
                  ).toFixed(2)}
                </strong> invested
              </span>
            </div>
          )}
        </div>

        {/* Scan to Verify button */}
        <button
          className={`up-scan-btn ${scannerOpen ? 'up-scan-btn--active' : ''}`}
          onClick={() => { setScannerOpen(v => !v); setVerifyResult(null); setVerifyError(''); }}
          id="btn-toggle-scanner"
        >
          {scannerOpen ? '✕ Close Scanner' : '📷 Scan to Verify'}
        </button>
      </div>

      {/* ── Scanner panel ── */}
      {scannerOpen && (
        <div className="up-scanner-panel" id="scanner-panel">
          <div className="up-scanner-header">
            <span className="up-scanner-title">🔍 Scan a Card to Verify Ownership</span>
            <span className="up-scanner-hint">
              Point your camera at a card — we'll check if it's in your collection
            </span>
          </div>

          {verifying ? (
            <div className="up-verifying">
              <div className="up-spinner" />
              <span>Checking your collection…</span>
            </div>
          ) : !verifyResult ? (
            <CardScanner
              onResult={handleScanResult}
              onError={(msg) => { setVerifyError(msg); setVerifying(false); }}
            />
          ) : (
            <VerificationResult
              data={verifyResult}
              onReset={handleReset}
              onPortfolioAdd={handlePortfolioAdd}
            />
          )}

          {verifyError && !verifyResult && (
            <div className="up-verify-error" id="verify-error">
              ⚠️ {verifyError}
            </div>
          )}
        </div>
      )}

      {/* Wishlist is now managed inside VerificationResult */}

      {/* ── Portfolio grid ── */}
      <div className="up-section-header">
        <h3 className="up-section-title">My Collection</h3>
        <span className="up-section-badge">{cards.length} cards</span>
      </div>

      {loading && (
        <div className="up-loading" id="portfolio-loading">
          <div className="up-spinner" />
          <span>Loading your collection…</span>
        </div>
      )}

      {error && (
        <div className="up-error" id="portfolio-error">
          ⚠️ Could not load portfolio: {error}
          <br />
          <small>Make sure the API server is running (<code>npm run server</code>)</small>
        </div>
      )}

      {!loading && !error && (
        <div className="up-grid" id="portfolio-grid">
          {cards.map((card) => (
            <CardTile key={card.portfolio_id} card={card} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Card tile sub-component ────────────────────────────────────

function CardTile({ card }) {
  const [imgError, setImgError] = useState(false);
  const [hovered,  setHovered]  = useState(false);

  return (
    <div
      className={`up-card-tile ${hovered ? 'up-card-tile--hovered' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      id={`card-tile-${card.card_id}`}
      role="article"
      aria-label={card.name}
    >
      <div className="up-card-img-wrap">
        {card.image_url && !imgError ? (
          <img
            src={card.image_url}
            alt={card.name}
            className="up-card-img"
            onError={() => setImgError(true)}
            loading="lazy"
          />
        ) : (
          <div className="up-card-img-fallback">🃏</div>
        )}
        {card.quantity > 1 && (
          <span className="up-card-qty-badge">×{card.quantity}</span>
        )}
      </div>

      <div className="up-card-info">
        <span className="up-card-name">{card.name}</span>
        <span className="up-card-set">{card.set_name}</span>
        {card.rarity && (
          <span className="up-card-rarity">{card.rarity}</span>
        )}
      </div>

      {/* Hover overlay */}
      {hovered && (
        <div className="up-card-overlay">
          <div className="up-card-overlay-price">
            {card.tcgplayer_price
              ? `~$${Number(card.tcgplayer_price).toFixed(2)}`
              : 'Price N/A'}
          </div>
          {card.number && (
            <div className="up-card-overlay-number">#{card.number}</div>
          )}
        </div>
      )}
    </div>
  );
}
