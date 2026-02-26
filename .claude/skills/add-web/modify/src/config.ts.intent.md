# Intent: src/config.ts modifications

## What changed
Added three new configuration exports for web channel support.

## Key sections
- **readEnvFile call**: Must include `WEB_ENABLED`, `WEB_PORT`, `WEB_TOKEN` in the keys array. NanoClaw does NOT load `.env` into `process.env` — all `.env` values must be explicitly requested via `readEnvFile()`.
- **WEB_ENABLED**: Boolean flag from `process.env` or `envConfig`, when `true` starts the web channel HTTP/WS server
- **WEB_PORT**: Integer port for the web server, defaults to `3001`
- **WEB_TOKEN**: Authentication token, must be non-empty when `WEB_ENABLED=true`

## Invariants
- All existing config exports remain unchanged
- New web keys are added to the `readEnvFile` call alongside existing keys
- New exports are appended at the end of the file
- No existing behavior is modified — web config is additive only
- Both `process.env` and `envConfig` are checked (same pattern as `ASSISTANT_NAME`)

## Must-keep
- All existing exports (`ASSISTANT_NAME`, `POLL_INTERVAL`, `TRIGGER_PATTERN`, etc.)
- The `readEnvFile` pattern — ALL config read from `.env` must go through this function
- The `escapeRegex` helper and `TRIGGER_PATTERN` construction
