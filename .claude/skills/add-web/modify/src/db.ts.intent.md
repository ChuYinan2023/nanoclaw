# Intent: src/db.ts modifications

## What changed
Added three new functions for web channel support.

## Key sections

### getMessagesForDisplay(chatJid, sinceTimestamp, limit)
- Returns both user AND bot messages (unlike `getMessagesSince` which excludes bot messages)
- Used by the web channel to replay chat history when a browser reconnects
- Returns most recent `limit` messages, ordered chronologically (newest last)
- Pure addition — no existing function modified

### deleteRegisteredGroup(jid)
- Deletes a registered group by JID from the `registered_groups` table
- Used by the web channel to clean up stale sessions (TTL-based cleanup)
- Pure addition — no existing function modified

### getChatLastMessageTime(jid)
- Returns `last_message_time` from the chats table for a given JID
- Used by the web channel's TTL cleanup to determine last activity time (not registration time)
- Pure addition — no existing function modified

## Invariants
- All existing functions remain completely unchanged
- `getMessagesSince()` still filters out bot messages (used by the orchestrator)
- `storeMessageDirect()` still works the same (used by web channel to persist bot replies)
- Schema and migrations are unchanged

## Must-keep
- All existing function signatures and behavior
- The `_initTestDatabase()` test helper
- The `migrateJsonState()` migration logic
