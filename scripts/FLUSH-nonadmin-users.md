# FLUSH NON-ADMIN USERS — one-time production-launch wipe

`scripts/flush-nonadmin-users.ts`

Deletes every **non-admin** user and all their owned data, keeping every admin
(and the admins' data) intact. Built for the single, deliberate data wipe at
full production launch to clear pre-launch test accounts.

> ⚠️ **DESTRUCTIVE / IRREVERSIBLE.** This permanently deletes user rows and all
> their cascaded data. There is no undo and no manifest. **Back up the database
> first.** Never run it against a database you cannot restore. Run it ONLY at
> production launch, and only after confirming the admin count in the dry-run.
> OWNER-RUN — never run by agents.

## What it DELETES (where `isAdmin = false`)

- the **User** rows themselves, which **cascade-delete** their:
  - `session`, `account`, named `collection`, `user_collection` lots, and
    `want_list` items (all `onDelete: Cascade` in `prisma/schema.prisma`);
- their **`scan_feedback`** rows — deleted **explicitly**, because
  `ScanFeedback.userId` is a bare nullable column with **no relation / no
  cascade**, so it would otherwise be orphaned. Anonymous (`userId: null`) scan
  rows are **left untouched**.

## What it KEEPS

- every `isAdmin = true` user and all of their data;
- **support tickets** — `SupportTicket.userId` is `onDelete: SetNull`, so the
  ticket is **preserved** (its `userId` nulled), not deleted;
- **verification tokens** — the `Verification` table has no user FK (keyed by
  email); leftover rows for flushed emails simply expire. Untouched.

## Safety guard

The ONLY selector is `where: { isAdmin: false }`. Before any delete, the script
counts admins and **refuses to `--apply` (non-zero exit) if zero admins would
remain** — so a misconfigured database can't accidentally wipe everyone. This
guard (`canFlushNonAdmins`) is covered by a test.

## Commands

Dry run (default — counts + a sample of ~5 emails, **no writes**):

```bash
npx tsx scripts/flush-nonadmin-users.ts
```

Execute the delete (**IRREVERSIBLE** — back up first, confirm the dry-run
admin count):

```bash
npx tsx scripts/flush-nonadmin-users.ts --apply
```

Both read `DATABASE_URL` from the environment. The `--apply` delete runs inside
a single `prisma.$transaction([...])` (all-or-nothing): the explicit
`scan_feedback` delete first, then the `user` delete that cascades the rest. A
second run finds zero non-admin users and deletes nothing (idempotent).
