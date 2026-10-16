import { describe, it, expect, vi, beforeEach } from "vitest";
import { revokeAllAdmins, type AdminRevokePrisma } from "@/lib/utils/revoke-admins";

/**
 * revoke-all-admins guard — dry-run writes NOTHING; --apply flips rows and
 * keeps user rows (updateMany, never delete).
 */

function mockPrisma() {
  return {
    user: {
      count: vi.fn(async () => 3),
      findMany: vi.fn(async () => [{ email: "a@x.com" }, { email: "b@x.com" }]),
      updateMany: vi.fn(async () => ({ count: 3 })),
    },
  } satisfies AdminRevokePrisma;
}

let prisma: ReturnType<typeof mockPrisma>;
beforeEach(() => {
  prisma = mockPrisma();
});

describe("revokeAllAdmins", () => {
  it("DRY RUN counts rows and NEVER calls updateMany", async () => {
    const result = await revokeAllAdmins(prisma, { apply: false });
    expect(result.count).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.sampleEmails).toEqual(["a@x.com", "b@x.com"]);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("--apply flips isAdmin→false via updateMany (no delete) and reports the count", async () => {
    const result = await revokeAllAdmins(prisma, { apply: true });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { isAdmin: true },
      data: { isAdmin: false },
    });
    expect(result.updated).toBe(3);
    // No delete API is used — the helper's interface has no delete method,
    // so rows are preserved by construction.
  });
});
