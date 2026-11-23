import { sendSesEmail } from "@/lib/utils/ses-email";

/**
 * Pure delivery-mode decision for password-reset emails.
 *
 *   'send'              — a real email provider is configured (SES, else legacy\n *                         Resend); actually send.
 *   'dev-log'           — no provider, local dev; log the link to the console
 *                         so the reset flow is testable (dev-only — the link
 *                         is a secret and must never be logged in prod).
 *   'prod-unconfigured' — no provider, NOT dev; the caller must surface a
 *                         server error, never silently "succeed" (a user who
 *                         requested a reset would otherwise wait forever).
 *
 * Side-effect-free so it can be unit-tested in isolation (AGENTS.md RULE 11).
 */
export function chooseResetDelivery(env: {
  hasProvider: boolean;
  nodeEnv: string | undefined;
}): "send" | "dev-log" | "prod-unconfigured" {
  if (env.hasProvider) return "send";
  return env.nodeEnv === "development" ? "dev-log" : "prod-unconfigured";
}
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Better Auth's default reset-token lifetime is 3600s (no override in auth.ts). */
export function buildResetEmail(url: string): { subject: string; text: string; html: string } {
  return {
    subject: "Reset your Dojo password",
    text: `Click the link to reset your Dojo password:\n\n${url}\n\nIt expires in 1 hour. If you didn't request this, you can safely ignore this email.`,
    html:
      `<p>Click the link below to reset your Dojo password:</p>` +
      `<p><a href="${esc(url)}">Reset your password</a></p>` +
      `<p>It expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>`,
  };
}

/**
 * Delivers a password-reset email. Called from Better Auth's `sendResetPassword`.
 *
 * Provider order: Amazon SES (AWS_SES_* + EMAIL_FROM, same sender as OTP and
 * contact mail) → legacy Resend (RESEND_API_KEY + EMAIL_FROM) → dev console log
 * → prod "unconfigured" error. The link is a secret: it is never logged outside
 * development, and a send failure is logged WITHOUT the link, token or address.
 * Failures are swallowed so the client always gets Better Auth's generic,
 * enumeration-safe response.
 */
export async function sendResetPasswordEmail(args: { to: string; url: string }): Promise<void> {
  const { to, url } = args;
  const from = process.env.EMAIL_FROM;
  const hasSes = Boolean(
    process.env.AWS_SES_REGION &&
      process.env.AWS_SES_ACCESS_KEY_ID &&
      process.env.AWS_SES_SECRET_ACCESS_KEY &&
      from
  );
  const resendKey = process.env.RESEND_API_KEY;
  const hasResend = Boolean(resendKey && from);
  const mail = buildResetEmail(url);
  switch (chooseResetDelivery({ hasProvider: hasSes || hasResend, nodeEnv: process.env.NODE_ENV })) {
    case "send":
      try {
        if (hasSes) {
          await sendSesEmail({ to, ...mail });
        } else {
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from, to, ...mail }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        }
      } catch (err) {
        // No link / token / address in the log (err may be an AWS error: log name only).
        console.error(
          `[Better Auth] Password reset email failed to send (${hasSes ? "ses" : "resend"}: ${
            err instanceof Error ? err.name : "error"
          }).`
        );
      }
      return;
    case "dev-log":
      console.log(
        `\n[Better Auth — RESET PASSWORD DEV MODE]\n` +
          `  📧 Email : ${to}\n` +
          `  🔗 Link  : ${url}\n` +
          `  ⚠️  No email provider configured — copy this link to test the reset flow.\n`
      );
      return;
    case "prod-unconfigured":
      // NEVER log the url here — this is production.
      console.error(
        "[Better Auth] Password reset requested but no email provider is configured. " +
          "Set AWS_SES_REGION + AWS_SES_ACCESS_KEY_ID + AWS_SES_SECRET_ACCESS_KEY + EMAIL_FROM."
      );
      return;
  }
}