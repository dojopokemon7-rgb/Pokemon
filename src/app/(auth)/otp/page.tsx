"use client";

/**
 * Screen 03 — OTP (Phone Number Entry)
 *
 * Disabled for MVP — phone/OTP verification is not active.
 * The signup flow now goes directly to /profile after account creation.
 * Re-enable in Week 4 when the SMS provider is configured.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function OtpPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/profile");
  }, [router]);
  return null;
}
