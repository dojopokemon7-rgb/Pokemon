/**
 * Auth Route Group Layout — (auth)
 *
 * Wraps all authentication pages:
 *   - /login      (Screen 01 · Sign In)
 *   - /signup     (Screen 02 · Sign Up)
 *   - /otp        (Screen 03 · Phone Number)
 *   - /verify-otp (Screen 04 · Verify OTP)
 *
 * The reference prototype (dojo-prototype/app.js) has NO persistent
 * branded header on auth screens — no wordmark, no tagline. The Dojo
 * mark (dojoMark(46)) is rendered inline, once, only on the sign-in
 * screen itself, directly above "welcome to the dojo" (see
 * SCREENS.signin). This layout previously added a fabricated
 * DOJO/"built for collectors" header on every screen, which doesn't
 * exist in the reference — removed. The mark now lives inline in
 * login/page.tsx only.
 */

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "Sign In",
    template: "%s · Dojo",
  },
};

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        minHeight: "100dvh",
        backgroundColor: "var(--color-dojo-app)",
        display: "flex",
        justifyContent: "center",
      }}
    >
      {/*
        Auth card — stretched to full viewport height so a `marginTop:
        "auto"` footer inside each page can push itself to the true
        bottom of the screen, matching the reference's `.screen{height:
        100%} > .form{flex:1;display:flex;flex-direction:column}` with
        footer links at `margin-top:auto` (dojo-prototype/styles.css,
        app.js SCREENS.signin/signup/otp/verify). Previously this was a
        plain centered block sized to its content, so `marginTop:"36px"`
        on the footer just added a fixed gap after the buttons instead
        of pinning it to the bottom — that was the actual bug.
      */}
      <div
        style={{
          width: "100%",
          maxWidth: "390px",
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          padding: "56px 16px 40px",
          boxSizing: "border-box",
        }}
      >
        {children}
      </div>
    </div>
  );
}
