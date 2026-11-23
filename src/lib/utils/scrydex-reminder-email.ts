/**
 * Scrydex reminder email builders — PURE (RULE 11). Plain text + simple HTML
 * (all interpolated values HTML-escaped). No secrets ever go in here.
 */
import { formatYMD, type Cycle, type YMD } from "@/lib/utils/scrydex-reminder";

export interface UsageView {
  remaining: number;
  total: number;
  percent: number;
}
export interface BuiltEmail {
  subject: string;
  text: string;
  html: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "15 Dec 2026" */
export const humanDate = (v: YMD): string => `${v.d} ${MONTHS[v.m - 1]} ${v.y}`;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const usageLine = (u: UsageView | null) =>
  u
    ? `Credits: ${u.remaining.toLocaleString("en-US")} of ${u.total.toLocaleString("en-US")} remaining (${u.percent.toFixed(1)}%). Scrydex updates usage with a 20-30 minute delay.`
    : "Credits: usage unavailable right now.";

function render(lines: string[], subject: string, prefix: string): BuiltEmail {
  const text = lines.join("\n");
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">` +
    lines.map((l) => (l === "" ? "<br>" : `<p style="margin:0 0 6px">${escapeHtml(l)}</p>`)).join("") +
    `</div>`;
  return { subject: prefix + subject, text, html };
}

export function buildRenewalEmail(a: {
  renewal: YMD;
  days: number;
  cycle: Cycle;
  planLabel: string | null;
  usage: UsageView | null;
  prefix: string;
}): BuiltEmail {
  const when = humanDate(a.renewal);
  const subject =
    a.days === 0
      ? `Scrydex renewal due TODAY (${when})`
      : `Scrydex renewal due in ${a.days} day${a.days === 1 ? "" : "s"} (${when})`;
  return render(
    [
      a.planLabel ? `Plan: ${a.planLabel}` : "Scrydex subscription",
      `Renewal date: ${when} (${formatYMD(a.renewal)})`,
      `Days left: ${a.days === 0 ? "0 (due today)" : a.days}`,
      `Billing cycle: ${a.cycle}`,
      "",
      "ACTION NEEDED: the American Express card on this subscription does NOT support auto-renewal, so the payment must be made MANUALLY in the Scrydex dashboard.",
      "",
      usageLine(a.usage),
      "",
      "After paying: nothing to change if the billing date stays the same (the app rolls the date forward by itself). Only if the billing date changes, update SCRYDEX_RENEWAL_DATE (YYYY-MM-DD) in the server .env and restart the app.",
    ],
    subject,
    a.prefix
  );
}

export function buildCreditEmail(a: {
  threshold: number;
  usage: UsageView;
  renewal: YMD;
  planLabel: string | null;
  prefix: string;
}): BuiltEmail {
  return render(
    [
      a.planLabel ? `Plan: ${a.planLabel}` : "Scrydex subscription",
      `Alert level: at or below ${a.threshold}% remaining`,
      usageLine(a.usage),
      `Next renewal: ${humanDate(a.renewal)}`,
      "",
      "Credits are used by card scans, card detail refreshes and daily price updates. If they run out, those features stop returning fresh data until the plan renews or is topped up in the Scrydex dashboard.",
      "Reminder: the American Express card does not auto-renew, so any renewal or top-up must be paid manually.",
    ],
    `Scrydex credits low: ${Math.round(a.usage.percent)}% remaining`,
    a.prefix
  );
}
