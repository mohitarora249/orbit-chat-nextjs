# Architecture decision records

## ADR-001: PostgreSQL is the source of truth
**Decision:** Persist durable entities and messages in PostgreSQL.  
**Reason:** Transactions, constraints, queryability, and a single canonical history.  
**Revisit when:** measured data volume or workload requires partitioning/sharding.

## ADR-002: Socket.IO for browser realtime
**Decision:** Use Socket.IO for connection management, rooms, and adapter support.  
**Reason:** Faster MVP implementation than a custom protocol.  
**Revisit when:** protocol overhead or platform constraints justify native WebSockets.

## ADR-003: Redis is a coordination/fan-out layer
**Decision:** Use the Socket.IO Redis adapter when multiple gateway processes are deployed.  
**Reason:** Socket.IO rooms are process-local without a distributed adapter.  
**Important:** Redis Pub/Sub is not durable message history.

## ADR-004: Better Auth sessions for identity (supersedes demo identity)
**Decision:** Email/password authentication with Better Auth and its Prisma adapter, using database sessions. Every route handler and the Socket.IO handshake derive the user from the session cookie.  
**Reason:** Maintained library, database sessions can be revoked, and SSO/2FA plugins are available later.  
**Note:** Sockets re-check their session every 5 minutes and are disconnected when it expires.

## ADR-005: Transactional outbox for realtime delivery
**Decision:** State changes write an `OutboxEvent` in the same transaction. A worker inside each server process claims events with leases (`FOR UPDATE SKIP LOCKED`), publishes the current state, and retries with backoff before dead-lettering.  
**Reason:** Delivery no longer depends on the browser staying connected after its POST.  
**Revisit when:** throughput needs a dedicated worker deployment or a log-based broker.

## ADR-006: Private object storage with scan-before-download
**Decision:** Browsers upload to S3-compatible storage through presigned PUT URLs (SeaweedFS locally). Files are scanned by ClamAV through the outbox before they can be downloaded, and each download is re-authorized and redirected to a 60-second presigned GET.  
**Reason:** The app servers never proxy large files, and an infected file is never served.

## ADR-007: Mentions are stored as id tokens
**Decision:** Message bodies store `<@userId>`, `<!channel>` and `<!here>` tokens (Slack-style). The composer shows names and encodes them on send; every renderer resolves tokens to the current display name. A migration converted existing `@Display Name` text.  
**Reason:** Name matching broke on renames and was ambiguous between similar names; id tokens make unread mention counts and Activity exact string matches.  
**Note:** Whether someone was online for an `@here` is not stored, so it alerts live only.

## ADR-008: Link previews are unfurled by the outbox worker, with an SSRF guard and a database cache
**Decision:** Sending or editing a message records its links (`MessageLink`) and queues a `message.unfurl` outbox event in the same transaction. A separate worker lane fetches each page server-side, stores its Open Graph data in `LinkPreview` (keyed by URL, shared by every message that links it) and emits `message:updated`. Stored previews are reused for 24 hours, failures for 1 hour; a failed refresh keeps the last good preview.  
**SSRF guard (src/lib/unfurl.ts):** http/https on default ports only, no credentials; every resolved address must be public (private, loopback, link-local/metadata, CGNAT, multicast, reserved, IPv6 non-global-unicast, 6to4/Teredo are refused), and the check runs as the socket's DNS lookup so the checked address is the one connected to (no DNS rebinding). Redirects are followed by hand (max 3) and re-checked; one 5-second deadline covers the whole fetch, and at most 1 MB of decompressed HTML is read.  
**Reason:** Viewers' browsers never contact the linked site to build the card, slow sites never delay message delivery, and a URL is fetched once per day however many people post it.  
**Note:** Preview images are loaded by viewers' browsers straight from the linked site (https only, `no-referrer`), which reveals their IP address to it. Proxying images through the server is the follow-up if that matters.

## ADR-009: Pinned conversations are personal and never on shared payloads
**Decision:** `PinnedConversation` is a channel or DM pinned to the top of one user's sidebar. Bootstrap and `GET /api/conversations` return the pinned ids in pin order, and changes are delivered only to the user's own room (`pins:update`, carrying the full list), never on `ConversationSummary`, which is broadcast to other people.  
**Reason:** Per-viewer state on broadcast payloads would leak who pinned what; sending the whole list keeps tabs correct even if events repeat or arrive out of order.  
**Note:** Pins of conversations the user can no longer see are hidden rather than deleted, so they return if access does. Limit: 50 per user.

## ADR-010: Forwarded messages quote their original live
**Decision:** A forward is an ordinary message with `forwardedFromId` set; its body is the forwarder's optional comment. `ChatMessage.forwarded` carries the original's current author, body, files and source, and when the original is edited or deleted the worker re-emits `message:updated` for its newest 200 live forwards. Forwarding a bare forward (no comment or files) quotes its original, so cards never nest. Forwards stay within the workspace, and the sender must be able to see the original.  
**Reason:** A live reference means deleting a message removes it everywhere it was shared, which a copied snapshot could not do.  
**Note:** The card is seen by people who may not be able to see the source, so only public channels are named ("a private channel" / "a direct message" otherwise). Forwarding is the act of sharing: a live forward lets anyone who can see it download the original's files. The "View message" link only appears for viewers who can open the source conversation.
