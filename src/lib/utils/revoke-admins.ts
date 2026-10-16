/**
 * Core of scripts/revoke-all-admins.ts — isolated so it is unit-testable with a
 * mocked Prisma client (AGENTS.md RULE 11: logic leaves one runnable check).
 *
 * Dry-run (default) COUNTS rows where isAdmin=true and writes NOTHING. `--apply`
 * flips them to isAdmin=false via a single `updateMany` and KEEPS every row (no
 * deletes). Returns the counts + a small email sample for the script's report.
 */

/** The slice of the Prisma client this helper needs — keeps the test mock tiny. */
export interface AdminRevokePrisma {
  user: {
    findMany(args: {
      where: { isAdmin: boolean };
      select: { email: true };
      take?: number;
    }): Promise<{ email: string }[]>;
    count(args: { where: { isAdmin: boolean } }): Promise<number>;
    updateMany(args: {
      where: { isAdmin: boolean };
      data: { isAdmin: boolean };
    }): Promise<{ count: number }>;
  };
}

export interface RevokeResult {
  /** How many rows currently have isAdmin=true. */
  count: number;
  /** Up to 5 example emails of those rows (for the report). */
  sampleEmails: string[];
  /** Rows actually updated (0 on a dry run). */
  updated: number;
}

export async function revokeAllAdmins(
  prisma: AdminRevokePrisma,
  opts: { apply: boolean }
): Promise<RevokeResult> {
  const [count, sample] = await Promise.all([
    prisma.user.count({ where: { isAdmin: true } }),
    prisma.user.findMany({ where: { isAdmin: true }, select: { email: true }, take: 5 }),
  ]);
  const sampleEmails = sample.map((u) => u.email);

  if (!opts.apply) {
    // DRY RUN — never call updateMany.
    return { count, sampleEmails, updated: 0 };
  }

  const { count: updated } = await prisma.user.updateMany({
    where: { isAdmin: true },
    data: { isAdmin: false },
  });
  return { count, sampleEmails, updated };
}
