import React, { useState, useRef, useCallback } from 'react';
import './CardScanner.css';

/**
 * CardScanner
 * -----------
 * Accepts an image via file upload or camera capture,
 * runs a two-pass OCR pipeline (name strip + full card for number),
 * then emits a structured result to `onResult`.
 *
 * If OCR confidence is low, shows a manual name-input fallback
 * so the user can still search without a perfect scan.
 *
 * @param {{ onResult?: Function, onError?: Function }} props
 */
export default function CardScanner({ onResult, onError }) {
  const [preview,       setPreview]       = useState(null);
  const [processed,     setProcessed]     = useState(null);
  const [status,        setStatus]        = useState('idle'); // idle|loading|done|error|manual
  const [result,        setResult]        = useState(null);
  const [errorMsg,      setErrorMsg]      = useState('');
  const [showProcessed, setShowProcessed] = useState(false);
  const [manualName,    setManualName]    = useState('');

  const fileInputRef   = useRef(null);
  const cameraInputRef = useRef(null);

  // ── Core pipeline ─────────────────────────────────────────────

  const processFile = useCallback(async (file) => {
    if (!file || !file.type.startsWith('image/')) return;

    setStatus('loading');
    setResult(null);
    setErrorMsg('');
    setProcessed(null);
    setManualName('');

    const dataUrl = await fileToDataURL(file);
    setPreview(dataUrl);

    try {
      // Send base64 image data to the backend OCR scan endpoint
      const response = await fetch('/api/ocr/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl }),
      });

      if (!response.ok) {
        throw new Error(`OCR scanner server returned error: ${response.status}`);
      }

      const scanResult = await response.json();
      if (!scanResult.success) {
        throw new Error(scanResult.error || 'Server-side OCR scan failed');
      }

      const merged = {
        rawText:           scanResult.rawText || '',
        extractedName:     scanResult.extractedName || '',
        extractedNumber:   scanResult.extractedNumber || '',
        confidence:        scanResult.confidence || 0,
        lowConfidence:     scanResult.lowConfidence ?? true,
        webEntities:       scanResult.webEntities       || [],
        matchingImageUrls: scanResult.matchingImageUrls || [],
        matchingPageUrls:  scanResult.matchingPageUrls  || [],
      };

      setResult(merged);

      if (merged.lowConfidence || !merged.extractedName) {
        // Low confidence → show manual fallback, pre-fill with best guess
        setManualName(merged.extractedName || '');
        setStatus('manual');
      } else {
        setStatus('done');
        onResult?.(merged);
      }

    } catch (err) {
      const msg = `OCR failed: ${err.message}`;
      setErrorMsg(msg);
      setStatus('error');
      onError?.(msg);
    }
  }, [onResult, onError]);

  // ── Manual submit ─────────────────────────────────────────────

  const handleManualSubmit = () => {
    if (!manualName.trim()) return;
    const final = {
      ...(result || {}),
      extractedName: manualName.trim(),
      manualOverride: true,
    };
    setResult(final);
    setStatus('done');
    onResult?.(final);
  };

  // ── Input handlers ────────────────────────────────────────────

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = '';
  };

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  }, [processFile]);

  const handleDragOver = (e) => e.preventDefault();

  // ── Render ────────────────────────────────────────────────────

  return (
    <div className="cs-root">
      {/* ── Header ── */}
      <div className="cs-header">
        <span className="cs-header-icon">🃏</span>
        <div>
          <h2 className="cs-title">Card Scanner</h2>
          <p className="cs-subtitle">Upload or photograph a Pokémon card to identify it</p>
        </div>
      </div>

      {/* ── Drop zone ── */}
      <div
        className={`cs-dropzone ${status === 'loading' ? 'cs-dropzone--busy' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        {status === 'loading' ? (
          <div className="cs-spinner-wrap">
            <div className="cs-spinner" />
            <span className="cs-spinner-label">Scanning…</span>
          </div>
        ) : (
          <>
            <div className="cs-dropzone-icon">📂</div>
            <p className="cs-dropzone-text">Drag &amp; drop a card image here</p>
            <p className="cs-dropzone-sub">or choose an option below</p>
          </>
        )}
      </div>

      {/* ── Buttons ── */}
      <div className="cs-btn-row">
        <button
          className="cs-btn cs-btn--upload"
          onClick={() => fileInputRef.current?.click()}
          disabled={status === 'loading'}
          id="btn-file-upload"
        >
          📁 Upload Image
        </button>
        <input ref={fileInputRef} type="file" accept="image/*"
          onChange={handleFileChange} style={{ display: 'none' }} id="input-file-upload" />

        <button
          className="cs-btn cs-btn--camera"
          onClick={() => cameraInputRef.current?.click()}
          disabled={status === 'loading'}
          id="btn-camera-capture"
        >
          📷 Use Camera
        </button>
        <input ref={cameraInputRef} type="file" accept="image/*" capture="environment"
          onChange={handleFileChange} style={{ display: 'none' }} id="input-camera-capture" />
      </div>

      {/* ── Preview grid ── */}
      {preview && (
        <div className="cs-preview-grid">
          <div className="cs-preview-card">
            <span className="cs-preview-label">Original</span>
            <img src={preview} alt="Original card" className="cs-preview-img" />
          </div>
          {processed && (
            <div className="cs-preview-card">
              <span className="cs-preview-label">
                Name Strip (pre-processed)
                <button className="cs-toggle-btn" onClick={() => setShowProcessed(v => !v)}
                  id="btn-toggle-processed">
                  {showProcessed ? 'Hide' : 'Show'}
                </button>
              </span>
              {showProcessed && (
                <img src={processed} alt="Pre-processed name strip" className="cs-preview-img" />
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Manual input fallback (low confidence) ── */}
      {status === 'manual' && (
        <div className="cs-manual" id="ocr-manual-input">
          <div className="cs-manual-header">
            <span className="cs-manual-icon">✏️</span>
            <div>
              <p className="cs-manual-title">OCR had low confidence</p>
              <p className="cs-manual-sub">
                Best guess: <strong>{result?.extractedName || '(nothing detected)'}</strong>
                {result?.confidence != null && ` (${result.confidence.toFixed(0)}%)`}
                <br/>Confirm or type the correct card name:
              </p>
            </div>
          </div>
          <div className="cs-manual-row">
            <input
              type="text"
              className="cs-manual-input"
              value={manualName}
              onChange={e => setManualName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleManualSubmit()}
              placeholder="e.g. Charizard VMAX"
              id="input-manual-card-name"
              autoFocus
            />
            <button
              className="cs-btn cs-btn--upload"
              onClick={handleManualSubmit}
              disabled={!manualName.trim()}
              id="btn-manual-submit"
              style={{ flex: 'none', padding: '10px 18px' }}
            >
              Search →
            </button>
          </div>
          {result?.extractedNumber && (
            <p className="cs-manual-number">
              Card number detected: <strong>{result.extractedNumber}</strong>
            </p>
          )}
        </div>
      )}

      {/* ── Result panel ── */}
      {status === 'done' && result && (
        <div className="cs-result" id="ocr-result-panel">
          <div className="cs-result-header">
            <span className="cs-result-icon">✅</span>
            <span className="cs-result-title">Scan Result</span>
            <span className="cs-confidence-badge">
              {result.manualOverride ? 'Manual input' : `${result.confidence?.toFixed(1)}% confidence`}
            </span>
          </div>
          <div className="cs-result-grid">
            <ResultField id="result-card-name"   label="Card Name"   value={result.extractedName   || '—'} icon="🎴" />
            <ResultField id="result-card-number" label="Card Number" value={result.extractedNumber || '—'} icon="🔢" />
          </div>
          <details className="cs-raw-details" id="ocr-raw-text">
            <summary>Raw OCR text</summary>
            <pre className="cs-raw-pre">{result.rawText}</pre>
          </details>
        </div>
      )}

      {/* ── Error panel ── */}
      {status === 'error' && (
        <div className="cs-error" id="ocr-error-panel">
          <span className="cs-error-icon">⚠️</span>
          <span>{errorMsg}</span>
        </div>
      )}
    </div>
  );
}

function ResultField({ label, value, icon, id }) {
  return (
    <div className="cs-field" id={id}>
      <span className="cs-field-icon">{icon}</span>
      <div>
        <span className="cs-field-label">{label}</span>
        <span className="cs-field-value">{value}</span>
      </div>
    </div>
  );
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
