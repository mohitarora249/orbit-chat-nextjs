# Realtime event contracts

The Socket.IO handshake is authenticated by the Better Auth session cookie. Clients never choose rooms:
on connect the server joins each socket to `user:<id>`, `workspace:<id>` for each of the user's workspaces,
and `conversation:<id>` for every conversation the user can see. When a conversation is created, the outbox
worker adds the rooms for everyone who can see it.

## Client -> server

### `typing`
```json
{ "conversationId": "conversation-id", "parentId": "thread-parent-id or null", "typing": true }
```
This is dropped unless the socket is already in that conversation's room. "Started typing" is throttled
to one per second per socket. Clients re-send it every few seconds while the user types, and expire it
after about 6 seconds without one.

### `presence:list` (with acknowledgement)
The acknowledgement is called with `{ [userId]: "active" | "away" }` for users online in the sender's workspaces.

### `presence:idle`
```json
{ "idle": true }
```
Sent when this tab has had no input for 10 minutes, and with `false` when input resumes (and again after a
reconnect if still idle). A user is `away` when all of their sockets are idle, `active` if any is not.

## Server -> client

All message payloads use the `ChatMessage` shape from `src/lib/types.ts`: author, reactions, attachments,
link previews, thread fields, `editedAt`, `deletedAt` (a deleted message has an empty body and no reactions,
attachments, link previews or forward), and `forwarded` (the quoted original of a forward, with `deleted: true` once it is gone). `linkPreviews` is usually empty in `message:new` and filled in by a later `message:updated`.

| Event | Payload | Sent when |
|---|---|---|
| `session:ready` | none | After the server has joined the socket's rooms |
| `message:new` | `ChatMessage` | A message or thread reply was created |
| `message:updated` | `ChatMessage` | A message was edited or deleted, a reaction changed, a thread got a reply, an attachment scan finished, its link previews were fetched, or the original it forwards changed |
| `conversation:created` | `ConversationSummary` | A channel or DM that the user can see was created |
| `conversation:read` | `{ conversationId, lastReadAt }` | The same user read a conversation (keeps tabs in sync) |
| `presence:update` | `{ userId, presence }` (`"active"`, `"away"` or `"offline"`) | A user's socket connected, went idle or active, or disconnected (after a 5-second grace period). May repeat the current value |
| `status:update` | `{ userId, status }` (`UserStatus` or `null`) | A user changed their custom status or Do Not Disturb (via the outbox). Expiry is not announced: clients hide statuses past `expiresAt` / `dndUntil` |
| `pins:update` | `{ conversationIds }` (full list, in pin order) | The same user pinned or unpinned a channel or DM (keeps tabs in sync; never sent to anyone else) |
| `typing` | `{ conversationId, parentId, userId, displayName, typing }` | Another user is typing |
| `chat:error` | `{ message }` | Room setup failed |

## Delivery semantics

Every `message:*` and `conversation:*` event comes from a transactional outbox (`OutboxEvent`), written
in the same transaction as the change. The worker loads the current database state when it publishes, so
events are idempotent and may arrive more than once. Deduplicate by message id (and by `clientMessageId`
for your own optimistic sends). Events missed while disconnected are not replayed; after a reconnect,
clients refetch `/api/conversations` and the newest page of the open conversation and thread.
