/**
 * Content-Security-Policy builder (PURE, dependency-free).
 *
 * Lives in src/lib so next.config.ts can import it with a RELATIVE path (the
 * config is loaded before tsconfig path aliases exist — do NOT use "@/..."
 * imports here) and so the policy string is unit-testable.
 */

/** Dojo's PostHog project is EU cloud; used when NEXT_PUBLIC_POSTHOG_HOST is unset. */
export const DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com";

/**
 * PostHog origins the browser must be allowed to reach, derived from the
 * ingestion host so US and EU both work:
 *   - ingest: the host posthog-js POSTs events/replay snapshots to (connect-src).
 *   - assets: the static-asset host for lazy-loaded scripts such as the session
 *     replay recorder (script-src). For PostHog Cloud this is
 *     `<region>-assets.i.posthog.com`; for a self-hosted/proxied host the assets
 *     are served from the same origin, so assets === ingest.
 * Unparseable input falls back to the EU defaults (never throws at config load).
 */
export function posthogOrigins(host?: string | null): {
  ingest: string;
  assets: string;
} {
  let url: URL;
  try {
    url = new URL((host && host.trim()) || DEFAULT_POSTHOG_HOST);
  } catch {
    url = new URL(DEFAULT_POSTHOG_HOST);
  }
  const ingest = url.origin;
  const cloud = /^(us|eu)\.i\.posthog\.com$/.exec(url.hostname);
  const assets = cloud ? `https://${cloud[1]}-assets.i.posthog.com` : ingest;
  return { ingest, assets };
}

/** The enforcing CSP value sent on every response (see next.config.ts headers). */
export function buildContentSecurityPolicy(posthogHost?: string | null): string {
  const ph = posthogOrigins(posthogHost);
  return [
    "default-src 'self'",
    // img-src: every host the browser loads card art from directly.
    //   Pokémon art — kept in exact sync with the /api/card-img
    //   proxy allowlist + next.config remotePatterns (images.scrydex.com,
    //   assets.tcgdex.net, images.pokemontcg.io, *.supabase.co).
    //   One Piece art — the UI <img> loads these two upstreams
    //   DIRECTLY (card.service.ts: "the browser can embed them
    //   directly"; card-image.ts onError chain): tcgplayer-cdn and
    //   static.cardmarket.com. data:/blob: cover the scanner canvas.
    "img-src 'self' data: blob: https://*.supabase.co https://images.scrydex.com https://assets.tcgdex.net https://images.pokemontcg.io https://tcgplayer-cdn.tcgplayer.com https://static.cardmarket.com",
    // 'unsafe-inline' required by Next.js inline runtime/styles.
    // 'wasm-unsafe-eval' lets tesseract.js compile its WASM core.
    // cdn.jsdelivr.net hosts the tesseract.js worker script.
    // PostHog assets host: posthog-js lazy-loads its session-replay recorder
    // (and other extensions) as <script> from <region>-assets.i.posthog.com.
    // TEMPORARY direct allowlist — once the planned first-party /ph reverse
    // proxy ships this origin can be dropped (script loads from 'self').
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net ${ph.assets}`,
    // Landing (served at /) pulls the Google Fonts stylesheet.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    // Landing font files load from Google's font CDN (default-src would block them).
    "font-src 'self' https://fonts.gstatic.com",
    // App fetches hit same-origin /api/* (sec-audit-2 #14). The
    // cross-origin fetches are:
    //   1. tesseract.js pulling its WASM core + `eng` traineddata
    //      from cdn.jsdelivr.net (scanner OCR fallback).
    //   2. The scanner's Phase 2 on-device visual variant match
    //      (@xenova/transformers CLIP): the ~90MB model is fetched
    //      ONCE from the Hugging Face Hub (huggingface.co, whose LFS
    //      weights redirect to cdn-lfs*.huggingface.co), and each One
    //      Piece variant IMAGE is fetched from images.scrydex.com to
    //      embed it. Both are fetch()/connect-src (NOT img-src — the
    //      variant <img> display is already covered by img-src above).
    //   3. PostHog (consent-gated, see AnalyticsProvider): events + session
    //      replay snapshots POST to the ingest host, and the SDK fetches its
    //      remote config / recorder from the assets host. Both are derived from
    //      NEXT_PUBLIC_POSTHOG_HOST (EU by default). TEMPORARY direct
    //      allowlist: once the first-party /ph reverse proxy ships, connect-src
    //      can shrink to 'self' and these two origins can be removed.
    `connect-src 'self' https://cdn.jsdelivr.net https://huggingface.co https://*.hf.co https://cdn-lfs.huggingface.co https://cdn-lfs-us-1.huggingface.co https://images.scrydex.com ${ph.ingest} ${ph.assets}`,
    // tesseract.js runs OCR in a blob-URL Web Worker. PostHog's session-replay
    // recorder also uses blob: workers for compression — already covered here.
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    // form-action must allow Google's OAuth endpoints: the Google
    // sign-in flow submits/redirects a form to accounts.google.com,
    // which a bare `form-action 'self'` BLOCKED — breaking Google
    // login on mobile (the /api/auth/callback/google navigation
    // failed with ERR_FAILED). 'self' covers our own email/password
    // + credential forms; the Google origins cover social sign-in.
    "form-action 'self' https://accounts.google.com https://*.google.com",
    "object-src 'none'",
  ].join("; ");
}
