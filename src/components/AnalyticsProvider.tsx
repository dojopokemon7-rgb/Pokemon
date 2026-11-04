"use client";

/**
 * AnalyticsProvider — consent-gated, env-gated init of PostHog.
 *
 * Nothing here runs on the server (RULE 6: analytics is 100% client-side; the
 * NEXT_PUBLIC_* keys are PUBLIC client keys, not secrets). PostHog loads ONLY
 * when `shouldInit(consent, key)` is true — i.e. the user clicked Accept AND the
 * key is present/non-empty. Unset key or non-granted consent = TOTAL no-op: no
 * network, no posthog.init.
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

declare global {
  interface Window {
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
  // State (not ref) so PageviewTracker re-renders and fires the first $pageview
  // the moment posthog-js finishes its async import + init.
  const [posthogLive, setPosthogLive] = useState(false);

  const init = useCallback(() => {
    if (typeof window === "undefined") return;
    const consent = readConsent();

    const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;

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
