# Orbit Chat — Next.js real-time chat starter

A web-only team chat starter using **Next.js App Router, Next.js Route Handlers, TypeScript, Tailwind CSS, shadcn-style UI primitives, Prisma, PostgreSQL, Socket.IO, and Redis**.

> **Security note:** Identity comes only from a Better Auth session cookie, checked in every route handler and in the Socket.IO handshake. Before a real deployment also add rate limiting on the chat APIs, retention policies, monitoring, and email verification / SSO as needed.

## Features

- **Authentication:** Better Auth email + password sessions. Sign-ups join the default workspace (`DEFAULT_WORKSPACE_SLUG`); the first sign-up on an empty database creates it.
- **Channels:** public and private channels (`+` next to Channels, or the workspace menu). Names are normalized and unique per workspace.
- **Direct messages:** click anyone in the sidebar, the People panel or ⌘K. One DM per pair, enforced by a unique key.
- **History paging:** opaque cursors and infinite scroll upwards; reconnects catch up from the newest page.
- **Search:** PostgreSQL full-text search (generated `tsvector` column + GIN index) with the permission filter in the SQL itself. Supports `"phrases"`, `OR` and `-exclude`.
- **Reactions, editing and deleting:** reactions with an emoji picker; authors can edit or delete their messages, and workspace owners/admins can delete anyone's. Deleted messages become tombstones.
- **Threads:** one level deep, with reply counts and a thread side panel.
- **Read state:** per-conversation read cursors, unread badges, a "New" divider, and sync across tabs.
- **Attachments:** browsers upload straight to private S3-compatible storage with presigned URLs. Every file is scanned by ClamAV before anyone can download it, and downloads are re-authorized and redirected to a 60-second presigned URL.
- **Presence and typing:** online dots and "X is typing…", which work across instances through the Redis adapter.
- **Activity, Help, workspace menu, ⌘K and notifications:** Activity lists your mentions, thread replies and reactions; Help shows the shortcuts; the workspace menu has create channel, copy invite link and sign out; ⌘K jumps to a conversation or searches; notifications give desktop alerts for DMs and @mentions, plus per-conversation mute.
- **Reliable delivery:** every change writes an `OutboxEvent` in the same transaction; a worker publishes it with retries, backoff and dead-lettering.

## Requirements

- Node.js 20.9+ (Node.js 22 LTS recommended)
- npm 10+
- Docker Desktop / Docker Engine

## Run locally

### 1. Install dependencies

```bash
cp .env.example .env
npm install
```

### 2. Start PostgreSQL, Redis, storage and the malware scanner

```bash
docker compose up -d
docker compose ps
```

This starts PostgreSQL, Redis, SeaweedFS (S3-compatible attachment storage on :8333) and ClamAV (:3310).
ClamAV downloads its virus definitions on first start, which can take a few minutes. Uploads stay in
"Scanning…" until it is ready, and the worker retries in the meantime. Set `BETTER_AUTH_SECRET` in `.env` (`openssl rand -base64 32`).

### 3. Generate Prisma client and apply migrations

```bash
npm run db:generate
npm run db:deploy
```

### 4. Seed demo data

```bash
npm run db:seed
```

### 5. Start Next.js + Socket.IO custom server

```bash
npm run dev
```

Open **http://localhost:3000** and sign in as `mohit@example.com`, `aisha@example.com` or `rohan@example.com` (password `orbit-demo-123`, created by the seed), or create a new account. Use a second browser or an incognito window to sign in as someone else and watch messages, reactions, typing and presence update live.

## Useful commands

```bash
npm run typecheck
npm run db:studio
npm run db:seed
docker compose logs -f postgres redis
docker compose down
```

To reset all local data (destructive):

```bash
docker compose down -v
docker compose up -d
npm run db:deploy
npm run db:seed
```

## Architecture

```text
Browser (Next.js / React)
  ├── HTTPS → Next.js Route Handlers (Better Auth session) ── Prisma → PostgreSQL (+ OutboxEvent)
  ├── HTTPS PUT/GET → private S3 storage via presigned URLs
  └── WSS → Socket.IO (session cookie checked in the handshake)
                ├── server-managed rooms: user:, workspace:, conversation:
                ├── presence + typing
                └── Redis adapter → other instances

Outbox worker (runs inside server.ts, safe on many instances via FOR UPDATE SKIP LOCKED)
  ├── realtime lane: message.created/updated, conversation.created/read → Socket.IO rooms
  └── scan lane: attachment.scan → ClamAV (INSTREAM) → CLEAN / INFECTED
```

