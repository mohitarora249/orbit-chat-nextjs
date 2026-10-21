import { PrismaClient } from "@prisma/client";
import { hashPassword } from "better-auth/crypto";

const prisma = new PrismaClient();

// Local development only: every seeded person signs in with this password.
const DEMO_PASSWORD = "orbit-demo-123";

async function main() {
  const workspace = await prisma.workspace.upsert({
    where: { slug: "acme" },
    update: {},
    create: { name: "Acme Studio", slug: "acme" }
  });

  const people = [
    { displayName: "Mohit Arora", email: "mohit@example.com", avatarColor: "#635BFF" },
    { displayName: "Aisha Khan", email: "aisha@example.com", avatarColor: "#E879A9" },
    { displayName: "Rohan Mehta", email: "rohan@example.com", avatarColor: "#0EA5A4" }
  ];

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  for (const person of people) {
    const user = await prisma.user.upsert({
      where: { email: person.email },
      update: { displayName: person.displayName, avatarColor: person.avatarColor },
      create: { ...person, emailVerified: true }
    });
    // Better Auth email/password credentials live on an Account with providerId "credential".
    const credential = await prisma.account.findFirst({ where: { userId: user.id, providerId: "credential" } });
    if (!credential) {
      await prisma.account.create({ data: { userId: user.id, accountId: user.id, providerId: "credential", password: passwordHash } });
    }
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
      update: {},
      create: { workspaceId: workspace.id, userId: user.id, role: user.displayName === "Mohit Arora" ? "OWNER" : "MEMBER" }
    });
  }

  const users = await prisma.user.findMany({ where: { email: { in: people.map(p => p.email) } } });
  for (const name of ["general", "engineering", "design", "random"]) {
    const conversation = await prisma.conversation.upsert({
      where: { workspaceId_type_name: { workspaceId: workspace.id, type: "CHANNEL", name } },
      update: {},
      create: { workspaceId: workspace.id, name, type: "CHANNEL", isPrivate: false }
    });
    for (const user of users) {
      await prisma.conversationMember.upsert({
        where: { conversationId_userId: { conversationId: conversation.id, userId: user.id } },
        update: {},
        create: { conversationId: conversation.id, userId: user.id }
      });
    }
  }

  const general = await prisma.conversation.findFirst({ where: { workspaceId: workspace.id, type: "CHANNEL", name: "general" } });
  const mohit = users.find(user => user.email === "mohit@example.com");
  const aisha = users.find(user => user.email === "aisha@example.com");
  if (general && mohit && aisha) {
    const count = await prisma.message.count({ where: { conversationId: general.id } });
    if (!count) {
      await prisma.message.createMany({
        data: [
          { conversationId: general.id, authorId: aisha.id, clientMessageId: "seed-welcome-1", body: "Welcome to the workspace! 👋" },
          { conversationId: general.id, authorId: mohit.id, clientMessageId: "seed-welcome-2", body: "Messages are persisted in PostgreSQL and delivered live over Socket.IO through a transactional outbox." }
        ]
      });
    }
  }
  console.log(`Seed complete. Demo users sign in with password "${DEMO_PASSWORD}":`);
  for (const person of people) console.log(`  ${person.email}`);
}

main().finally(async () => prisma.$disconnect());
