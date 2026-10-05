import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * FIX G (sec-audit) — requireAdmin re-reads isAdmin FRESH from the DB.
 *
 * The admin API guard must NOT trust the cookie-cached session claim (cached up
 * to 5 min). A user whose session still says isAdmin:true but who has been
 * demoted in the DB (dbUser.isAdmin:false) must get 403 immediately. Likewise a
 * fresh-DB admin passes even if the session claim is absent.
 */

const authMock = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: authMock.getSession } } }));

const prismaMock = vi.hoisted(() => ({ user: { findUnique: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

import { requireAdmin } from "@/lib/utils/auth-guard";

const req = () => new Request("http://localhost/api/admin/cards/abc", { method: "PATCH" });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireAdmin — fresh-DB isAdmin (FIX G)", () => {
  it("returns 403 when the session claims admin but the DB says NOT admin (real-time revocation)", async () => {
    // Stale session still carries isAdmin:true...
    authMock.getSession.mockResolvedValue({ user: { id: "u1", isAdmin: true } });
    // ...but the fresh DB read says the user was demoted.
    prismaMock.user.findUnique.mockResolvedValue({ isAdmin: false });

    const guard = await requireAdmin(req());

    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { id: "u1" },
      select: { isAdmin: true },
    });
    expect(guard.session).toBeNull();
    expect(guard.unauthorized?.status).toBe(403);
  });

  it("passes when the fresh DB read confirms admin (even if the session claim is absent)", async () => {
    authMock.getSession.mockResolvedValue({ user: { id: "u2" } });
    prismaMock.user.findUnique.mockResolvedValue({ isAdmin: true });

    const guard = await requireAdmin(req());

    expect(guard.unauthorized).toBeNull();
    expect(guard.session?.user.id).toBe("u2");
  });

  it("returns 401 when unauthenticated and never hits the DB", async () => {
    authMock.getSession.mockResolvedValue(null);

    const guard = await requireAdmin(req());

    expect(guard.unauthorized?.status).toBe(401);
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });
});
