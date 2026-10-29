"use client";

/**
 * AnalyticsProvider — consent-gated, env-gated init of PostHog + Microsoft Clarity.
 *
 * Nothing here runs on the server (RULE 6: analytics is 100% client-side; the
 * three NEXT_PUBLIC_* keys are PUBLIC client keys, not secrets). Each tracker is
 * independent: if only one key is set, only that one loads. A tracker loads ONLY
 * when `shouldInit(consent, key)` is true — i.e. the user clicked Accept AND the
 * key is present/non-empty. Unset key or non-granted consent = TOTAL no-op: no
 * script injected, no network, no posthog.init.
 *
 * We react both on mount and on the `dojo-consent-changed` event so flipping
 * consent takes effect without a page reload. Init-once refs stop re-renders /
 * repeated events from double-initializing.
 *
 * NEXT_PUBLIC_* must be referenced as full literal `process.env.NEXT_PUBLIC_X`
 * expressions so Next can statically inline them at build (RULE: build-time
 * inlining — see docs/ANALYTICS_SETUP.md).
 */

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { CONSENT_CHANGED_EVENT } from "./CookieConsent";
import {
  CONSENT_STORAGE_KEY,
  parseConsent,
  shouldInit,
  type ConsentValue,
} from "@/lib/utils/analytics-consent";

// Minimal typing for the Clarity global so TS stays strict without a package.
declare global {
  interface Window {
    clarity?: (...args: unknown[]) => void;
    posthog?: { capture: (event: string) => void };
  }
}

function readConsent(): ConsentValue | null {
  if (typeof window === "undefined") return null;
  try {
    return parseConsent(window.localStorage.getItem(CONSENT_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Standard Microsoft Clarity bootstrap snippet, injected once after consent. */
function injectClarity(projectId: string) {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (document.getElementById("dojo-clarity")) return; // already injected
  const s = document.createElement("script");
  s.id = "dojo-clarity";
  s.type = "text/javascript";
  s.async = true;
  // The documented Clarity loader, keyed by the project id.
  s.innerHTML =
    "(function(c,l,a,r,i,t,y){" +
    "c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};" +
    "t=l.createElement(r);t.async=1;t.src='https://www.clarity.ms/tag/'+i;" +
    "y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);" +
    "})(window, document, 'clarity', 'script', '" +
    projectId +
    "');";
  document.head.appendChild(s);
}

/**
 * PostHog pageview tracker. Isolated inside <Suspense> because useSearchParams()
 * triggers a CSR bailout that `next build` rejects unless suspended. Captures a
 * manual `$pageview` on App Router route changes (capture_pageview:false below),
 * the documented Next.js App Router pattern — ONLY once PostHog is initialized.
 */
function PageviewTracker({ ready }: { ready: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!ready || typeof window === "undefined" || !window.posthog) return;
    window.posthog.capture("$pageview");
  }, [ready, pathname, searchParams]);

  return null;
}

export default function AnalyticsProvider() {
  const posthogReady = useRef(false);
  const clarityInjected = useRef(false);
  // State (not ref) so PageviewTracker re-renders and fires the first $pageview
  // the moment posthog-js finishes its async import + init.
  const [posthogLive, setPosthogLive] = useState(false);

  const init = useCallback(() => {
    if (typeof window === "undefined") return;
    const consent = readConsent();

    const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;
    const clarityId = process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID;

    // PostHog — dynamic import so posthog-js never enters the server/SSR path.
    if (!posthogReady.current && shouldInit(consent, posthogKey)) {
      posthogReady.current = true;
      void import("posthog-js").then(({ default: posthog }) => {
        posthog.init(posthogKey as string, {
          api_host: posthogHost || "https://us.i.posthog.com",
          // We capture $pageview manually on App Router route changes (the
          // automatic one misses client-side navigations).
          capture_pageview: false,
          capture_pageleave: true,
        });
        window.posthog = posthog;
        setPosthogLive(true);
      });
    }

    // Clarity — independent of PostHog; just the window snippet.
    if (!clarityInjected.current && shouldInit(consent, clarityId)) {
      clarityInjected.current = true;
      injectClarity(clarityId as string);
    }
  }, []);

  useEffect(() => {
    init();
    window.addEventListener(CONSENT_CHANGED_EVENT, init);
    return () => window.removeEventListener(CONSENT_CHANGED_EVENT, init);
  }, [init]);

  return (
    <Suspense fallback={null}>
      <PageviewTracker ready={posthogLive} />
    </Suspense>
  );
}
