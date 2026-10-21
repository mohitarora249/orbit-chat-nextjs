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

## ADR-011: Drafts are saved to the server, debounced, and the latest local edit wins
**Decision:** `Draft` holds one user's unsent text per conversation (mentions as `<@id>` tokens). The composer saves 800 ms after typing stops and immediately when it closes (switching conversation) or sends; `PUT /api/conversations/:id/draft` with blank text deletes it. Other tabs and devices get `draft:update` on the user's own room only. A tab ignores `draft:update` for a conversation while its own saves there are in flight, and an open composer with unsaved edits keeps them rather than taking a remote draft.  
**Reason:** Saving on every keystroke would load the outbox for no benefit; saving on close is what makes switching channels safe. Ordering saves per conversation and letting unsaved local text win means a slow echo never overwrites what the user is typing.  
**Note:** Attachments and thread-reply drafts are not kept. Drafts in conversations the user can no longer see are hidden, not deleted, like pins.

## ADR-012: DM read receipts come from the existing read cursors
**Decision:** In DMs only, `ConversationSummary.readCursors` carries each member's `ReadCursor.lastReadAt`, and moving a cursor also emits `conversation:seen` to the DM's room. The client shows "Seen" under the sender's newest message at or before the partner's cursor, as long as the partner has not written since.  
**Reason:** The cursor already records exactly how far each person has read, so receipts need no new table or write path. The field is the same for both members, so it is safe on the broadcast `conversation:created` payload.  
**Note:** Channels never expose other people's cursors. There is no opt-out yet, and "Seen" has no time: the cursor stores the read message's time, not when it was read.

## ADR-013: Public channel membership drives the sidebar; archived channels are read-only
**Decision:** The sidebar shows DMs and the channels the user has joined that are not archived. Any workspace member can still read a public channel without joining (Browse channels, ⌘K, links), and sees a preview with a Join button instead of the composer. `ConversationSummary.isMember` is per viewer, so broadcasts set it per audience. Archiving sets `Conversation.archivedAt`: history and members are kept, the channel leaves every sidebar, and new messages, replies, uploads, edits, reactions and channel changes are refused until it is unarchived (deleting a message is still allowed).
**Permissions:** members set the topic and description and add people; the channel's creator and workspace owners and admins also rename, archive and unarchive, and remove people. Anyone can leave, except the last member of a private channel, who should archive it instead. DMs cannot be managed.
**Reason:** Leaving a channel only means something if membership decides what you see. Keeping public channels readable without joining keeps search, forwards and links working.
**Note:** The migration made every workspace member a member of every existing public channel, so nobody's sidebar changed. New sign-ups join #general only. Unread mentions in channels the user has not joined are not counted or alerted.

## ADR-014: Reminders are fired by a database clock and delivered through the outbox
**Decision:** `/remind` is parsed in the browser (which knows the user's time zone) into text and an absolute time, and stored as a `Reminder`. Every server process runs a reminder clock that, every 5 seconds, sets `firedAt` on due reminders (`FOR UPDATE SKIP LOCKED`, so instances never double-fire) and queues a `reminder.updated` outbox event in the same transaction. The worker emits `reminder:update` to the user's own room. Fired reminders stay until marked done (deleted) or snoozed (new `remindAt`, `firedAt` cleared). Bootstrap and `GET /api/reminders` return all of the user's reminders, waiting or fired, for the Reminders panel, so a reminder that goes off while the user is offline is shown when they come back. Setting one also emits `reminder:update`, so every tab's list stays in sync.
**Reason:** No in-memory timers to lose on restart or deploy, and delivery reuses the outbox's retries.
**Note:** Reminders go off up to 5 seconds late. They are personal only (no reminding other people or channels, no repeats yet), limited to 100 waiting per user and a year ahead.

## ADR-015: /giphy is proxied, and GIFs are stored as GIPHY media URLs
**Decision:** `GET /api/giphy` searches GIPHY with the server's `GIPHY_API_KEY` (rating `GIPHY_RATING`, default `pg`) and returns up to 25 results as canonical `https://media.giphy.com/media/<id>/200.gif` URLs. The composer previews them privately (Send / Shuffle / Cancel), and sending posts a message whose body is just that URL. Renderers show a body that is exactly a GIPHY media URL as the image, and such URLs are not unfurled.
**Reason:** The key never reaches browsers, and storing a URL needs no new message type or storage.
**Note:** Like link-preview images, GIFs are loaded by viewers' browsers straight from GIPHY (`no-referrer`). Only GIPHY media URLs are shown inline, so the image cannot be pointed anywhere else.

## ADR-016: Polls are rows on a message, and interactions go through one message-actions endpoint
**Decision:** A poll is an ordinary message whose body is the question, plus `Poll`, `PollOption` and `PollVote` rows (one vote per user per option). `/poll` opens a dialog (picking it from the command suggestions opens it straight away; quoted text typed after it, like `/poll "Q" "A" "B"`, prefills it), with multiple choice, anonymous and a closing time; the poll is created in the same transaction as its message. Voting and closing go through `POST /api/messages/:id/actions` with `{ action: "poll.vote", optionIds }` (the full new set of choices; empty takes the vote back) `{ action: "poll.close" }` or `{ action: "poll.reopen", closesAt? }` (closing and reopening: the author, or workspace owners and admins). Future interactive parts of messages add actions there.
**Per-viewer state:** `ChatMessage.poll` is broadcast to everyone, so it carries tallies and, for named polls only, voter ids. `myVotes` is set only on responses to the viewer (history pages, threads, action results) and is `null` on broadcasts; clients keep the choices they already had. A vote also emits `poll:votes` to the voter's own room, so their other tabs learn their choices in an anonymous poll.
**Rules:** 2–10 options, fixed once posted (the question can still be edited). Votes are refused when the poll is closed, the message is deleted or the channel is archived. A per-voter advisory lock keeps a one-choice poll at one choice when tabs vote at once. Polls close through a clock like reminders (ADR-014), up to 5 seconds late; clients also treat a poll as closed once `closesAt` has passed. Reopening keeps the votes, takes a new closing time (or none, since the old one may have passed) and sets `reopenedAt`, which the card shows as "Reopened" so results seen as final are not mistaken for the new ones. Forwarded copies show live results without voter ids, and are not votable.
**Reason:** Tables give exact counts, constraints and anonymity; a JSON blob would not. Keeping the question in `body` means search, previews and mentions work unchanged.
**Note:** Every vote queues a `message.updated`. The worker coalesces repeats of the same `message.updated` or `poll.voted` within one claimed batch (their handlers publish current state), so a busy poll sends fewer broadcasts when events back up. Votes that arrive slower than the worker are still sent one by one. A poll's full voter list is loaded with each broadcast, which is fine for channels of hundreds; a counts-only event is the next step if polls get much larger.
