# cloud-connectors

Monorepo of MCP connectors for personal cloud services, packaged as one-click Claude Desktop extensions (`.mcpb`). Built for eventual marketplace publishing: each connector ships separately with its own credential model and privacy story; shared plumbing lives in a core package.

## Packages

| Package | What | Auth |
|---|---|---|
| [`packages/core`](packages/core) | `@cloud-connectors/core` — shared MCP skeleton: stdio bootstrap, tool-result/error helpers, retry-aware fetch, file utils, HTML→text | — |
| [`packages/windows-live-connector`](packages/windows-live-connector) | Personal Microsoft Account: Outlook Mail + OneDrive via Microsoft Graph (19 tools) | OAuth 2.0 + PKCE, tokens in DPAPI/Keychain |
| [`packages/icloud-connector`](packages/icloud-connector) | iCloud: Mail via IMAP/SMTP + iCloud Drive via the local sync folder (17 tools) | Apple app-specific password (stored in OS keychain by Claude Desktop, `sensitive` user_config) |

## Build & pack

```powershell
$env:PATH = "C:\tools\nodejs;$env:PATH"
npm install            # workspace install at repo root
npm run build          # core -> windows-live -> icloud, deterministic order
node scripts/pack-mcpb.mjs windows-live-connector   # -> dist-bundle/windows-live-connector-<ver>.mcpb
node scripts/pack-mcpb.mjs icloud-connector         # -> dist-bundle/icloud-connector-<ver>.mcpb
```

`scripts/pack-mcpb.mjs` exists because npm workspaces hoist dependencies to the root `node_modules` (and symlink `core`), which would break `mcpb pack`'s self-contained-bundle assumption. It stages the target package with a real `npm install --omit=dev` (core injected as a tarball) and packs from the staging dir.

Bundles install by double-clicking the `.mcpb` / dragging it onto Claude Desktop (Settings → Extensions). Per-connector setup (Entra app registration, Apple app-specific password) is documented in each package's README/manifest description.

Note: a `.mcpb` built on Windows carries Windows-only native bindings for the secure token store (`keytar`); on macOS both connectors fall back to permissions-restricted plaintext storage with a logged warning. Repack on a Mac for Keychain-backed storage there.

## History

Grew out of the standalone project where I tinkered with windows live connectivity because I live in that eco system in addition to Google and Apple. 
