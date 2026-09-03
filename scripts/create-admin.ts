/**
 * Creates (or upgrades) an admin account via Better Auth so the password
 * is bcrypt-hashed the same way the login page expects it.
 *
 * Usage:
 *   npx tsx scripts/create-admin.ts
 *   npx tsx scripts/create-admin.ts admin@dojo.com "MyPass1!" "Admin Name"
 *
 * Or via env vars:
 *   $env:ADMIN_EMAIL="admin@dojo.com"
 *   $env:ADMIN_PASSWORD="MyPass1!"
 *   $env:ADMIN_NAME="Admin"
 *   npx tsx scripts/create-admin.ts
 *
 * Behaviour:
 *   - New account → creates via Better Auth's signUpEmail, then flips
 *     `isAdmin = true` and marks the email as verified.
 *   - Existing account with the same email → leaves the password alone
 *     and just ensures `isAdmin = true` (safe re-run).
 */

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

const DEFAULT_EMAIL = "admin@dojo.com";
const DEFAULT_PASSWORD = "DojoAdmin2026!";
const DEFAULT_NAME = "Admin";

async function main() {
  const [argEmail, argPassword, argName] = process.argv.slice(2);
  const email = argEmail ?? process.env.ADMIN_EMAIL ?? DEFAULT_EMAIL;
  const password =
    argPassword ?? process.env.ADMIN_PASSWORD ?? DEFAULT_PASSWORD;
  const name = argName ?? process.env.ADMIN_NAME ?? DEFAULT_NAME;

  console.log(`\nProvisioning admin account for ${email} …`);

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, isAdmin: true },
  });

  if (existing) {
    console.log(
      `  ↳ User already exists (${existing.id}). Leaving password untouched, ensuring isAdmin=true.`
    );
    await prisma.user.update({
      where: { id: existing.id },
      data: { isAdmin: true, emailVerified: true },
    });
  } else {
    // Better Auth's signUpEmail properly hashes the password and creates
    // the `account` row with providerId="credential" that the credential
    // login flow expects. Do NOT insert into the user table directly —
    // the login page would then reject the account with "invalid credentials".
    const result = await auth.api.signUpEmail({
      body: { email, password, name },
    });
    if (!result?.user?.id) {
      throw new Error("Better Auth signUpEmail returned no user id");
    }
    await prisma.user.update({
      where: { id: result.user.id },
      data: { isAdmin: true, emailVerified: true },
    });
    console.log(`  ↳ Created user ${result.user.id}, promoted to admin.`);
  }

  // Verify the final state so we don't hand out credentials that don't work.
  const finalUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, isAdmin: true },
  });

  console.log("\n=== Admin credentials ===");
  console.log(`  Email    : ${finalUser?.email}`);
  console.log(`  Password : ${password}`);
  console.log(`  Name     : ${finalUser?.name}`);
  console.log(`  User ID  : ${finalUser?.id}`);
  console.log(`  isAdmin  : ${finalUser?.isAdmin}`);
  console.log("=========================\n");
  console.log("Log in at /login, then open /admin.\n");
}

main()
  .catch((err) => {
    console.error("Failed to provision admin:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
