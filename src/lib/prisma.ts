import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"]
  });

// Cache on globalThis in every environment: besides surviving dev hot reloads, this lets the custom
// server (server.ts) and the Next.js route handlers running in the same process share one pool.
globalForPrisma.prisma = prisma;
