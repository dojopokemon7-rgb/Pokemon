/**
 * Pure guard for the non-admin user flush (scripts/flush-nonadmin-users.ts).
 *
 * The destructive flush deletes every `isAdmin:false` user. This guard is the
 * one runnable check that logic leaves behind (AGENTS.md RULE 11): a flush is
 * SAFE to apply only when at least one admin would remain afterwards. If a
 * misconfigured DB has zero admins, applying the flush would nuke everyone —
 * so we refuse.
 *
 * Side-effect-free so it can be unit/integration-tested in isolation.
 */
export function canFlushNonAdmins(counts: {
  adminCount: number;
  nonAdminCount: number;
}): { allowed: boolean; reason?: string } {
  if (counts.adminCount < 1) {
    return {
      allowed: false,
      reason:
        "Refusing to flush: zero admin users would remain. The flush deletes " +
        "all non-admins and must leave at least one admin.",
    };
  }
  return { allowed: true };
}