**Message path:** the client generates an idempotency key → POST validates and writes the message **and** an outbox event in one transaction → the API returns the canonical message → the worker (woken right after the commit, and polling every second as a fallback) loads the current state and broadcasts it to the conversation room. Failures retry with exponential backoff; after 8 attempts the event is dead-lettered (`failedAt` set). The browser never asks the server to publish. After a reconnect, the client refreshes conversations and unread counts, then catches up the open conversation and thread from durable history.

## Project layout

```text
src/
  app/
    api/
      auth/[...all]/                     Better Auth handler
      bootstrap/                         me, workspace, people, conversations + unread
      conversations/                     GET list, POST create channel
      conversations/dm/                  POST open DM
      conversations/[id]/messages/       GET (cursor) / POST (threads, attachments)
      conversations/[id]/read/           POST read cursor
      conversations/[id]/attachments/    POST reserve upload + presigned PUT
      messages/[id]/                     PATCH edit / DELETE
      messages/[id]/replies/             GET thread
      messages/[id]/reactions/           PUT / DELETE
      attachments/[id]/                  GET (authorize → presigned redirect)
      attachments/[id]/complete/         POST verify upload → queue scan
      search/  activity/
    login/  page.tsx
  components/  chat-app.tsx, auth-form.tsx, chat/*, ui/*
  lib/
    auth.ts session.ts access.ts           auth + authorization
    messages.ts conversations.ts          serializers, cursors, unread counts
    outbox.ts outbox-worker.ts            transactional outbox + worker
    storage.ts scanner.ts                 S3 presigning, ClamAV client
prisma/  schema.prisma, migrations/, seed.ts
server.ts  docker-compose.yml  docker/seaweedfs-s3.json
```

## Remaining limitations

1. **Rate limits:** Better Auth limits its own endpoints. Chat APIs and socket events have only payload limits plus a typing throttle.
2. **Orphaned uploads:** files uploaded but never sent stay in storage; add a periodic cleanup job.
3. **Presence** is online/offline only (no idle or away), based on connected sockets.
4. **Notification preferences** (desktop and mute) are stored per browser, not on the server.
5. **Search** has no `in:#channel` / `from:@person` filters, and no prefix matching on partial words.
6. **Mentions** are plain `@Display Name` text matches; there is no autocomplete and they don't survive a name change.
7. **Tests:** there is no automated test suite in the repo yet.

## Why a custom server?

The custom `server.ts` lets Next.js and Socket.IO share one HTTP server and port. This is convenient for local development and conventional Node hosting. Some serverless platforms do not support persistent WebSocket connections or arbitrary custom servers. In those environments, deploy the realtime gateway separately and configure the client to connect to its URL.

## Environment variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string; optional for one process, needed for multiple instances |
| `NEXT_PUBLIC_APP_NAME` | UI label |
| `NEXT_PUBLIC_APP_URL` | Public origin; allowed Socket.IO/CORS origin and same-origin check for mutations |
| `BETTER_AUTH_SECRET` | Secret used to sign sessions (required in production) |
| `BETTER_AUTH_URL` | Base URL of the app for Better Auth |
| `DEFAULT_WORKSPACE_SLUG` | Workspace that new sign-ups join |
| `S3_ENDPOINT` / `S3_PUBLIC_ENDPOINT` | Storage endpoint for the server / the hostname browsers use in presigned URLs |
| `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Private attachment bucket and credentials |
| `MALWARE_SCANNER` | `clamav` (default) or `disabled` (development only; refused in production) |
| `CLAMAV_HOST`, `CLAMAV_PORT` | clamd address |
| `NEXT_DIST_DIR` | Optional build directory, for running two dev servers from one checkout |

## Production checklist

- [x] Replace demo identity with authenticated sessions.
- [x] Validate WebSocket sessions (re-checked every 5 minutes and disconnected on expiry).
- [x] Remove client-controlled `userId` from API contracts.
- [x] Add transactional outbox and durable event publication.
- [x] Add message paging with opaque cursors and reconnect recovery.
- [x] Add private attachment storage, presigned URLs and malware scanning.
- [ ] Add API/socket rate limits.
- [ ] Add structured logs, metrics (including dead-lettered outbox events), error reporting, and alerts.
- [ ] Configure managed Postgres, automated backups, and restore drills.
- [ ] Add storage quotas and orphaned-upload cleanup.
- [ ] Add automated authorization tests for every API and socket event.
