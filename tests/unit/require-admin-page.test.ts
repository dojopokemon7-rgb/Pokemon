import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Per-page admin backstop decision logic (src/lib/utils/require-admin-page.ts).
 *
 * The RSC backstop (audit 10 F1) mirrors the (admin)/admin layout: read the
 * `dojo_admin_session` cookie and verify it with the SAME `verifyAdminSession`,
 * redirecting to /admin on failure BEFORE any PII read runs.
 *
 * Cookie + redirect are server-only Next primitives, so we mock them:
 *   - next/headers `cookies()` → a store returning the token under test;
 *   - next/navigation `redirect()` → throws (as Next's does) so we can assert it fired;
 *   - verifyAdminSession → stubbed true/false to drive each branch.
 *
 * Contracts proven:
 *   (a) valid session   → returns (no redirect), verifier saw the cookie value;
 *   (b) invalid session → redirect("/admin") fired;
 *   (c) missing cookie  → redirect("/admin") fired (undefined token → invalid).
 */

const cookieMock = vi.hoisted(() => ({ value: undefined as string | undefined }));
const verifyMock = vi.hoisted(() => vi.fn<(t: string | null | undefined) => boolean>());
const redirectMock = vi.hoisted(() =>
  vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  })
);

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (_name: string) =>
      cookieMock.value === undefined ? undefined : { value: cookieMock.value },
  }),
}));

vi.mock("next/navigation", () => ({ redirect: redirectMock }));

vi.mock("@/lib/utils/admin-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils/admin-session")>();
  return { ...actual, verifyAdminSession: verifyMock };
});

import { requireAdminPage } from "@/lib/utils/require-admin-page";

beforeEach(() => {
  vi.clearAllMocks();
  cookieMock.value = undefined;
});

describe("requireAdminPage — decision logic (audit 10 F1)", () => {
  it("returns without redirecting when the session verifies (passes the cookie value)", async () => {
    cookieMock.value = "valid.token";
    verifyMock.mockReturnValue(true);

    await expect(requireAdminPage()).resolves.toBeUndefined();
    expect(verifyMock).toHaveBeenCalledWith("valid.token");
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("redirects to /admin when the session is invalid", async () => {
    cookieMock.value = "tampered.token";
    verifyMock.mockReturnValue(false);

    await expect(requireAdminPage()).rejects.toThrow("NEXT_REDIRECT:/admin");
    expect(redirectMock).toHaveBeenCalledWith("/admin");
  });

  it("redirects to /admin when the admin cookie is missing", async () => {
    cookieMock.value = undefined;
    verifyMock.mockReturnValue(false);

    await expect(requireAdminPage()).rejects.toThrow("NEXT_REDIRECT:/admin");
    expect(verifyMock).toHaveBeenCalledWith(undefined);
    expect(redirectMock).toHaveBeenCalledWith("/admin");
  });
});
