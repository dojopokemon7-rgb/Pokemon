/**
 * Better Auth — Server-Side Configuration
 *
 * This is the SINGLE source of truth for authentication on the server.
 * It is imported ONLY in:
 *   - `app/api/auth/[...all]/route.ts` (HTTP handler)
 *   - Server Actions / server components that need auth context
 *
 * NEVER import this file on the client side.
 *
 * =============================================================
 * PLUG-AND-PLAY ARCHITECTURE
 * =============================================================
 * Plugins are registered in the `plugins` array below.
 * To add a new auth method in future weeks, simply append to the array:
 *
 *   import { twoFactor } from "better-auth/plugins";
 *   plugins: [...existingPlugins, twoFactor()]
 *
 * =============================================================
 * SMS PROVIDER SWAP (Week 4)
 * =============================================================
 * The `phoneNumber` plugin below uses a custom `sendOTP` function.
 * In local dev (no SMS_PROVIDER_API_KEY), it logs the OTP to console.
 * In production, swap out the TODO block with your provider SDK.
 *
 * Supported providers to integrate in Week 4:
 *   - Twilio:  `import twilio from 'twilio'`
 *   - AWS SNS: `import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'`
 *   - MSG91, Fast2SMS, or any REST API
 *
 * The ONLY change needed is inside `sendOTP` — nothing else changes.
 */

import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "@/lib/db";

// =============================================================
// SMS Dispatch Function (plug-and-play)
// =============================================================

interface OtpSendPayload {
  phoneNumber: string;
  code: string;
}

/**
 * Sends an OTP to the given phone number.
 *
 * WEEK 4 SWAP INSTRUCTIONS:
 * 1. Ensure `SMS_PROVIDER_API_KEY`, `SMS_PROVIDER_BASE_URL`, and
 *    `SMS_FROM_NUMBER` are set in your .env / Docker secrets.
 * 2. Replace the TODO block below with your provider's SDK call.
 * 3. No other code changes are required — the plugin wires this in automatically.
 */
async function sendSmsOtp({ phoneNumber: to, code }: OtpSendPayload): Promise<void> {
  const apiKey = process.env.SMS_PROVIDER_API_KEY;
  const baseUrl = process.env.SMS_PROVIDER_BASE_URL;
  const fromNumber = process.env.SMS_FROM_NUMBER;

  if (!apiKey || !baseUrl || !fromNumber) {
    // ==========================================================
    // LOCAL DEV MODE — OTP is logged to console instead of sent.
    // This is intentional and safe; no real SMS is dispatched.
    // ==========================================================
    console.log(
      `\n[Better Auth — OTP DEV MODE]\n` +
        `  📱 Phone : ${to}\n` +
        `  🔑 Code  : ${code}\n` +
        `  ⚠️  Set SMS_PROVIDER_API_KEY in .env to send real SMS.\n`
    );
    return;
  }

  // ==========================================================
  // PRODUCTION MODE — Replace this block in Week 4
  // TODO: Integrate your SMS provider SDK here.
  //
  // Example (generic REST):
  //   await fetch(`${baseUrl}/send`, {
  //     method: "POST",
  //     headers: {
  //       "Authorization": `Bearer ${apiKey}`,
  //       "Content-Type": "application/json",
  //     },
  //     body: JSON.stringify({
  //       from: fromNumber,
  //       to,
  //       message: `Your TCG Collection OTP is: ${code}. Valid for 10 minutes.`,
  //     }),
  //   });
  //
  // Example (Twilio):
  //   const client = twilio(process.env.TWILIO_ACCOUNT_SID, apiKey);
  //   await client.messages.create({ from: fromNumber, to, body: `Your OTP: ${code}` });
  // ==========================================================
  console.warn(
    "[Better Auth] SMS_PROVIDER_API_KEY is set but the provider is not yet implemented. " +
      "See the TODO block in src/lib/auth.ts to integrate your SMS provider."
  );
}

// =============================================================
// Better Auth Instance
// =============================================================

