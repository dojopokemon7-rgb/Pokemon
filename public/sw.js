/**
 * Dojo PWA Service Worker
 *
 * Strategy:
 *   - Navigation requests:      Network First → falls back to /offline.html
 *                               when the network is unavailable (keeps
 *                               dynamic routes like /dashboard fresh while
 *                               still giving a shell when fully offline).
 *   - Static assets (JS/CSS/
 *     images/fonts, Next.js
 *     build chunks):            Cache First → instant repeat loads, offline
 *                               capable once visited once.
 *   - API routes (/api/*):      Network First, no offline fallback — API
 *                               data must never be served silently stale
 *                               and cached error responses are never stored.
 *
 * Scope: registered at "/" (see PwaRegistrar.tsx), so it can intercept
 * every request in the app.
 */

const CACHE_VERSION = "dojo-v1";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const OFFLINE_URL = "/offline.html";

// Minimal shell precached on install so the very first offline visit
// still has something to fall back to.
const PRECACHE_URLS = [OFFLINE_URL, "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("dojo-") && key !== STATIC_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

/** Requests that should never be cached (mutations, auth, streaming). */
function isApiRequest(url) {
  return url.pathname.startsWith("/api/");
}

/** Static, hashed, long-lived assets — safe to serve cache-first. */
function isStaticAsset(request, url) {
  if (url.pathname.startsWith("/_next/static/")) return true;
  if (request.destination === "style" || request.destination === "script") {
    return true;
  }
  if (request.destination === "image" || request.destination === "font") {
    return true;
  }
  return /\.(?:js|css|woff2?|ttf|png|jpg|jpeg|webp|svg|ico)$/.test(
    url.pathname
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // let cross-origin requests pass through untouched

  // ------------------------------------------------------------
  // 1. Page navigations — Network First, offline shell fallback
  // ------------------------------------------------------------
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(OFFLINE_URL).then((cached) => cached || Response.error())
      )
    );
    return;
  }

  // ------------------------------------------------------------
  // 2. API routes — Network First, never cached
  // ------------------------------------------------------------
  if (isApiRequest(url)) {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(
            JSON.stringify({ error: "You are offline. Please reconnect." }),
            {
              status: 503,
              headers: { "Content-Type": "application/json" },
            }
          )
      )
    );
    return;
  }

  // ------------------------------------------------------------
  // 3. Static assets — Cache First, fall back to network + cache fill
  // ------------------------------------------------------------
  if (isStaticAsset(request, url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Everything else: let the browser handle it normally.
});
