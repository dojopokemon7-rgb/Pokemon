/**
 * Email-OTP verification sender (Phase A).
 *
 * Twin of `reset-email.ts` — same 3-mode delivery decision, same vocabulary
 * (`hasProvider` / `"send" | "dev-log" | "prod-unconfigured"`), same house
 * stance that a code is a SECRET and is NEVER logged outside local dev.
 *
 * Phase A runs on the `"dev-log"` path (zero AWS): the code is printed to the
 * console exactly like `sendSmsOtp` / `sendResetPassword` already do. The real
 * SES call lives in the single `sendViaSes` stub below — the ONLY place Phase B
 * edits in this file (it swaps the throw for an `@aws-sdk/client-sesv2` send).
 */

/**
 * Pure delivery-mode decision for OTP emails. Twin of `chooseResetDelivery`.
 *
 *   'send'              — a provider is configured (hasProvider true); send.
 *   'dev-log'           — no provider, local dev; log the code (dev-only — the
 *                         code is a secret and must never be logged in prod).
 *   'prod-unconfigured' — no provider, NOT dev; the caller logs a loud,
 *                         code-free error (never silently "succeed").
 *
 * Side-effect-free so it can be unit-tested in isolation (AGENTS.md RULE 11).
 */
export function chooseOtpDelivery(env: {
  hasProvider: boolean;
  nodeEnv: string | undefined;
}): "send" | "dev-log" | "prod-unconfigured" {
  if (env.hasProvider) return "send";
  return env.nodeEnv === "development" ? "dev-log" : "prod-unconfigured";
}

/**
 * Sends a verification OTP to the given email. Called from Better Auth's
 * `emailOTP` plugin `sendVerificationOTP` callback (src/lib/auth.ts).
 *
 * A provider counts as configured (`hasProvider = true`) when ALL of
 * `AWS_SES_REGION` + `AWS_SES_ACCESS_KEY_ID` + `AWS_SES_SECRET_ACCESS_KEY` +
 * `EMAIL_FROM` are set. `EMAIL_FROM` is already live (shared with the reset
 * flow); only the `AWS_SES_*` trio is the new Phase-B send path.
 */
export async function sendOtpEmail(args: {
  to: string;
  code: string;
  type: string; // always "email-verification" on the Phase A auto-send path
}): Promise<void> {
  const { to, code } = args;
  const region = process.env.AWS_SES_REGION;
  const accessKeyId = process.env.AWS_SES_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SES_SECRET_ACCESS_KEY;
  const from = process.env.EMAIL_FROM;
  const hasProvider = Boolean(region && accessKeyId && secretAccessKey && from);

  switch (chooseOtpDelivery({ hasProvider, nodeEnv: process.env.NODE_ENV })) {
    case "send":
      // Single Phase-B swap point — see the throwing stub below.
      return sendViaSes({ to, from: from!, code });
    case "dev-log":
      // LOCAL DEV MODE — code logged to console instead of emailed. The code
      // is a secret: NEVER log it outside development.
      console.log(
        `\n[Better Auth — OTP VERIFY DEV MODE]\n` +
          `  📧 Email : ${to}\n` +
          `  🔑 Code  : ${code}\n` +
          `  ⚠️  Set AWS_SES_* + EMAIL_FROM in .env to send real email.\n`
      );
      return;
    case "prod-unconfigured":
      // NEVER log the code here — this is production. Fail loudly in the server
      // logs instead; returns normally so Better Auth does not 500 (the user
      // simply won't receive a code — a deploy-misconfiguration state the SES
      // .env block exists to prevent).
      console.error(
        "[Better Auth] Email-OTP verification requested but no SES provider is " +
          "configured. Set AWS_SES_REGION + AWS_SES_ACCESS_KEY_ID + " +
          "AWS_SES_SECRET_ACCESS_KEY + EMAIL_FROM to deliver OTP emails."
      );
      return;
  }
}

/**
 * The real Amazon SES send (Phase B). Sends the OTP as a plain-text
 * transactional email via SESv2.
 *
 * The SES client is created lazily and memoised: the module is imported in the
 * auth path on every request, but the client (and its credential resolution)
 * is built once. `hasProvider` in the caller already guaranteed all four env
 * vars are present before this runs.
 *
 * The code is a SECRET — it is never logged on this path, only placed in the
 * email body sent to the verified recipient.
 */
let sesClient: import("@aws-sdk/client-sesv2").SESv2Client | undefined;

async function getSesClient(): Promise<import("@aws-sdk/client-sesv2").SESv2Client> {
  if (!sesClient) {
    const { SESv2Client } = await import("@aws-sdk/client-sesv2");
    sesClient = new SESv2Client({
      region: process.env.AWS_SES_REGION!,
      credentials: {
        accessKeyId: process.env.AWS_SES_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SES_SECRET_ACCESS_KEY!,
      },
    });
  }
  return sesClient;
}

async function sendViaSes(args: { to: string; from: string; code: string }): Promise<void> {
  const { to, from, code } = args;
  const { SendEmailCommand } = await import("@aws-sdk/client-sesv2");
  const client = await getSesClient();

  await client.send(
    new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: "Verify your email", Charset: "UTF-8" },
          Body: {
            Text: {
              Data: `Your Dojo verification code is: ${code}\n\nIt expires in 10 minutes. If you didn't request this, you can ignore this email.`,
              Charset: "UTF-8",
            },
          },
        },
      },
    })
  );
}
