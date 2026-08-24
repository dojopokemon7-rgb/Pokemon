"use client";

/**
 * PwaRegistrar
 *
 * Registers `/sw.js` against the app's root scope ("/") on mount.
 * Rendered at the bottom of <body> (see layout.tsx) so it never
 * blocks the initial paint or hydration of the rest of the page.
 *
 * Renders nothing — this is a side-effect-only component.
 */

import { useEffect } from "react";

export default function PwaRegistrar() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    // Registration happens after the page has finished loading so it
    // never competes with critical resources for bandwidth/CPU.
    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then((registration) => {
          console.log(
            "[PWA] Service worker registered:",
            registration.scope
          );
        })
        .catch((err) => {
          console.error("[PWA] Service worker registration failed:", err);
        });
    };

    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
