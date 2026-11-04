"use client";

/**
 * AnalyticsProvider — consent-gated, env-gated init of PostHog.
 *
 * Nothing here runs on the server (RULE 6: analytics is 100% client-side; the
 * NEXT_PUBLIC_* keys are PUBLIC client keys, not secrets). PostHog loads ONLY
 * when `shouldInit(consent, key)` is true — i.e. the user clicked Accept AND the
 * key is present/non-empty. Unset key or non-granted consent = TOTAL no-op: no
 * network, no posthog.init, no identify, and track() stays a no-op.
 *
 * We react both on mount and on the `dojo-consent-changed` event so flipping
 * consent takes effect without a page reload. Init-once refs stop re-renders /
 * repeated events from double-initializing.
 *
 * Identity: once PostHog is live, <IdentitySync/> ties events to the Better Auth
 * user (client useSession — covers email login, signup, Google OAuth return and
 * returning sessions) and resets on sign-out. It is mounted only after init so
 * no session request is made for visitors who never consented.
 *
 * NEXT_PUBLIC_* must be referenced as full literal `process.env.NEXT_PUBLIC_X`
 * expressions so Next can statically inline them at build (RULE: build-time
 * inlining — see docs/ANALYTICS_SETUP.md).
 */

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { CONSENT_CHANGED_EVENT } from "./CookieConsent";
import { useSession } from "@/lib/auth-client";
import { resolveAuthEvents, takeAuthIntent } from "@/lib/analytics/auth-intent";
import { track } from "@/lib/analytics/track";
import { analyticsEnvironment } from "@/lib/analytics/environment";
import { DEFAULT_POSTHOG_HOST } from "@/lib/utils/csp";
import {
  CONSENT_STORAGE_KEY,
  parseConsent,
  shouldInit,
  type ConsentValue,
} from "@/lib/utils/analytics-consent";

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

/**
 * Identify the signed-in user on the PERSON profile (email + name live there,
 * NEVER in event properties) and reset on sign-out. Also emits the one-shot
 * signup_completed / login_completed recorded by the auth pages (auth-intent).
 * Mounted only after consent + init, so nothing here can run before consent.
 */
function IdentitySync() {
  const { data: session } = useSession();
  const user = session?.user;
  const identifiedId = useRef<string | null>(null);

  const userId = user?.id ?? null;
  const email = user?.email;
  const name = user?.name;
  const createdAt = user?.createdAt;

  useEffect(() => {
    const ph = typeof window !== "undefined" ? window.posthog : undefined;
    if (!ph) return;
    if (userId) {
      if (identifiedId.current === userId) return;
      identifiedId.current = userId;
      ph.identify?.(userId, { email, ...(name ? { name } : {}) });
      const intent = takeAuthIntent();
      if (intent) {
        for (const ev of resolveAuthEvents(intent, createdAt)) {
          track(ev, { method: intent.method });
        }
      }
    } else if (identifiedId.current) {
      // Signed out: unlink this browser from the person.
      identifiedId.current = null;
      ph.reset?.();
    }
  }, [userId, email, name, createdAt]);

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
          // Same default as the CSP allowlist (src/lib/utils/csp.ts) so the
          // two can never disagree about which host is permitted.
          api_host: posthogHost || DEFAULT_POSTHOG_HOST,
          // We capture $pageview manually on App Router route changes (the
          // automatic one misses client-side navigations).
          capture_pageview: false,
          capture_pageleave: true,
          autocapture: true,
          // Error tracking (unhandled exceptions / rejections).
          capture_exceptions: true,
          // Anonymous visitors get no person profile until identify().
          person_profiles: "identified_only",
          // Session replay with EVERY input masked so password / OTP / payment
          // fields are never recorded. (Replay must also be enabled in the
          // PostHog project settings — see docs/ANALYTICS_SETUP.md.)
          session_recording: { maskAllInputs: true },
          // Tag every event so staging/prod/dev can be filtered in the one
          // free-tier project. Runs before the first capture.
          loaded: (ph) =>
            ph.register({ environment: analyticsEnvironment(window.location.hostname) }),
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
    <>
      <Suspense fallback={null}>
        <PageviewTracker ready={posthogLive} />
      </Suspense>
      {posthogLive && <IdentitySync />}
    </>
  );
}
