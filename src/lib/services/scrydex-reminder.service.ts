/**
 * Scrydex renewal + low-credit reminder job (SERVER-ONLY).
 *
 * Triggered daily by GET /api/cron/scrydex-reminder. All settings come from
 * SCRYDEX_REMINDER_* env vars (see parseReminderConfig); invalid/missing config
 * NEVER throws — the summary just says why nothing was sent.
 *
 * IDEMPOTENCY: each notification is CLAIMED first by inserting a row into the
 * existing `verification` table with a deterministic id (create + catch P2002,
 * Prisma model calls only — no raw SQL, avoids the PgBouncer search_path issue
 * S-1; no schema change). Only the caller that wins the insert sends. The row's
 * expiresAt is just after the cycle so Better Auth's expired-row cleanup purges
 * it. Tradeoff: if the SEND fails the claim is deleted so the next run retries;
 * a crash between a successful send and a failed delete can therefore (rarely)
 * duplicate an email — chosen over silently LOSING a payment reminder.
 * With several recipients the claim is released only if EVERY send failed.
 */
import { prisma } from "@/lib/db";
import { sendSesEmail } from "@/lib/utils/ses-email";
import { subjectPrefix } from "@/lib/services/contact.service";
import { getScrydexUsage, readCachedUsage, type ScrydexUsage } from "@/lib/services/scrydex-usage.service";
import {
  creditPercent,
  daysUntil,
  dueReminder,
  formatYMD,
  newlyCrossed,
  nextRenewalDate,
  parseReminderConfig,
  todayInTz,
  type YMD,
} from "@/lib/utils/scrydex-reminder";
import {
  buildCreditEmail,
  buildRenewalEmail,
  type BuiltEmail,
} from "@/lib/utils/scrydex-reminder-email";

const P = "scrydex-reminder";
const DAY_MS = 86_400_000;

export interface ReminderSummary {
  enabled: boolean;
  dryRun: boolean;
  nextRenewal: string | null;
  daysUntil: number | null;
  renewalSent: boolean;
  credit: {
    remaining: number;
    total: number;
    percent: number;
    fetchedAt: string;
    threshold: number | null;
  } | null;
  creditSent: boolean;
  /** dryRun only: subjects that WOULD be sent. */
  wouldSend: { renewal: string | null; credit: string | null } | null;
  reason: string;
}

type Db = Pick<typeof prisma, "verification">;

const endOfCycle = (renewal: YMD) =>
  new Date(Date.UTC(renewal.y, renewal.m - 1, renewal.d) + 2 * DAY_MS);

/** true = we own this notification; false = someone already claimed it. */
async function claim(db: Db, id: string, value: object, expiresAt: Date): Promise<boolean> {
  try {
    await db.verification.create({
      data: { id, identifier: id, value: JSON.stringify(value), expiresAt },
    });
    return true;
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return false;
    throw err;
  }
}

async function release(db: Db, ids: string[]): Promise<void> {
  try {
    await db.verification.deleteMany({ where: { id: { in: ids } } });
  } catch (err) {
    console.error(`[${P}] failed to release claim:`, err instanceof Error ? err.message : "unknown");
  }
}

/** Send to every recipient; true if at least one delivery succeeded. */
async function sendAll(to: string[], mail: BuiltEmail): Promise<boolean> {
  const results = await Promise.allSettled(to.map((t) => sendSesEmail({ to: t, ...mail })));
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(`[${P}] send to recipient #${i + 1} failed:`, r.reason instanceof Error ? r.reason.message : "unknown");
    }
  });
  return results.some((r) => r.status === "fulfilled");
}

