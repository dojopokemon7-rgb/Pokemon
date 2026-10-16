import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * requireAdmin now gates on the ISOLATED admin session cookie
 * (`dojo_admin_session`), NOT Better Auth / Prisma `isAdmin`.
 *
 *  - no cookie / invalid cookie → 401, and Prisma is never touched.
 *  - a valid signed admin-session cookie → pass, with a synthetic env-admin
 *    session so downstream consumers keep `guard.session.user.{id,email}`.
 */

import { requireAdmin } from "@/lib/utils/auth-guard";
import { signAdminSession, ADMIN_SESSION_COOKIE } from "@/lib/utils/admin-session";

const SECRET = "test-admin-session-secret-abcdef";
// Throwaway dummy email — the real admin email lives only in .env (gitignored).
const ADMIN_EMAIL = "test-admin@example.com";

function reqWithCookie(cookie?: string): Request {
  return new Request("http://localhost/api/admin/cards/abc", {
    method: "PATCH",
    headers: cookie ? { cookie } : {},
  });
}

beforeEach(() => {
  process.env.ADMIN_SESSION_SECRET = SECRET;
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
});
afterEach(() => {
  delete process.env.ADMIN_SESSION_SECRET;
  delete process.env.ADMIN_EMAIL;
});

describe("requireAdmin — isolated admin session", () => {
  it("returns 401 when no admin-session cookie is present", async () => {
    const guard = await requireAdmin(reqWithCookie());
    expect(guard.session).toBeNull();
    expect(guard.unauthorized?.status).toBe(401);
  });

  it("returns 401 when the admin-session cookie is invalid/tampered", async () => {
    const guard = await requireAdmin(
      reqWithCookie(`${ADMIN_SESSION_COOKIE}=not-a-valid-token`)
    );
    expect(guard.session).toBeNull();
    expect(guard.unauthorized?.status).toBe(401);
  });

  it("passes with a valid signed admin-session cookie and exposes the env admin identity", async () => {
    const token = signAdminSession();
    const guard = await requireAdmin(reqWithCookie(`${ADMIN_SESSION_COOKIE}=${token}`));
    expect(guard.unauthorized).toBeNull();
    expect(guard.session?.user.id).toBe("env-admin");
    expect(guard.session?.user.email).toBe(ADMIN_EMAIL);
  });

  it("rejects an expired admin-session cookie", async () => {
    const expired = signAdminSession(-1);
    const guard = await requireAdmin(reqWithCookie(`${ADMIN_SESSION_COOKIE}=${expired}`));
    expect(guard.unauthorized?.status).toBe(401);
  });
});
