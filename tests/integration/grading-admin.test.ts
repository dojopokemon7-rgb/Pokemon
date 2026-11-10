import { describe, it, expect, vi, beforeEach } from "vitest";

/** Admin export route + page gate for grading interest. Prisma/audit mocked. */
const db = vi.hoisted(() => ({
  gradingInterest: { count: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
const audit = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/utils/audit-log", () => audit);
const redirectMock = vi.hoisted(() => vi.fn(() => { throw new Error("NEXT_REDIRECT"); }));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));
const cookieStore = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (cookieStore.value ? { value: cookieStore.value } : undefined) }),
}));

import { GET } from "@/app/api/admin/grading-interest/export/route";
import AdminGradingInterestPage from "@/app/(admin)/admin/grading-interest/page";
import { signAdminSession, ADMIN_SESSION_COOKIE } from "@/lib/utils/admin-session";

const SECRET = "grading-admin-test-secret";
const req = (cookie?: string) =>
  new Request("http://localhost/api/admin/grading-interest/export", cookie ? { headers: { cookie } } : undefined);
const adminCookie = () => `${ADMIN_SESSION_COOKIE}=${signAdminSession()}`;

const T = new Date("2026-03-04T05:06:07.000Z");
const row = (email: string, source: string | null = "grading-page") => ({
  id: "i", email, category: "cards", volume: "1-10", source, joinedAt: T, updatedAt: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ADMIN_SESSION_SECRET", SECRET);
  vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
  vi.stubEnv("ADMIN_EMAIL", "admin@example.com");
  cookieStore.value = undefined;
});

describe("export route", () => {
  it("401 without an admin session; no DB read, no audit", async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(db.gradingInterest.count).not.toHaveBeenCalled();
    expect(audit.writeAuditLog).not.toHaveBeenCalled();
  });

  it("401 for a non-admin (Better Auth style) cookie", async () => {
    expect((await GET(req("better-auth.session_token=abc"))).status).toBe(401);
  });

  it("200 CSV: BOM, CRLF, header, quoting, injection-neutralized, headers, audit w/o row data", async () => {
    db.gradingInterest.count.mockResolvedValue(6);
    db.gradingInterest.findMany
      .mockResolvedValueOnce([
        row("=1+1@x.co"), row("+x@y.co"), row("-x@y.co"), row("@x"),
        row("a,b@y.co", 'he said "hi"\nbye'), row("ok@y.co", null),
      ])
      .mockResolvedValueOnce([]);
    const res = await GET(req(adminCookie()));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="grading-interest-\d{4}-\d{2}-\d{2}\.csv"$/
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM survives on the wire
    const text = "\uFEFF" + new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes).replace(/^\uFEFF/, "");
    expect(text.startsWith("\uFEFFemail,category,volume,joined_at,updated_at,source\r\n")).toBe(true);
    expect(text).toContain("'=1+1@x.co,cards,1-10,2026-03-04T05:06:07.000Z,,grading-page\r\n");
    expect(text).toContain("'+x@y.co,");
    expect(text).toContain("'-x@y.co,");
    expect(text).toContain("'@x,");
    expect(text).toContain('"a,b@y.co",cards,1-10,2026-03-04T05:06:07.000Z,,"he said ""hi""\nbye"\r\n');
    expect(text).toContain("ok@y.co,cards,1-10,2026-03-04T05:06:07.000Z,,\r\n");
    expect(text.replace(/\r\n/g, "").includes("\r")).toBe(false);
    expect(audit.writeAuditLog).toHaveBeenCalledTimes(1);
    const a = audit.writeAuditLog.mock.calls[0][0];
    expect(a).toMatchObject({ action: "grading_interest.export", details: { rowCount: 6 } });
    expect(JSON.stringify(a.details)).not.toContain("@");
  });

  it("missing table -> honest 500 message", async () => {
    db.gradingInterest.count.mockRejectedValue(Object.assign(new Error("x"), { code: "P2021" }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(req(adminCookie()));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/run the grading_interest migration/);
  });
});

describe("admin page", () => {
  it("redirects to /admin without an admin session (no DB read)", async () => {
    await expect(AdminGradingInterestPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_REDIRECT");
    expect(redirectMock).toHaveBeenCalledWith("/admin");
    expect(db.gradingInterest.count).not.toHaveBeenCalled();
  });

  it("renders for an admin; missing table shows the migration message", async () => {
    cookieStore.value = signAdminSession();
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.gradingInterest.count.mockRejectedValue(Object.assign(new Error("x"), { code: "P2021" }));
    db.gradingInterest.groupBy.mockResolvedValue([]);
    db.gradingInterest.findMany.mockResolvedValue([]);
    const el = await AdminGradingInterestPage({ searchParams: Promise.resolve({ offset: "-5" }) });
    expect(JSON.stringify(el)).toContain("Table not created");
  });
});
