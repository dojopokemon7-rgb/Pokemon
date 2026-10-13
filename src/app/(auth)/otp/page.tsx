"use client";

/**
 * Screen 03 — OTP (legacy phone-entry route)
 *
 * The phone/SMS OTP flow is disabled for MVP, so there is no separate
 * "enter contact" step. The email-OTP verification lives at /verify-otp;
 * this route just forwards there so it never dead-ends.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function OtpPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/verify-otp");
  }, [router]);
  return null;
}
