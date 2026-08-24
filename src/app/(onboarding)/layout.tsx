/**
 * Onboarding Route Group Layout — (onboarding)
 *
 * Wraps onboarding screens:
 *   - /onboarding/profile  (Screen 05 · Create Profile)
 *
 * Uses the same full-screen dark shell as the auth layout but
 * without the DOJO wordmark header (the step indicator takes that role).
 */

import type { Metadata } from "next";
import { getServerSession } from "@/lib/utils/get-server-session";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: {
    default: "Set Up Your Profile",
    template: "%s · Dojo",
  },
};

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession();

  if (!session) {
    redirect("/login");
  }

  // Phone number verification removed for MVP — re-enable in Week 4
  // when SMS provider is configured.

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
        Stretched to full viewport height (same fix as (auth)/layout.tsx)
        so the profile page's `marginTop:"26px"`/`marginBottom:"auto"`
        footer elements can actually push toward the bottom instead of
        just adding a fixed gap after the form's natural height.
      */}
      <div
        style={{
          width: "100%",
          maxWidth: "390px",
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          padding: "60px 16px 40px",
          boxSizing: "border-box",
        }}
      >
        {children}
      </div>
    </div>
  );
}
