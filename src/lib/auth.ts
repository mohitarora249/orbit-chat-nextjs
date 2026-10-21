import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./prisma";
import { provisionNewUser } from "./workspace";

const appUrl = process.env.BETTER_AUTH_URL || process.env.NEXT_PUBLIC_APP_URL || `http://localhost:${process.env.PORT || 3000}`;
const avatarPalette = ["#635BFF", "#E879A9", "#0EA5A4", "#F59E0B", "#3B82F6", "#EF4444", "#10B981"];

export const auth = betterAuth({
  appName: process.env.NEXT_PUBLIC_APP_NAME || "Orbit Chat",
  baseURL: appUrl,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: [appUrl],
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 128 },
  user: {
    // Better Auth's `name` is stored in the existing `displayName` column.
    fields: { name: "displayName" },
    additionalFields: { avatarColor: { type: "string", required: false, input: false } }
  },
  session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
  advanced: { database: { generateId: false } },
  databaseHooks: {
    user: {
      create: {
        before: async user => ({
          data: { ...user, avatarColor: avatarPalette[Math.floor(Math.random() * avatarPalette.length)] }
        }),
        after: async user => {
          await provisionNewUser(user.id);
        }
      }
    }
  }
});

export type AuthSession = typeof auth.$Infer.Session;
