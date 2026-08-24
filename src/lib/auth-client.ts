/**
 * Better Auth — Client-Side Configuration
 *
 * This file initializes the Better Auth client for use in:
 *   - React components (Client Components)
 *   - Browser-side hooks and utilities
 *
 * NEVER use this file in Server Components or API routes.
 * For server-side auth, use `@/lib/auth` instead.
 *
 * Usage example:
 *   import { authClient } from "@/lib/auth-client";
 *   const { data: session } = await authClient.getSession();
 *   await authClient.signIn.email({ email, password });
 *   await authClient.phoneNumber.sendOtp({ phoneNumber: "+1234567890" });
 */

"use client";

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  // Must point to the Next.js API route that handles auth requests.
  // In production this will be your domain (automatically uses the current origin).
  baseURL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",

  // Client-side plugins MUST mirror the server-side plugins in `lib/auth.ts`.
  // Phone Number / OTP is disabled for MVP — re-enable in Week 4.
  plugins: [
    // ----- Phone Number / OTP (client) — disabled for MVP -----
    // import { phoneNumberClient } from "better-auth/client/plugins";
    // phoneNumberClient(),

    // ----- FUTURE CLIENT PLUGINS -----
    // import { twoFactorClient } from "better-auth/client/plugins";
    // twoFactorClient(),
    //
    // import { organizationClient } from "better-auth/client/plugins";
    // organizationClient(),
  ],
});

// Re-export commonly used hooks and methods for convenience
export const {
  signIn,
  signOut,
  signUp,
  useSession,
  getSession,
} = authClient;
