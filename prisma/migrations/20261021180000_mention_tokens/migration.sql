-- Mentions are now stored as <@userId> tokens (see src/lib/mentions.ts). Convert existing "@Display Name"
-- text to tokens for people in the message's workspace, longest names first so "@Aisha Khan" is not taken
-- as "@Aisha". The match rules are the same as encodeMentions: case-insensitive, starting at a word boundary,
-- and not running into a longer word. When two people share a name, the earlier account wins.
DO $$
DECLARE
  person RECORD;
BEGIN
  FOR person IN
    SELECT u."id", wm."workspaceId",
      regexp_replace(u."displayName", '([.*+?^${}()|\[\]\\])', '\\\1', 'g') AS pattern
    FROM "User" u
    JOIN "WorkspaceMember" wm ON wm."userId" = u."id"
    ORDER BY length(u."displayName") DESC, u."createdAt", u."id"
  LOOP
    UPDATE "Message" m
    SET "body" = regexp_replace(m."body", '(^|[^\w@<])@' || person.pattern || '(?!\w)', '\1<@' || person."id" || '>', 'gi')
    FROM "Conversation" c
    WHERE c."id" = m."conversationId"
      AND c."workspaceId" = person."workspaceId"
      AND m."deletedAt" IS NULL
      AND m."body" ~* ('(^|[^\w@<])@' || person.pattern || '(?!\w)');
  END LOOP;
END $$;
