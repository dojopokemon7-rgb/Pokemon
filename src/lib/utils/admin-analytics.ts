/**
 * admin-analytics — pure, deterministic time-series helpers for the admin
 * analytics charts. No Prisma, no I/O: the service (admin-metrics.ts) runs the
 * grouped SQL and feeds the raw per-day rows here to be gap-filled / accumulated.
 *
 * All day buckets are UTC (the SQL uses `date_trunc('day', … AT TIME ZONE 'UTC')`
 * — see admin-metrics.ts). Keeping bucketing UTC here avoids the server's local
 * timezone shifting a row into the wrong day.
 */

/** A single day bucket: ISO date (YYYY-MM-DD, UTC) → integer count. */
export interface DailyCount {
  date: string;
  count: number;
}

/** Format a Date as a UTC YYYY-MM-DD day key. */
export function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Densify a sparse list of per-day counts into a continuous daily series from
 * `start` to `end` (both inclusive, UTC), inserting 0 for days with no rows.
 * Charts need a gap-free x-axis; a real zero-activity day is an HONEST 0, not a
 * fabricated point (the days exist, the count really is zero).
 *
 * `rows` may be unordered and may contain days outside [start, end]; out-of-range
 * days are ignored and in-range duplicates are summed.
 */
export function fillDailyRange(
  rows: readonly DailyCount[],
  start: Date,
  end: Date
): DailyCount[] {
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.count);

  const out: DailyCount[] = [];
  // Iterate day-by-day in UTC. Advancing by setUTCDate avoids DST hour drift
  // (adding 86_400_000 ms can skip/repeat a day across a DST boundary).
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  while (cur.getTime() <= last) {
    const key = utcDayKey(cur);
    out.push({ date: key, count: byDay.get(key) ?? 0 });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/** A single day bucket for scan activity: successful vs failed scan counts. */
export interface ScanDailyCount {
  date: string;
  success: number;
  fail: number;
}

/**
 * Densify a sparse list of per-day scan rows (success/fail split) into a
 * continuous daily series from `start` to `end` (both inclusive, UTC), inserting
 * {success:0, fail:0} for days with no scans. Same honest-zero contract as
 * fillDailyRange — a quiet scanning day is a real 0/0, not a fabricated point.
 *
 * `rows` may be unordered; out-of-range days are ignored and in-range duplicates
 * are summed per field.
 */
export function fillScanDailyRange(
  rows: readonly ScanDailyCount[],
  start: Date,
  end: Date
): ScanDailyCount[] {
  const byDay = new Map<string, { success: number; fail: number }>();
  for (const r of rows) {
    const prev = byDay.get(r.date) ?? { success: 0, fail: 0 };
    byDay.set(r.date, {
      success: prev.success + r.success,
      fail: prev.fail + r.fail,
    });
  }

  const out: ScanDailyCount[] = [];
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  while (cur.getTime() <= last) {
    const key = utcDayKey(cur);
    const v = byDay.get(key) ?? { success: 0, fail: 0 };
    out.push({ date: key, success: v.success, fail: v.fail });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/**
 * Running total of a daily series. `baseline` is the count that already existed
 * BEFORE the first bucket (e.g. users created before the range start) so the
 * growth curve starts at the true platform total, not at 0.
 */
export function toCumulative(
  daily: readonly DailyCount[],
  baseline = 0
): DailyCount[] {
  let running = baseline;
  return daily.map((d) => {
    running += d.count;
    return { date: d.date, count: running };
  });
}
