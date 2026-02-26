---
name: add-web
description: Add a browser-based web chat channel via WebSocket. Provides a self-contained chat UI accessible from any browser. Sessions auto-register and don't require trigger words.
---

# Add Web Channel

This skill adds a web-based chat interface to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `web` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

No configuration questions needed — the web channel is simple to set up. Just confirm they want to proceed.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-web
```

This deterministically:
- Adds `src/channels/web.ts` (WebChannel class with embedded HTML frontend)
- Adds `src/channels/web.test.ts` (unit tests)
- Three-way merges web channel support into `src/index.ts` (conditional WebChannel creation)
- Three-way merges web config into `src/config.ts` (WEB_ENABLED, WEB_PORT, WEB_TOKEN exports)
- Three-way merges `getMessagesForDisplay()` and `deleteRegisteredGroup()` into `src/db.ts`
- Three-way merges web JID pattern tests into `src/routing.test.ts`
- Installs the `ws` npm dependency and `@types/ws` dev dependency
- Updates `.env.example` with `WEB_ENABLED`, `WEB_PORT`, `WEB_TOKEN`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts
- `modify/src/db.ts.intent.md` — what changed for db.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new web tests) and build must be clean before proceeding.

## Phase 3: Setup

### Generate a secure token

Generate a random token for the user:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

### Configure environment

Add to `.env`:

```bash
WEB_ENABLED=true
WEB_PORT=3001
WEB_TOKEN=<generated-token>
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
```

For macOS:
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

For Linux:
```bash
systemctl --user restart nanoclaw
```

## Phase 4: Registration

No manual registration is needed. The web channel auto-registers each browser session as a group with `requiresTrigger: false` on first connection. Sessions are identified by a server-generated ID stored in the browser's `localStorage`.

Stale sessions (older than 7 days with no active connection) are automatically cleaned up.

## Phase 5: Verify

### Test the connection

Tell the user:

> Open your browser and navigate to:
>
> `http://localhost:3001/?token=<your-token>`
>
> You should see a chat interface. Type a message and the assistant should respond.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

Look for:
- `Web channel listening` — server started successfully
- `Auto-registered web session` — first message registered the session
- `Processing messages` — agent is processing the message

## Troubleshooting

### Page shows "Unauthorized"

The token in the URL doesn't match `WEB_TOKEN` in `.env`. Check:
1. `WEB_TOKEN` is set in `.env`
2. The URL includes `?token=<exact-token>`
3. Service was restarted after changing `.env`

### WebSocket fails to connect

Check:
1. `WEB_ENABLED=true` in `.env`
2. `WEB_PORT` is not in use by another service (`lsof -i :3001`)
3. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### Messages not getting responses

1. Check container system is running: look for container logs in `groups/web-<sessionId>/logs/`
2. Verify the session was auto-registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'web:%'"`
3. Check for agent errors in logs

### Port conflict

If port 3001 is in use, change `WEB_PORT` in `.env` to another port (e.g., `3210`).

## After Setup

If running `npm run dev` while the service is active:
```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
# Linux:
# systemctl --user stop nanoclaw
# npm run dev
# systemctl --user start nanoclaw
```

## Removal

To remove the web channel:

1. Delete `src/channels/web.ts` and `src/channels/web.test.ts`
2. Remove `WebChannel` import and creation block from `src/index.ts`
3. Remove web config (`WEB_ENABLED`, `WEB_PORT`, `WEB_TOKEN`) from `src/config.ts` and `.env`
4. Remove `getMessagesForDisplay()` and `deleteRegisteredGroup()` from `src/db.ts`
5. Remove web JID test from `src/routing.test.ts`
6. Remove web registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'web:%'"`
7. Uninstall: `npm uninstall ws && npm uninstall -D @types/ws`
8. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
