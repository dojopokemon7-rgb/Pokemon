"use client";

import { useEffect, useState } from "react";

/**
 * Shared delay for the delayed-skeleton pattern. Mirrors the 250ms CSS delay
 * in `.dojo-delayed-skeleton` (src/app/globals.css) — keep the two in lockstep.
 *
 * 250ms sits inside the project's snappy-motion budget (120/150/200/250ms):
 * long enough to swallow the sub-second loads the user reported (nothing shows,
 * no flicker), short enough that a genuinely slow load still gets a prompt
 * skeleton.
 */
export const DEFAULT_DELAY_MS = 250;

/**
 * Returns `true` only after `active` has been continuously `true` for
 * `delayMs`; returns `false` immediately whenever `active` is `false`.
 *
 * Used to delay loading skeletons so a fast load shows NOTHING instead of a
 * flash of grey placeholder (the reported awkward flicker). Pure and
 * dependency-free so it stays trivially testable with fake timers.
 */
export function useDelayedFlag(active: boolean, delayMs = DEFAULT_DELAY_MS): boolean {
  const [flag, setFlag] = useState(false);

  useEffect(() => {
    if (!active) {
      // Clear immediately when the load finishes — no lingering skeleton.
      setFlag(false);
      return;
    }
    const timer = setTimeout(() => setFlag(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);

  return flag;
}
