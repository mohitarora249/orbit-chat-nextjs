import type { ChatMessage } from "@/lib/types";

// Unsent messages, kept in IndexedDB so they survive a reload or a closed tab while offline. A message is
// queued when it is sent and removed once the server has it (or the viewer deletes it); whatever is left is
// sent again on the next load. Replays are safe: the server returns the stored message for a clientMessageId
// it already has. Storage can be unavailable (private windows, blocked site data), so every call is best
// effort and the in-memory ops keep working without it.
type QueuedSend = { clientMessageId: string; message: ChatMessage };

const DB_NAME = "orbit-chat";
const STORE = "sends";

let opening: Promise<IDBDatabase> | null = null;

function open() {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "clientMessageId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(error => {
    opening = null;
    throw error;
  });
  return opening;
}

async function run<T>(mode: IDBTransactionMode, use: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = use(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function queueSend(message: ChatMessage) {
  try {
    await run("readwrite", store => store.put({ clientMessageId: message.clientMessageId, message } satisfies QueuedSend));
  } catch { /* storage unavailable */ }
}

export async function unqueueSends(clientMessageIds: string[]) {
  if (!clientMessageIds.length) return;
  try {
    const db = await open();
    const transaction = db.transaction(STORE, "readwrite");
    for (const id of clientMessageIds) transaction.objectStore(STORE).delete(id);
  } catch { /* storage unavailable */ }
}

// The user's queued messages, oldest first, so replays keep the order they were written in.
export async function queuedSends(userId: string): Promise<ChatMessage[]> {
  try {
    const all = await run<QueuedSend[]>("readonly", store => store.getAll());
    return all.filter(item => item.message.authorId === userId).map(item => item.message).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch {
    return [];
  }
}
