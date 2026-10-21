import type { Server } from "socket.io";
import { prisma } from "./prisma";
import { messageSelect, serializeMessage } from "./messages";
import { getConversationSummary, listPinnedConversationIds } from "./conversations";
import { outboxSignal, type OutboxEventType, type OutboxPayloads } from "./outbox";
import { serializeStatus, statusSelect } from "./presence";
import { deleteObject, openObject } from "./storage";
import { scanFile } from "./scanner";
import { refreshPreviews } from "./unfurl";

type Handlers = { [T in OutboxEventType]: (payload: OutboxPayloads[T]) => Promise<void> };
type ClaimedEvent = { id: bigint; type: OutboxEventType; payload: unknown; attempts: number };

const MAX_ATTEMPTS = 8;
const POLL_INTERVAL_MS = 1000;

async function emitMessage(io: Server, messageId: string, event: "message:new" | "message:updated") {
  const message = await prisma.message.findUnique({ where: { id: messageId }, select: messageSelect });
  if (!message) return;
  io.to(`conversation:${message.conversationId}`).emit(event, serializeMessage(message));
}

function createHandlers(io: Server): Handlers {
  return {
    "message.created": async ({ messageId }) => {
      await emitMessage(io, messageId, "message:new");
      // The parent's reply count and last-reply time changed too.
      const reply = await prisma.message.findUnique({ where: { id: messageId }, select: { parentId: true } });
      if (reply?.parentId) await emitMessage(io, reply.parentId, "message:updated");
    },
    "message.updated": ({ messageId }) => emitMessage(io, messageId, "message:updated"),
    // Fetch failures are stored as FAILED previews, not thrown, so only database errors are retried.
    "message.unfurl": async ({ messageId }) => {
      const links = await prisma.messageLink.findMany({ where: { messageId }, select: { url: true } });
      if (await refreshPreviews(links.map(link => link.url))) await emitMessage(io, messageId, "message:updated");
    },
    "conversation.created": async ({ conversationId }) => {
      const found = await getConversationSummary(conversationId);
      if (!found) return;
      const room = `conversation:${conversationId}`;
      const { summary, workspaceId } = found;
      // Subscribe every connected socket that can now see the conversation, on every server instance.
      const audiences = summary.type === "CHANNEL" && !summary.isPrivate
        ? [`workspace:${workspaceId}`]
        : summary.memberIds.map(userId => `user:${userId}`);
      for (const audience of audiences) {
        io.in(audience).socketsJoin(room);
        io.to(audience).emit("conversation:created", summary);
      }
    },
    "conversation.read": async ({ conversationId, userId, lastReadAt }) => {
      // Keeps the user's other tabs and devices in sync.
      io.to(`user:${userId}`).emit("conversation:read", { conversationId, lastReadAt });
    },
    // Sends the whole current list, so repeated or out-of-order events still leave tabs correct.
    "conversation.pins": async ({ userId }) => {
      io.to(`user:${userId}`).emit("pins:update", { conversationIds: await listPinnedConversationIds(userId) });
    },
    "user.status": async ({ userId }) => {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { ...statusSelect, workspaceLinks: { select: { workspaceId: true } } } });
      if (!user) return;
      const rooms = user.workspaceLinks.map(link => `workspace:${link.workspaceId}`);
      if (rooms.length) io.to(rooms).emit("status:update", { userId, status: serializeStatus(user) });
    },
    "attachment.scan": async ({ attachmentId }) => {
      const attachment = await prisma.attachment.findUnique({ where: { id: attachmentId } });
      if (!attachment || attachment.status !== "SCANNING") return;
      const result = await scanFile(await openObject(attachment.storageKey));
      if (!result.clean) {
        console.warn(`Attachment ${attachmentId} is infected (${result.signature}); deleting it.`);
        await deleteObject(attachment.storageKey);
      }
      // Re-read messageId from the update: the message is often sent while the scan is still running.
      const scanned = await prisma.attachment.update({
        where: { id: attachmentId },
        data: { status: result.clean ? "CLEAN" : "INFECTED", scannedAt: new Date() },
        select: { messageId: true }
      });
      if (scanned.messageId) await emitMessage(io, scanned.messageId, "message:updated");
    }
  };
}

