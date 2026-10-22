import { createServer } from "node:http";
import next from "next";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { createClient } from "redis";
import { createAdapter } from "@socket.io/redis-adapter";
import { fromNodeHeaders } from "better-auth/node";
import { prisma } from "./src/lib/prisma";
import { auth } from "./src/lib/auth";
import { visibleConversationsWhere } from "./src/lib/access";
import { startOutboxWorker } from "./src/lib/outbox-worker";
import { startPollClock } from "./src/lib/polls";
import { ensureBucket, storageConfigured } from "./src/lib/storage";
import type { Presence } from "./src/lib/presence";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = Number(process.env.PORT || 3000);
const app = next({ dev, hostname, port });

// Revoked sessions (e.g. signed out on another device) are noticed within this interval.
const SESSION_RECHECK_MS = 5 * 60 * 1000;
// A quick reload should not flash the user offline for everyone else.
const OFFLINE_GRACE_MS = 5000;
const TYPING_MIN_INTERVAL_MS = 1000;

async function start() {
  await app.prepare();
  const handle = app.getRequestHandler();
  const httpServer = createServer((req, res) => handle(req, res));
  const io = new SocketIOServer(httpServer, {
    path: "/socket.io",
    cors: {
      origin: process.env.NEXT_PUBLIC_APP_URL || `http://localhost:${port}`,
      credentials: true
    },
    transports: ["websocket", "polling"],
    maxHttpBufferSize: 1e6
  });

  // Redis adapter enables cross-process Socket.IO broadcasts. If Redis is down,
  // keep the single-instance development server usable and log the limitation.
  const redisClients: ReturnType<typeof createClient>[] = [];
  if (process.env.REDIS_URL) {
    try {
      const pubClient = createClient({ url: process.env.REDIS_URL });
      const subClient = pubClient.duplicate();
      redisClients.push(pubClient, subClient);
      pubClient.on("error", error => console.error("Redis publisher error:", error.message));
      subClient.on("error", error => console.error("Redis subscriber error:", error.message));
      await Promise.all([pubClient.connect(), subClient.connect()]);
      io.adapter(createAdapter(pubClient, subClient));
      console.log("Socket.IO Redis adapter connected.");
    } catch (error) {
      console.error("Redis adapter unavailable; Socket.IO will run single-instance only.", error);
      await Promise.allSettled(redisClients.splice(0).map(client => client.disconnect()));
    }
  }

  // The browser sends the Better Auth session cookie with the handshake; identity comes only from it.
  io.use(async (socket, nextMiddleware) => {
    try {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(socket.request.headers) });
      if (!session) return nextMiddleware(new Error("unauthorized"));
      socket.data.userId = session.user.id;
      socket.data.displayName = session.user.name;
      socket.data.sessionExpiresAt = new Date(session.session.expiresAt).getTime();
      nextMiddleware();
    } catch {
      nextMiddleware(new Error("Socket authentication failed"));
    }
  });

  const workspaceRooms = (socket: Socket) => [...socket.rooms].filter(room => room.startsWith("workspace:"));

  // Active if any of the user's tabs, on any instance, has seen input recently; away if all are idle.
  async function presenceOf(userId: string): Promise<Presence> {
    const sockets = await io.in(`user:${userId}`).fetchSockets();
    if (!sockets.length) return "offline";
    return sockets.some(other => !other.data.idle) ? "active" : "away";
  }

  async function announcePresence(userId: string, rooms: string[]) {
    try {
      if (rooms.length) io.to(rooms).emit("presence:update", { userId, presence: await presenceOf(userId) });
    } catch (error) {
      console.error("Presence update failed", error);
    }
  }

  io.on("connection", async socket => {
    const userId = socket.data.userId as string;

    const expireTimer = setTimeout(() => socket.disconnect(true), Math.min(Math.max(socket.data.sessionExpiresAt - Date.now(), 0), 2 ** 31 - 1));
    const recheckTimer = setInterval(async () => {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(socket.request.headers) }).catch(() => null);
      if (!session || session.user.id !== userId) socket.disconnect(true);
    }, SESSION_RECHECK_MS);
    // Rooms are already empty by the time "disconnect" fires, so read them here.
    socket.on("disconnecting", () => {
      clearTimeout(expireTimer);
      clearInterval(recheckTimer);
      const rooms = workspaceRooms(socket);
      // Re-announce rather than assume offline: closing an active tab can leave only idle ones (away).
      setTimeout(() => void announcePresence(userId, rooms), OFFLINE_GRACE_MS);
    });

    socket.on("presence:list", async (_payload: unknown, ack?: (presence: Record<string, Presence>) => void) => {
      if (typeof ack !== "function") return;
      try {
        const sockets = await io.in(workspaceRooms(socket)).fetchSockets();
        const presence: Record<string, Presence> = {};
        for (const other of sockets) {
          const id = other.data.userId as string;
          if (presence[id] !== "active") presence[id] = other.data.idle ? "away" : "active";
        }
        ack(presence);
      } catch {
        ack({});
      }
    });

    // The browser reports when this tab has had no input for a while (and when input resumes).
    socket.on("presence:idle", (payload: { idle?: boolean }) => {
      const idle = Boolean(payload?.idle);
      if (Boolean(socket.data.idle) === idle) return;
      socket.data.idle = idle;
      void announcePresence(userId, workspaceRooms(socket));
    });

    let lastTyping = 0;
    socket.on("typing", (payload: { conversationId?: string; parentId?: string | null; typing?: boolean }) => {
      const conversationId = String(payload?.conversationId || "");
      const room = `conversation:${conversationId}`;
      // Being in the room is the authorization: the server only ever joins sockets to rooms they may see.
      if (!conversationId || !socket.rooms.has(room)) return;
      const typing = Boolean(payload.typing);
      if (typing && Date.now() - lastTyping < TYPING_MIN_INTERVAL_MS) return;
      if (typing) lastTyping = Date.now();
      socket.to(room).emit("typing", {
        conversationId,
        parentId: typeof payload.parentId === "string" ? payload.parentId : null,
        userId,
        displayName: socket.data.displayName,
        typing
      });
    });

    try {
      // Rooms are managed by the server: one per user, per workspace, and per conversation the user can see.
      // New conversations are added by the outbox worker (conversation.created).
      const [workspaces, conversations] = await Promise.all([
        prisma.workspaceMember.findMany({ where: { userId }, select: { workspaceId: true } }),
        prisma.conversation.findMany({ where: visibleConversationsWhere(userId), select: { id: true } })
      ]);
      await socket.join([
        `user:${userId}`,
        ...workspaces.map(link => `workspace:${link.workspaceId}`),
        ...conversations.map(conversation => `conversation:${conversation.id}`)
      ]);
      socket.emit("session:ready");
      // Also covers a new active tab next to idle ones (away -> active).
      if (socket.connected) await announcePresence(userId, workspaceRooms(socket));
    } catch (error) {
      console.error("Socket room setup failed", error);
      socket.emit("chat:error", { message: "Could not subscribe to your conversations." });
    }
  });

  if (storageConfigured()) {
    await ensureBucket().catch(error => console.error("Attachment bucket unavailable; uploads will fail until storage is reachable.", error.message));
  }
  const stopWorker = startOutboxWorker(io);
  const stopPolls = startPollClock();

  httpServer.listen(port, hostname, () => {
    console.log(`> Orbit Chat ready on http://${hostname}:${port}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Shutting down...");
    stopWorker();
    stopPolls();
    // io.close() disconnects all sockets and also closes the underlying HTTP server.
    await io.close();
    await Promise.allSettled(redisClients.map(client => client.quit()));
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch(error => {
  console.error(error);
  process.exit(1);
});
