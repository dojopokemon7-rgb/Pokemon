/**
 * Read-only "Scrydex billing" card for the admin overview. Shows the parsed
 * SCRYDEX_REMINDER_* settings and the LAST CACHED credit reading (never calls
 * Scrydex — a live read costs 1 credit). Server component; the page already
 * ran requireAdminPage().
 */
import { readCachedUsage } from "@/lib/services/scrydex-usage.service";
import { creditPercent, daysUntil, formatYMD, nextRenewalDate, parseReminderConfig, todayInTz } from "@/lib/utils/scrydex-reminder";
import { humanDate } from "@/lib/utils/scrydex-reminder-email";

export async function ScrydexBillingCard() {
  const parsed = parseReminderConfig(process.env);
  const cfg = parsed.config;
  const usage = await readCachedUsage();
  const pct = usage ? creditPercent(usage.remainingCredits, usage.totalCredits) : null;
  let next: string | null = null;
  if (cfg) {
    const today = todayInTz(new Date(), cfg.tz);
    const { renewal } = nextRenewalDate(cfg.renewalDate, cfg.cycle, today);
    const days = daysUntil(renewal, today);
    next = `${humanDate(renewal)} (${formatYMD(renewal)}) · ${days === 0 ? "due today" : `${days} day${days === 1 ? "" : "s"} left`}`;
  }
  const rows: [string, string][] = [
    ["Reminders", parsed.enabled ? "Enabled" : "Disabled"],
    ["Settings", parsed.error ? `Invalid: ${parsed.error}` : "Valid"],
    ["Cycle", cfg ? `${cfg.cycle} (timezone ${cfg.tz})` : "—"],
    ["Next renewal", next ?? "—"],
    ["Reminder days before", cfg ? cfg.daysBefore.join(", ") || "—" : "—"],
    ["Low-credit thresholds", cfg ? (cfg.lowCreditPercents.length ? cfg.lowCreditPercents.map((p) => `${p}%`).join(", ") : "Disabled") : "—"],
    ["Recipients", cfg ? cfg.to.join(", ") : "—"],
    [
      "Latest credit usage",
      usage && pct !== null
        ? `${usage.remainingCredits.toLocaleString("en-US")} of ${usage.totalCredits.toLocaleString("en-US")} remaining (${pct.toFixed(1)}%) · read ${new Date(usage.fetchedAt).toISOString().slice(0, 16).replace("T", " ")} UTC`
        : "Unavailable (no cached reading yet)",
    ],
  ];
  return (
    <section style={{ marginBottom: "36px" }}>
      <div className="dojo-step-label" style={{ fontSize: "10px", marginBottom: "12px", color: "var(--color-dojo-body)" }}>
        Scrydex billing{cfg?.planLabel ? ` · ${cfg.planLabel}` : ""}
      </div>
      <dl style={{ margin: 0, background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)" }}>
        {rows.map(([k, v], i) => (
          <div key={k} style={{ display: "flex", gap: "16px", padding: "12px 20px", borderTop: i === 0 ? "none" : "1px solid var(--color-dojo-divider)" }}>
            <dt className="dojo-faint" style={{ width: 200, flex: "none", fontSize: "12px" }}>{k}</dt>
            <dd style={{ margin: 0, color: "var(--color-dojo-ink)", fontSize: "13px", minWidth: 0, overflowWrap: "anywhere" }}>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="dojo-faint" style={{ fontSize: "11px", marginTop: "8px" }}>
        Read-only. Change values in the server .env (see docs/SCRYDEX_REMINDERS.md).
      </p>
    </section>
  );
}