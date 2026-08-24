/**
 * Prisma Client Singleton
 *
 * In Next.js development, the module hot-reload cycle creates new PrismaClient
 * instances on every reload, quickly exhausting the database connection pool.
 * This singleton pattern stores the client on the global object in development
 * so it persists across hot reloads.
 *
 * In production (Next.js standalone / Docker), the module is only evaluated
 * once, so a simple `new PrismaClient()` would also work — but the singleton
 * is harmless and consistent.
 */

import { PrismaClient } from "@prisma/client";

// Extend the global type to include our prisma instance
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