export const auth = betterAuth({
  // --------------------------------------------------------
  // Database Adapter
  // --------------------------------------------------------
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),

  // --------------------------------------------------------
  // Base URL — must match BETTER_AUTH_URL env var
  // --------------------------------------------------------
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",

  // --------------------------------------------------------
  // Secret — used to sign tokens and cookies
  // --------------------------------------------------------
  secret: process.env.BETTER_AUTH_SECRET,

  // --------------------------------------------------------
  // Core: Email & Password
  // In Better Auth v1.x, emailAndPassword is a core option,
  // NOT a plugin. Configure it directly here.
  // --------------------------------------------------------
  emailAndPassword: {
    enabled: true,
    // Require email verification before login (set to false for faster local dev)
    requireEmailVerification: false,
    // Minimum password length
    minPasswordLength: 8,
    // Maximum password length (bcrypt limit is 72 bytes)
    maxPasswordLength: 128,

    // ----------------------------------------------------------
    // Forgot / Reset Password
    // ----------------------------------------------------------
    // Mirrors the sendSmsOtp plug-and-play pattern above: no real
    // email provider is wired up yet, so the reset link is logged
    // to the server console in local dev. Swap the TODO block below
    // for a real email provider (Resend, SendGrid, SES, etc.) when
    // one is available — no other code changes are required.
    sendResetPassword: async ({ user, url }) => {
      // TODO (Week 4-style swap): integrate a real email provider here
      // (Resend, SendGrid, SES, etc.), e.g.:
      //   await sendEmail({ to: user.email, subject: "Reset your password",
      //     text: `Click the link to reset your password: ${url}` });
      //
      // No provider is configured yet, so the reset link is logged to
      // the server console instead — copy it from the terminal to test
      // the reset flow locally.
      console.log(
        `\n[Better Auth — RESET PASSWORD DEV MODE]\n` +
          `  📧 Email : ${user.email}\n` +
          `  🔗 Link  : ${url}\n` +
          `  ⚠️  No email provider configured — copy this link to test the reset flow.\n`
      );
    },
  },

  // --------------------------------------------------------
  // Plugins (plug-and-play — append to this array to add auth methods)
  // --------------------------------------------------------
  plugins: [
    // ----- 1. Phone Number / OTP -----
    // Disabled for MVP — re-enable in Week 4 when SMS provider is configured.
    // To re-enable: uncomment the import above and the phoneNumber() entry below,
    // and populate SMS_PROVIDER_* vars in .env.
    //
    // phoneNumber({
    //   sendOTP: sendSmsOtp,
    //   otpLength: 6,
    //   expiresIn: 600,
    // }),

    // ----- FUTURE PLUGINS (uncomment as needed) -----
    // import { twoFactor } from "better-auth/plugins";
    // twoFactor(),
    //
    // import { oAuthProxy } from "better-auth/plugins";
    // oAuthProxy(),
    //
    // import { organization } from "better-auth/plugins";
    // organization(),
  ],

  // --------------------------------------------------------
  // Session Configuration
  // --------------------------------------------------------
  session: {
    // Base session token lifetime: 7 days.
    // This is the default expiry for a standard login.
    // The "remember me" flow (30 days) is handled by the auth client
    // passing `rememberMe: true` to signIn.email(), which extends
    // the session cookie's maxAge on the client side.
    expiresIn: 60 * 60 * 24 * 7, // 7 days in seconds

    // Roll the session on activity — updates the `expiresAt` timestamp
    // whenever the user makes a request, so active users never get
    // logged out abruptly. We only refresh once per hour to avoid
    // a DB write on every single request.
    updateAge: 60 * 60, // 1 hour (in seconds)

    // Cookie cache: stores a signed copy of the session in the browser
    // cookie to reduce database reads. The session is re-validated from
    // the DB once the cache expires. 5 minutes is a good balance
    // between freshness and performance.
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5, // 5 minutes (in seconds)
    },
  },

  // --------------------------------------------------------
  // Trusted Origins (CORS)
  // --------------------------------------------------------
  trustedOrigins: [
    process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    // Add your production domain here in Week 4:
    // "https://your-domain.com",
  ],
});

// Export the inferred types for use in server components and actions
export type Auth = typeof auth;
export type Session = typeof auth.$Infer.Session;