export async function runScrydexReminder(
  opts: { dryRun?: boolean; now?: Date; db?: Db } = {}
): Promise<ReminderSummary> {
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? new Date();
  const db = opts.db ?? prisma;
  const parsed = parseReminderConfig(process.env);
  const base: ReminderSummary = {
    enabled: parsed.enabled,
    dryRun,
    nextRenewal: null,
    daysUntil: null,
    renewalSent: false,
    credit: null,
    creditSent: false,
    wouldSend: dryRun ? { renewal: null, credit: null } : null,
    reason: "",
  };

  const cfg = parsed.config;
  if (!cfg) return { ...base, reason: `not configured / invalid: ${parsed.error}` };

  const today = todayInTz(now, cfg.tz);
  const { renewal, cycleStart } = nextRenewalDate(cfg.renewalDate, cfg.cycle, today);
  const days = daysUntil(renewal, today);
  base.nextRenewal = formatYMD(renewal);
  base.daysUntil = days;
  if (!parsed.enabled) return { ...base, reason: "disabled (SCRYDEX_REMINDER_ENABLED is not 'true')" };

  const prefix = subjectPrefix({
    prefix: process.env.CONTACT_SUBJECT_PREFIX,
    appUrl: process.env.NEXT_PUBLIC_APP_URL || process.env.BETTER_AUTH_URL,
  });
  const due = dueReminder(days, cfg.daysBefore);
  const wantCredit = cfg.lowCreditPercents.length > 0;
  const reasons: string[] = [];

  // Usage is best-effort: failure/gated => null, renewal reminder still goes out.
  // dryRun must be side-effect free (no live 1-credit call, no cache write):
  // it reads the cache only, so usage is "unavailable" when nothing is cached.
  let usage: ScrydexUsage | null = null;
  if (due !== null || wantCredit) usage = dryRun ? await readCachedUsage() : await getScrydexUsage(now);
  const pct = usage ? creditPercent(usage.remainingCredits, usage.totalCredits) : null;
  const usageView =
    usage && pct !== null
      ? { remaining: usage.remainingCredits, total: usage.totalCredits, percent: pct }
      : null;

  // ---- renewal reminder
  if (due !== null) {
    const id = `${P}:renewal:${formatYMD(renewal)}:${due}`;
    const mail = buildRenewalEmail({ renewal, days, cycle: cfg.cycle, planLabel: cfg.planLabel, usage: usageView, prefix });
    if (dryRun) {
      base.wouldSend!.renewal = mail.subject;
      reasons.push(`renewal reminder due (${due} day(s) before)`);
    } else {
      try {
        if (!(await claim(db, id, { sentAt: now.toISOString() }, endOfCycle(renewal)))) {
          reasons.push("renewal reminder already sent");
        } else if (await sendAll(cfg.to, mail)) {
          base.renewalSent = true;
          reasons.push("renewal reminder sent");
        } else {
          await release(db, [id]);
          reasons.push("renewal reminder send failed (will retry next run)");
        }
      } catch (err) {
        console.error(`[${P}] renewal step failed:`, err instanceof Error ? err.message : "unknown");
        reasons.push("renewal reminder error (see logs)");
      }
    }
  } else {
    reasons.push(`no renewal reminder today (${days} day(s) to renewal)`);
  }

  // ---- low-credit alert
  if (!wantCredit) {
    reasons.push("credit alert disabled");
  } else if (!usageView) {
    reasons.push("credit usage unavailable; credit alert skipped");
  } else {
    const cyc = formatYMD(cycleStart);
    try {
      const rows = await db.verification.findMany({
        where: { identifier: { startsWith: `${P}:credit:${cyc}:` } },
        select: { identifier: true },
      });
      const sent = new Set(rows.map((r) => Number(r.identifier.split(":").pop())));
      const crossed = newlyCrossed(usageView.percent, cfg.lowCreditPercents, sent);
      base.credit = {
        remaining: usageView.remaining,
        total: usageView.total,
        percent: usageView.percent,
        fetchedAt: usage!.fetchedAt,
        threshold: crossed[0] ?? null,
      };
      if (crossed.length === 0) {
        reasons.push("no new credit threshold crossed");
      } else {
        const mail = buildCreditEmail({ threshold: crossed[0], usage: usageView, renewal, planLabel: cfg.planLabel, prefix });
        if (dryRun) {
          base.wouldSend!.credit = mail.subject;
          reasons.push(`credit alert due (<= ${crossed[0]}%)`);
        } else {
          // Claim the most severe threshold; if we win, also mark the milder
          // crossed ones as covered (suppressed) so they don't fire next run.
          const exp = endOfCycle(renewal);
          const ids = crossed.map((t) => `${P}:credit:${cyc}:${t}`);
          if (!(await claim(db, ids[0], { threshold: crossed[0], sentAt: now.toISOString() }, exp))) {
            reasons.push("credit alert already sent");
          } else {
            const owned = [ids[0]];
            for (let i = 1; i < crossed.length; i++) {
              if (await claim(db, ids[i], { threshold: crossed[i], suppressedBy: crossed[0] }, exp)) owned.push(ids[i]);
            }
            if (await sendAll(cfg.to, mail)) {
              base.creditSent = true;
              reasons.push(`credit alert sent (<= ${crossed[0]}%)`);
            } else {
              await release(db, owned);
              reasons.push("credit alert send failed (will retry next run)");
            }
          }
        }
      }
    } catch (err) {
      console.error(`[${P}] credit step failed:`, err instanceof Error ? err.message : "unknown");
      reasons.push("credit alert error (see logs)");
    }
  }

  return { ...base, reason: reasons.join("; ") };
}