// Called when an event has failed MAX_ATTEMPTS times, so the user is not left waiting forever.
async function onGiveUp(io: Server, event: ClaimedEvent) {
  if (event.type !== "attachment.scan") return;
  const { attachmentId } = event.payload as OutboxPayloads["attachment.scan"];
  const attachment = await prisma.attachment.update({ where: { id: attachmentId }, data: { status: "FAILED" } }).catch(() => null);
  if (attachment?.messageId) await emitMessage(io, attachment.messageId, "message:updated");
}

// Claims a batch by pushing availableAt forward (a lease): if this process dies mid-batch, the events become
// available again once the lease expires. SKIP LOCKED lets several server instances poll the same table.
function claim(types: OutboxEventType[], batchSize: number, leaseSeconds: number) {
  return prisma.$queryRaw<ClaimedEvent[]>`
    UPDATE "OutboxEvent"
    SET "attempts" = "attempts" + 1,
        "availableAt" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${leaseSeconds})
    WHERE "id" IN (
      SELECT "id" FROM "OutboxEvent"
      WHERE "failedAt" IS NULL AND "availableAt" <= (now() AT TIME ZONE 'UTC') AND "type" = ANY(${types})
      ORDER BY "id"
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "type", "payload", "attempts"`;
}

type Lane = { name: string; types: OutboxEventType[]; batchSize: number; leaseSeconds: number; concurrency: number };

export function startOutboxWorker(io: Server) {
  const handlers = createHandlers(io);
  const lanes: Lane[] = [
    // Realtime fan-out is fast and ordering matters, so it runs one event at a time.
    { name: "realtime", types: ["message.created", "message.updated", "conversation.created", "conversation.read", "user.status", "conversation.pins"], batchSize: 50, leaseSeconds: 30, concurrency: 1 },
    // Scans are slow; keep them off the realtime lane so they never delay message delivery.
    { name: "scan", types: ["attachment.scan"], batchSize: 4, leaseSeconds: 300, concurrency: 4 },
    // Link previews wait on other people's servers (up to 5 seconds per link), so they get their own lane too.
    { name: "unfurl", types: ["message.unfurl"], batchSize: 8, leaseSeconds: 60, concurrency: 4 }
  ];
  let stopped = false;
  const timers: NodeJS.Timeout[] = [];
  const stoppers: (() => void)[] = [];

  async function handleEvent(lane: Lane, event: ClaimedEvent) {
    try {
      const handler = handlers[event.type] as (payload: unknown) => Promise<void>;
      if (!handler) throw new Error(`No handler for outbox event type ${event.type}`);
      await handler(event.payload);
      await prisma.outboxEvent.delete({ where: { id: event.id } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const giveUp = event.attempts >= MAX_ATTEMPTS;
      console.error(`Outbox ${lane.name} event ${event.id} (${event.type}) failed, attempt ${event.attempts}${giveUp ? "; giving up" : ""}:`, message);
      const backoffMs = Math.min(1000 * 2 ** event.attempts, 5 * 60 * 1000);
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: giveUp ? { failedAt: new Date(), lastError: message } : { availableAt: new Date(Date.now() + backoffMs), lastError: message }
      }).catch(updateError => console.error("Outbox bookkeeping failed", updateError));
      if (giveUp) await onGiveUp(io, event).catch(giveUpError => console.error("Outbox give-up handler failed", giveUpError));
    }
  }

  function runLane(lane: Lane) {
    let running = false;
    let again = false;
    const tick = async () => {
      if (stopped) return;
      if (running) { again = true; return; }
      running = true;
      try {
        do {
          again = false;
          const batch = await claim(lane.types, lane.batchSize, lane.leaseSeconds);
          for (let i = 0; i < batch.length; i += lane.concurrency) {
            await Promise.all(batch.slice(i, i + lane.concurrency).map(event => handleEvent(lane, event)));
          }
          if (batch.length === lane.batchSize) again = true;
        } while (again && !stopped);
      } catch (error) {
        console.error(`Outbox ${lane.name} poll failed`, error);
      } finally {
        running = false;
      }
    };
    const onKick = () => void tick();
    outboxSignal.on("kick", onKick);
    stoppers.push(() => outboxSignal.off("kick", onKick));
    timers.push(setInterval(onKick, POLL_INTERVAL_MS));
    void tick();
  }

  lanes.forEach(runLane);
  console.log("Outbox worker started.");
  return () => {
    stopped = true;
    timers.forEach(clearInterval);
    stoppers.forEach(stop => stop());
  };
}
