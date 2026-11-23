import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
/**
 * /api/cron/scrydex-reminder — auth, idempotent claim/send, dryRun, failure
 * paths. Prisma, SES, Scrydex usage and Redis are mocked: no DB, no network.
 */
const m = vi.hoisted(() => {
  const rows = new Map<string, { id: string; identifier: string }>();
  const verification = {
    create: vi.fn(async ({ data }: { data: { id: string; identifier: string } }) => {
      if (rows.has(data.id)) throw Object.assign(new Error("dup"), { code: "P2002" });
      rows.set(data.id, data);
      return data;
    }),
    deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
      where.id.in.forEach((i) => rows.delete(i));
      return { count: 1 };
    }),
    findMany: vi.fn(async ({ where }: { where: { identifier: { startsWith: string } } }) =>
      [...rows.values()].filter((r) => r.identifier.startsWith(where.identifier.startsWith))
    ),
  };
  return { rows, verification, send: vi.fn(), usage: vi.fn(), cached: vi.fn() };
});
vi.mock("@/lib/db", () => ({ prisma: { verification: m.verification } }));
vi.mock("@/lib/utils/ses-email", () => ({ sendSesEmail: m.send }));
vi.mock("@/lib/services/scrydex-usage.service", () => ({ getScrydexUsage: m.usage, readCachedUsage: m.cached }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/cron/scrydex-reminder/route";

const SECRET = "s3cr3t";
const ENV0 = { ...process.env };
const NOW = new Date("2026-12-08T06:00:00Z"); // 11:30 IST; 7 days before 15 Dec
const req = (q = "", bearer: string | null = SECRET) =>
  new NextRequest(`http://localhost/api/cron/scrydex-reminder${q}`, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
const usage = (remaining: number) => ({ totalCredits: 1000, remainingCredits: remaining, usedCredits: 0, overageCreditRate: null, fetchedAt: NOW.toISOString() });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  m.rows.clear();
  m.send.mockResolvedValue(undefined);
  m.usage.mockResolvedValue(usage(900));
  process.env = {
    ...ENV0,
    CRON_SECRET: SECRET,
    SCRYDEX_REMINDER_ENABLED: "true",
    SCRYDEX_RENEWAL_DATE: "2026-12-15",
    SCRYDEX_REMINDER_TO: "a@x.com,b@x.com",
    SCRYDEX_PLAN_LABEL: "Pro <b>",
  };
  delete process.env.CONTACT_SUBJECT_PREFIX;
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.BETTER_AUTH_URL;
});
afterEach(() => {
  vi.useRealTimers();
  process.env = { ...ENV0 };
});

describe("auth", () => {
  it("401 without / with wrong secret, job not run", async () => {
    expect((await GET(req("", null))).status).toBe(401);
    expect((await GET(req("", "nope"))).status).toBe(401);
    expect(m.send).not.toHaveBeenCalled();
  });
  it("fail-closed in production when CRON_SECRET unset", async () => {
    delete process.env.CRON_SECRET;
    (process.env as Record<string, string>).NODE_ENV = "production";
    expect((await GET(req("", null))).status).toBe(401);
  });
  it("?secret= works", async () => {
    expect((await GET(req(`?secret=${SECRET}`, null))).status).toBe(200);
  });
});

describe("job", () => {
  it("disabled -> no send", async () => {
    process.env.SCRYDEX_REMINDER_ENABLED = "false";
    const j = await (await GET(req())).json();
    expect(j.enabled).toBe(false);
    expect(j.reason).toContain("disabled");
    expect(m.send).not.toHaveBeenCalled();
  });
  it("invalid config -> 200, reason, no send", async () => {
    process.env.SCRYDEX_RENEWAL_DATE = "garbage";
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).reason).toContain("not configured / invalid");
    expect(m.send).not.toHaveBeenCalled();
  });
  it("due day -> one email per recipient with correct subject; escaped html", async () => {
    const j = await (await GET(req())).json();
    expect(j).toMatchObject({ renewalSent: true, nextRenewal: "2026-12-15", daysUntil: 7, creditSent: false });
    expect(m.send).toHaveBeenCalledTimes(2);
    expect(m.send.mock.calls.map((c) => c[0].to)).toEqual(["a@x.com", "b@x.com"]);
    const mail = m.send.mock.calls[0][0];
    expect(mail.subject).toBe("Scrydex renewal due in 7 days (15 Dec 2026)");
    expect(mail.text).toContain("does NOT support auto-renewal");
    expect(mail.html).toContain("Pro &lt;b&gt;");
    expect(m.rows.has("scrydex-reminder:renewal:2026-12-15:7")).toBe(true);
  });
  it("second run same day -> no duplicate", async () => {
    await GET(req());
    m.send.mockClear();
    const j = await (await GET(req())).json();
    expect(j.renewalSent).toBe(false);
    expect(j.reason).toContain("already sent");
    expect(m.send).not.toHaveBeenCalled();
  });
  it("send failure -> claim released, next run retries", async () => {
    m.send.mockRejectedValue(new Error("ses down"));
    const j = await (await GET(req())).json();
    expect(j.renewalSent).toBe(false);
    expect(m.rows.size).toBe(0);
    m.send.mockResolvedValue(undefined);
    expect((await (await GET(req())).json()).renewalSent).toBe(true);
  });
  it("dryRun -> no claim, no send, reports subject", async () => {
    const j = await (await GET(req("?dryRun=1"))).json();
    expect(j.dryRun).toBe(true);
    expect(j.wouldSend.renewal).toContain("due in 7 days");
    expect(m.send).not.toHaveBeenCalled();
    expect(m.verification.create).not.toHaveBeenCalled();
  });
  it("dryRun never makes the live usage call; uses cache only", async () => {
    m.cached.mockResolvedValue(usage(900));
    const j = await (await GET(req("?dryRun=1"))).json();
    expect(m.usage).not.toHaveBeenCalled();
    expect(m.cached).toHaveBeenCalled();
    expect(j.credit).toMatchObject({ remaining: 900, total: 1000 });
    m.cached.mockResolvedValue(null);
    const k = await (await GET(req("?dryRun=1"))).json();
    expect(m.usage).not.toHaveBeenCalled();
    expect(k.credit).toBeNull();
    expect(k.reason).toContain("credit alert skipped");
  });
  it("usage unavailable -> renewal still sent, credit skipped", async () => {
    m.usage.mockResolvedValue(null);
    const j = await (await GET(req())).json();
    expect(j.renewalSent).toBe(true);
    expect(j.credit).toBeNull();
    expect(j.reason).toContain("credit alert skipped");
    expect(m.send.mock.calls[0][0].text).toContain("usage unavailable");
  });
  it("non-due day + low credit -> only most severe threshold, once per cycle", async () => {
    process.env.SCRYDEX_RENEWAL_DATE = "2026-12-25";
    m.usage.mockResolvedValue(usage(40)); // 4% -> crosses 20 and 5
    const j = await (await GET(req())).json();
    expect(j).toMatchObject({ renewalSent: false, creditSent: true });
    expect(m.send.mock.calls[0][0].subject).toBe("Scrydex credits low: 4% remaining");
    m.send.mockClear();
    expect((await (await GET(req())).json()).creditSent).toBe(false);
    expect(m.send).not.toHaveBeenCalled();
  });
  it("staging prefix", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://staging.dojocollect.com";
    await GET(req());
    expect(m.send.mock.calls[0][0].subject.startsWith("[STAGING] ")).toBe(true);
  });
});
