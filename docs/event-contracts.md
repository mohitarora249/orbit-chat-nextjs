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
The acknowledgement is called with the ids of users online in the sender's workspaces.

## Server -> client

All message payloads use the `ChatMessage` shape from `src/lib/types.ts`: author, reactions, attachments,
thread fields, `editedAt`, and `deletedAt` (a deleted message has an empty body and no reactions or attachments).

| Event | Payload | Sent when |
|---|---|---|
| `session:ready` | none | After the server has joined the socket's rooms |
| `message:new` | `ChatMessage` | A message or thread reply was created |
| `message:updated` | `ChatMessage` | A message was edited or deleted, a reaction changed, a thread got a reply, or an attachment scan finished |
| `conversation:created` | `ConversationSummary` | A channel or DM that the user can see was created |
| `conversation:read` | `{ conversationId, lastReadAt }` | The same user read a conversation (keeps tabs in sync) |
| `presence:update` | `{ userId, online }` | A user's first socket connected, or their last one disconnected (after a 5-second grace period) |
| `typing` | `{ conversationId, parentId, userId, displayName, typing }` | Another user is typing |
| `chat:error` | `{ message }` | Room setup failed |

## Delivery semantics

Every `message:*` and `conversation:*` event comes from a transactional outbox (`OutboxEvent`), written
in the same transaction as the change. The worker loads the current database state when it publishes, so
events are idempotent and may arrive more than once. Deduplicate by message id (and by `clientMessageId`
for your own optimistic sends). Events missed while disconnected are not replayed; after a reconnect,
clients refetch `/api/conversations` and the newest page of the open conversation and thread.
