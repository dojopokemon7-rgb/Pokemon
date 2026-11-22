/**
 * Contact form delivery. EMAIL ONLY — nothing is stored in the database (unlike
 * the authed support form, which persists a SupportTicket row and sends no
 * email). Reuses the project's SES client via sendSesEmail.
 *
 * `buildContactEmail` is pure (no env reads except the arguments) so it can be
 * unit-tested: HTML escaping, header-injection stripping, staging prefix.
 */
import { analyticsEnvironment } from "@/lib/analytics/environment";
import { sendSesEmail } from "@/lib/utils/ses-email";
import type { ContactInput } from "@/lib/validators/contact.validator";

export const DEFAULT_CONTACT_TO = "dojo.collect@nodwin.com";

/** Strips CR/LF (and Unicode line separators) so a value can sit in a header. */
export function headerSafe(s: string): string {
  return s.replace(/[\r\n\u0085\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * "[STAGING] " when running on staging. CONTACT_SUBJECT_PREFIX (explicit) wins;
 * otherwise the app URL host is classified like the analytics environment tag.
 */
export function subjectPrefix(env: {
  prefix?: string;
  appUrl?: string;
}): string {
  if (env.prefix !== undefined && env.prefix.trim() !== "") return headerSafe(env.prefix) + " ";
  try {
    if (env.appUrl && analyticsEnvironment(new URL(env.appUrl).hostname) === "staging") {
      return "[STAGING] ";
    }
  } catch {
    // unparseable URL -> no prefix
  }
  return "";
}

export interface ContactEmail {
  to: string;
  subject: string;
  replyTo: string;
  text: string;
  html: string;
}

export function buildContactEmail(
  input: ContactInput,
  opts: { to?: string; prefix: string; now?: Date }
): ContactEmail {
  const submittedAt = (opts.now ?? new Date()).toISOString();
  const topic = headerSafe(input.subject) || headerSafe(input.message).slice(0, 60);
  const rows: Array<[string, string]> = [
    ["Name", headerSafe(input.name)],
    ["Email", headerSafe(input.email)],
    ["Subject", headerSafe(input.subject) || "(none)"],
    ["Page", input.page],
    ["Submitted at", submittedAt],
  ];
  const text = `${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nMessage:\n${input.message}\n`;
  const html =
    `<table cellpadding="4" style="font-family:sans-serif;font-size:14px">` +
    rows.map(([k, v]) => `<tr><td><b>${k}</b></td><td>${escapeHtml(v)}</td></tr>`).join("") +
    `</table><p style="font-family:sans-serif;font-size:14px"><b>Message</b></p>` +
    `<div style="font-family:sans-serif;font-size:14px;white-space:pre-wrap">${escapeHtml(input.message)}</div>`;
  return {
    to: opts.to?.trim() || DEFAULT_CONTACT_TO,
    subject: `${opts.prefix}[Dojo Contact] ${topic}`,
    replyTo: headerSafe(input.email),
    text,
    html,
  };
}

/** Sends the visitor's message to the Dojo inbox. Throws if SES is unconfigured or the send fails. */
export async function sendContactMessage(input: ContactInput): Promise<void> {
  const mail = buildContactEmail(input, {
    to: process.env.CONTACT_TO_EMAIL,
    prefix: subjectPrefix({
      prefix: process.env.CONTACT_SUBJECT_PREFIX,
      appUrl: process.env.NEXT_PUBLIC_APP_URL || process.env.BETTER_AUTH_URL,
    }),
  });
  await sendSesEmail(mail);
}