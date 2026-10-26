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
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { prisma } from "@/lib/db";
import { isSignupAllowed } from "@/lib/utils/signup-allowlist";
import { chooseResetDelivery } from "@/lib/utils/reset-email";
import { sendOtpEmail } from "@/lib/utils/ses-email";
import {
  LOCKOUT_MESSAGE,
  isLocked,
  nextFailureState,
  resetState,
} from "@/lib/utils/lockout";

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
    // The code is a secret: NEVER log it outside development, even
    // when no SMS provider is configured.
    // ==========================================================
    if (process.env.NODE_ENV === "development") {
      console.log(
        `\n[Better Auth — OTP DEV MODE]\n` +
          `  📱 Phone : ${to}\n` +
          `  🔑 Code  : ${code}\n` +
          `  ⚠️  Set SMS_PROVIDER_API_KEY in .env to send real SMS.\n`
      );
    }
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
  // Request Hooks — H-2 per-account brute-force lockout (OWASP A07/A04)
  // --------------------------------------------------------
  // These before/after middlewares are the SINGLE writer of the two `User`
  // lockout columns (`failedLoginAttempts`, `lockedUntil`); the schema comment
  // on those fields says so. We use the top-level `hooks` option (NOT
  // `databaseHooks`) because databaseHooks only fire on a SUCCESSFUL sign-in and
  // so can never observe a FAILED attempt — which is the whole point of a
  // lockout. The `hooks.before`/`hooks.after` middleware runs on EVERY endpoint
  // and branches on `ctx.path`; critically the `after` middleware runs even when
  // the endpoint threw, with `ctx.context.returned` holding the APIError — that
  // is how we detect a failed sign-in.
  //
  // All decisions live in the pure `@/lib/utils/lockout` helper (unit-tested in
  // isolation); the hook only does I/O. The two columns are consulted/updated
  // ONLY on the `/sign-in/email` path, so OTP, the signup allowlist, Google
  // OAuth, admin auth, session, and reset-password are all untouched.
  //
  // FAIL-SAFE (AGENTS.md RULE 1 spirit for auth): every DB read/write below is
  // wrapped so a counter-update failure LOGS and CONTINUES — it must never block
  // a legitimate login or turn a sign-in into a 500. The ONE deliberate throw is
  // the FORBIDDEN in the `before` hook when the account is genuinely locked —
  // that throw IS the feature, not an error to swallow.
  hooks: {
    // BEFORE a credential sign-in is processed: reject if the account is locked.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/email") return;

      const email = ctx.body?.email;
      if (typeof email !== "string" || email.length === 0) return;

      let lockedUntil: Date | null = null;
      try {
        const user = await prisma.user.findUnique({
          where: { email },
          select: { lockedUntil: true },
        });
        // No such user → let the normal INVALID_EMAIL_OR_PASSWORD flow run so we
        // don't leak which emails exist (no enumeration).
        if (!user) return;
        lockedUntil = user.lockedUntil;
      } catch (err) {
        // Fail-safe: a lookup failure must not block a legitimate login. Skip
        // the lock check and let the normal sign-in flow proceed.
        console.error("[auth] lockout before-hook lookup failed:", err);
        return;
      }

      if (isLocked(lockedUntil, new Date())) {
        // Deliberate throw — the lockout itself. Generic message: it never
        // reveals whether the submitted password was correct.
        throw new APIError("FORBIDDEN", { message: LOCKOUT_MESSAGE });
      }
    }),

    // AFTER a credential sign-in: on success reset the counter; on an
    // invalid-credentials failure increment it (and lock at the threshold).
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/email") return;

      const email = ctx.body?.email;
      if (typeof email !== "string" || email.length === 0) return;

      // SUCCESS: a session was created on this request → clear any stale counter.
      if (ctx.context.newSession) {
        try {
          // updateMany (not update) so a missing row is a 0-row no-op, never a
          // throw — no enumeration, and resilient if the row vanished mid-flow.
          await prisma.user.updateMany({ where: { email }, data: resetState() });
        } catch (err) {
          console.error("[auth] lockout success-reset failed:", err);
        }
        return;
      }

      // FAILURE: only an invalid-credentials (wrong password / unknown email)
      // result counts. An unverified-email 403 (EMAIL_NOT_VERIFIED) means the
      // password WAS correct, so it must NOT increment; any other outcome on a
      // non-sign-in path already returned above.
      const returned = ctx.context.returned as
        | { body?: { code?: string } }
        | undefined;
      if (returned?.body?.code !== "INVALID_EMAIL_OR_PASSWORD") return;

      try {
        const user = await prisma.user.findUnique({
          where: { email },
          select: { failedLoginAttempts: true, lockedUntil: true },
        });
        // Unknown email → the invalid-credentials error is the same, but there's
        // no row to count against. Skip (no enumeration, no phantom row).
        if (!user) return;

        const next = nextFailureState(user, new Date());
        await prisma.user.updateMany({ where: { email }, data: next });
      } catch (err) {
        // Fail-safe: a counter update failure must not surface as a 500. The
        // sign-in already failed with the correct error; just log and continue.
        console.error("[auth] lockout failure-increment failed:", err);
      }
    }),
  },

  // --------------------------------------------------------
  // Database Hooks — post-signup side effects
  // --------------------------------------------------------
  // After a new user row is created (email/password OR OAuth), we
  // automatically provision a default "Main" collection so the
  // dashboard always has at least one collection to display.
  // Using upsert (via createMany + skipDuplicates) is idempotent —
  // safe to call even if the event fires twice (e.g. OAuth link).
  databaseHooks: {
    user: {
      create: {
        // Signup allowlist gate (env-driven). `before` fires for BOTH
        // email/password AND Google OAuth NEW-user rows, so there is no
        // OAuth bypass. It gates CREATION only — existing users signing in
        // again never hit this path. SIGNUP_ALLOWLIST unset/empty ⇒ signup
        // stays OPEN (see isSignupAllowed), so dev/CI/e2e are unaffected.
        before: async (user) => {
          if (!isSignupAllowed(user.email, process.env.SIGNUP_ALLOWLIST)) {
            throw new APIError("FORBIDDEN", {
              message: "Sign-ups are restricted. This email is not on the allowlist.",
            });
          }
        },
        after: async (user) => {
          try {
            await prisma.collection.upsert({
              where: { userId_name: { userId: user.id, name: "Main" } },
              create: {
                userId: user.id,
                name: "Main",
                typeTag: "MIXED",
                isPrivate: false,
              },
              update: {}, // already exists — no-op
            });
          } catch (err) {
            // Non-fatal: the user can always create collections manually.
            // Log but don't throw — a collection provisioning failure
            // must never block the sign-up response.
            console.error("[auth] Failed to provision default Main collection:", err);
          }
        },
      },
    },
  },

  // --------------------------------------------------------
  // User: expose `isAdmin` on the session
  // --------------------------------------------------------
  // Without this, every server component that needs to know whether
  // the current user is an admin would have to do a second Prisma
  // `findUnique` on top of `getSession()` — which was happening on
  // every /dashboard and /admin page load. Registering the field
  // here means it flows through Better Auth's cookie-cached session
  // (see `session.cookieCache` below, 5-minute TTL), so the routine
  // path is zero extra DB round-trips.
  //
  // The field is `input: false` so it cannot be set via sign-up /
  // update-user endpoints — admin status is toggled server-side only
  // (see scripts/create-admin.ts and the admin panel actions).
  user: {
    additionalFields: {
      isAdmin: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: false,
      },
    },
  },

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
    // Phase A: require a verified email before a CREDENTIAL sign-in succeeds.
    // Read ONLY on the email/password sign-in path (sign-in.mjs:312) — Google
    // OAuth (pre-verified by the provider) and admins (created with
    // `emailVerified: true` by scripts/create-admin.ts) are unaffected. An
    // unverified credential sign-in 403s with code "EMAIL_NOT_VERIFIED"; the
    // login page catches that and routes to /verify-otp (see login/page.tsx).
    requireEmailVerification: true,
    // Minimum password length
    minPasswordLength: 8,
    // Maximum password length (bcrypt limit is 72 bytes)
    maxPasswordLength: 128,

    // ----------------------------------------------------------
    // Forgot / Reset Password
    // ----------------------------------------------------------
    // Mirrors the sendSmsOtp plug-and-play pattern above. The delivery mode
    // is decided by chooseResetDelivery:
    //   - a provider is "configured" when EITHER Resend (RESEND_API_KEY +
    //     EMAIL_FROM) OR a generic REST provider (EMAIL_PROVIDER_API_KEY +
    //     EMAIL_PROVIDER_BASE_URL + EMAIL_FROM) env vars are present;
    //   - with a provider → send a real email via the Resend REST API (no
    //     new dependency — plain fetch);
    //   - no provider in local dev → log the link to the console so the
    //     reset flow stays testable;
    //   - no provider in prod → log a clear server error. We do NOT silently
    //     resolve: a user who asked for a reset must not wait forever on a
    //     mail that never ships.
    // The reset link is a secret (it grants a password reset), so it is
    // NEVER logged outside development.
    sendResetPassword: async ({ user, url }) => {
      const resendKey = process.env.RESEND_API_KEY;
      const genericKey = process.env.EMAIL_PROVIDER_API_KEY;
      const genericBase = process.env.EMAIL_PROVIDER_BASE_URL;
      const from = process.env.EMAIL_FROM;

      const hasProvider = Boolean(
        (resendKey && from) || (genericKey && genericBase && from)
      );

      switch (chooseResetDelivery({ hasProvider, nodeEnv: process.env.NODE_ENV })) {
        case "send": {
          // Resend REST API — a POST to /emails with a Bearer key. The
          // generic EMAIL_PROVIDER_* shape also lands here; both are
          // Resend-compatible JSON, so one call covers both.
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${resendKey ?? genericKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from,
              to: user.email,
              subject: "Reset your password",
              text: `Click the link to reset your password:\n\n${url}\n\nIf you did not request this, you can safely ignore this email.`,
            }),
          });
          if (!res.ok) {
            // Surface the failure — don't let a reset request look like it
            // succeeded when the provider rejected it.
            throw new Error(
              `[Better Auth] Password reset email failed to send (HTTP ${res.status}).`
            );
          }
          return;
        }
        case "dev-log": {
          console.log(
            `\n[Better Auth — RESET PASSWORD DEV MODE]\n` +
              `  📧 Email : ${user.email}\n` +
              `  🔗 Link  : ${url}\n` +
              `  ⚠️  No email provider configured — copy this link to test the reset flow.\n`
          );
          return;
        }
        case "prod-unconfigured": {
          // NEVER log the url here — this is production. Fail loudly in the
          // server logs instead of silently swallowing the request.
          console.error(
            "[Better Auth] Password reset requested but no email provider is " +
              "configured. Set RESEND_API_KEY + EMAIL_FROM (or EMAIL_PROVIDER_API_KEY " +
              "+ EMAIL_PROVIDER_BASE_URL + EMAIL_FROM) to deliver reset emails."
          );
          return;
        }
      }
    },
  },

  // --------------------------------------------------------
  // Core: Email Verification
  // --------------------------------------------------------
  // Create the session + set the cookie when /email-otp/verify-email succeeds,
  // so a correct OTP logs the user in. This is REQUIRED under the Phase A gate:
  // with requireEmailVerification:true the signUp.email response carries NO
  // session, so verify is the only point a credential user gets one before
  // their first real sign-in. Read ONLY on the verify-email path
  // (plugins/email-otp/routes.mjs:327) — WITHOUT it, verify marks the user
  // verified but returns token:null and sets no cookie, leaving them logged OUT.
  // We deliberately do NOT set `sendVerificationEmail` here: leaving it unset
  // keeps the credential sign-in gate on its hard EMAIL_NOT_VERIFIED 403 branch
  // (sign-in.mjs:313) rather than the softer resend-and-continue branch.
  emailVerification: {
    autoSignInAfterVerification: true,
  },

  // --------------------------------------------------------
  // Social Providers (OAuth)
  // --------------------------------------------------------
  // Registering Google here makes Better Auth expose the social sign-in
  // initiation (/api/auth/sign-in/social) and callback
  // (/api/auth/callback/google) routes. Real credentials come from env in
  // production; the "test" fallbacks keep the routes registered in local /
  // CI where the OAuth dance is mocked at the network layer (F-02).
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || "test",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "test",
    },
  },

  // --------------------------------------------------------
  // Plugins (plug-and-play — append to this array to add auth methods)
  // --------------------------------------------------------
  plugins: [
    // ----- 1. Email OTP (email-verification at registration — Phase A) -----
    // Emails a 6-digit code on sign-up (sendVerificationOnSignUp) that the user
    // enters on /verify-otp to verify their email. Codes are stored in the
    // existing `Verification` table (value `${otp}:0`, trailing attempt
    // counter) — no schema change. Delivery routes through sendOtpEmail (SES
    // in Phase B; dev-log console in Phase A). storeOTP is left at its default
    // "plain" (the e2e read-otp fixture depends on it); disableSignUp is NOT
    // set (it only governs the sign-IN-via-OTP account-creation path, unused
    // here).
    emailOTP({
      otpLength: 6,
      // 10-minute validity — long enough for real inbox latency, short enough
      // that a leaked code expires fast (upper end of the 300–600s envelope;
      // email is slower than SMS).
      expiresIn: 600,
      // Brute-force cap: the 4th wrong guess invalidates the code and the user
      // must request a new one. Layered on top of the per-IP rate limiter.
      allowedAttempts: 3,
      sendVerificationOnSignUp: true,
      // Invoked as sendVerificationOTP({ email, otp, type }, ctx). On the
      // sign-up auto-send path `type` is always "email-verification"; we accept
      // `ctx` for signature fidelity but Phase A does not use it.
      sendVerificationOTP: async ({ email, otp, type }, _ctx) => {
        await sendOtpEmail({ to: email, code: otp, type });
      },
    }),

    // ----- Phone Number / OTP (SMS) — still disabled for MVP -----
    // No SMS provider wired; the phoneNumber plugin + sendSmsOtp stay dormant.
    // To re-enable: uncomment the import and the phoneNumber() entry below and
    // populate SMS_PROVIDER_* vars in .env.
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
  // Includes the configured BETTER_AUTH_URL plus Vercel preview URLs
  // (each deploy gets a unique <hash>.vercel.app subdomain).
  //
  // Local dev is explicitly trusted on BOTH common ports: `next dev`
  // defaults to :3000, while the E2E harness boots on :3001 to match
  // BETTER_AUTH_URL. Google/social sign-in returned a 403 when the dev
  // server ran on :3000 but only :3001 was trusted — so both are listed.
  trustedOrigins: [
    process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    "http://localhost:3000",
    "http://localhost:3001",
    // Exact production origin — the one the Google callback is validated against.
    "https://pokemon-five-pi.vercel.app",
    // Per-deploy preview URL only (Vercel injects VERCEL_URL for the deploy
    // currently serving the request), so each preview trusts ITS OWN origin.
    ...(process.env.VERCEL_URL ? [`https://${process.env.VERCEL_URL}`] : []),
    // SECURITY (sec-audit-3 Finding #2): removed the "https://*.vercel.app"
    // wildcard. It trusted EVERY Vercel tenant — including attacker-controlled
    // *.vercel.app subdomains — for Better Auth origin/CORS validation. The
    // exact prod origin + per-deploy VERCEL_URL cover our real deployments
    // without trusting the whole shared vercel.app namespace.
  ],
});

// Export the inferred types for use in server components and actions
export type Auth = typeof auth;
export type Session = typeof auth.$Infer.Session;
