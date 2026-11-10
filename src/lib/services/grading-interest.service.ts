/**
 * Grading-interest (CGC notify-me) persistence + admin reads.
 *
 * Uses Prisma MODEL calls only (never raw SQL) so queries are schema-qualified
 * and immune to the PgBouncer search_path issue (S-1).
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { GradingInterestInput } from "@/lib/validators/grading-interest.validator";

type Db = Pick<typeof prisma, "gradingInterest">;

/**
 * One row per (lowercased) email. A repeat submit updates category/volume in
 * place and stamps updatedAt. Two concurrent first-time submits can both miss
 * the existing row; the loser hits P2002 on the unique email and retries as a
 * plain update, so a duplicate row is impossible. Last writer wins on answers.
 */
export async function upsertGradingInterest(
  input: GradingInterestInput,
  db: Db = prisma
): Promise<void> {
  const update = { category: input.category, volume: input.volume, updatedAt: new Date() };
  try {
    await db.gradingInterest.upsert({
      where: { email: input.email },
      create: {
        email: input.email,
        category: input.category,
        volume: input.volume,
        source: input.source,
      },
      update,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      await db.gradingInterest.update({ where: { email: input.email }, data: update });
      return;
    }
    throw err;
  }
}

/** True when the error means the grading_interest table has not been created. */
export function isMissingTable(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === "P2021") return true;
  return /relation .*grading_interest.* does not exist/i.test(
    err instanceof Error ? err.message : String(err)
  );
}

export const GRADING_PAGE_SIZE = 50;

export async function getGradingInterestOverview(offset: number, db: Db = prisma) {
  const [total, byCategory, byVolume, rows] = await Promise.all([
    db.gradingInterest.count(),
    db.gradingInterest.groupBy({ by: ["category"], _count: { _all: true } }),
    db.gradingInterest.groupBy({ by: ["volume"], _count: { _all: true } }),
    db.gradingInterest.findMany({
      orderBy: [{ joinedAt: "desc" }, { id: "desc" }],
      skip: offset,
      take: GRADING_PAGE_SIZE,
    }),
  ]);
  const tally = <K extends string>(g: Array<{ _count: { _all: number } } & Record<K, string>>, k: K) =>
    Object.fromEntries(g.map((r) => [r[k], r._count._all])) as Record<string, number>;
  return {
    total,
    byCategory: tally(byCategory, "category"),
    byVolume: tally(byVolume, "volume"),
    rows,
  };
}
