# Intent: src/index.ts modifications

## What changed
Added web channel support. The web channel is conditionally created when `WEB_ENABLED=true`.

## Key sections

### Imports (top of file)
- Added: `WEB_ENABLED`, `WEB_TOKEN` from `./config.js`
- All other imports unchanged

### main()
- Added: conditional web channel block after WhatsApp channel creation
- Web channel uses dynamic `import('./channels/web.js')` to avoid loading `ws` when disabled
- Web channel receives `registerGroup` callback (unlike WhatsApp) for auto-registration of browser sessions
- Startup guard: exits with error if `WEB_ENABLED=true` but `WEB_TOKEN` is empty

### No other changes
- `processGroupMessages()`, `runAgent()`, `startMessageLoop()`, `recoverPendingMessages()` are all unchanged
- State management, error handling, cursor rollback logic all preserved
- WhatsApp channel creation unchanged

## Invariants
- All existing message processing logic (triggers, cursors, idle timers) is preserved
- The `runAgent` function is completely unchanged
- State management (loadState/saveState) is unchanged
- Recovery logic is unchanged
- Container runtime check is unchanged

## Must-keep
- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic in processGroupMessages
- WhatsApp channel creation block
