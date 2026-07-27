# Windows Live Connector for Claude Desktop

Local MCP server giving Claude Desktop access to a **personal Microsoft Account**'s OneDrive and Outlook Mail via Microsoft Graph. Auth is OAuth 2.0 authorization-code + PKCE (public client, no secret); tokens are cached in the OS's secure credential store (Windows DPAPI under `%LOCALAPPDATA%\windows-live-connector\`, macOS Keychain where available) with a plaintext-file fallback if the native binding isn't present. Ships as a one-click Claude Desktop extension (`.mcpb`) that installs the same way on Windows and macOS.

> Teams is intentionally out of scope: Microsoft Graph does not expose Teams chat APIs to personal Microsoft accounts. See PLAN.md.

## One-time setup

### 1. Register the app (you must do this yourself — it requires signing into the Microsoft portal)

1. Go to https://entra.microsoft.com → **Applications → App registrations → New registration** (sign in with your Microsoft account).
2. Name: `windows-live-connector` (anything works).
3. Supported account types: **Personal Microsoft accounts only**.
4. Redirect URI: platform **Mobile and desktop applications**, URI `http://localhost`.
5. Register, then copy the **Application (client) ID** from the overview page.

No client secret, no admin consent, no publisher verification needed. The delegated permissions (`User.Read`, `Mail.ReadWrite`, `Mail.Send`, `Files.ReadWrite.All`) are requested dynamically at first sign-in; you consent once in the browser. **The same app registration works unchanged on both Windows and macOS** — nothing in the portal needs to differ per platform.

### 2. Install the extension (recommended: one-click `.mcpb` bundle)

Grab `dist-bundle/windows-live-connector-0.2.0.mcpb` and either double-click it or drag it onto Claude Desktop, then go to **Settings → Extensions**, find "Windows Live (OneDrive + Outlook)", and click Install. Claude Desktop prompts for one field — **Microsoft App (client) ID** — paste the Application (client) ID from step 1 there. The bundle carries its own Node runtime dependencies, so there is nothing else to install.

Restart Claude Desktop if prompted, then ask Claude to run `ms_login` — a browser window opens for Microsoft sign-in and consent. The session persists across restarts; you only sign in again if you change your password or go ~90 days without use.

**macOS note on token storage:** the token cache uses the macOS Keychain when the platform-native secure-storage binding is available, and otherwise falls back automatically to a permissions-restricted plaintext file under `~/Library/Application Support/windows-live-connector/` (with a warning printed to stderr, visible in Claude Desktop's MCP logs). The bundle built on this Windows machine ships a Windows-only native binding for the underlying credential-store library (`keytar`), so on macOS it currently uses the plaintext fallback — see "Rebuilding the bundle" below for what a mac-built bundle needs to get Keychain storage instead. This is a non-fatal, by-design fallback: all connector functionality works identically either way.

### 3. Alternative / dev install (unpackaged, via config file)

Useful during development, or if you'd rather not install the packaged extension.

```powershell
$env:PATH = "C:\tools\nodejs;$env:PATH"
cd C:\data\apps\windows-live-connector
npm install
npm run build
```

Edit `%APPDATA%\Claude\claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "windows-live": {
      "command": "node",
      "args": ["/absolute/path/to/windows-live-connector/dist/index.js"],
      "env": {
        "MS_CLIENT_ID": "<your Application (client) ID>"
      }
    }
  }
}
```

Restart Claude Desktop, then ask Claude to run `ms_login` as above.

### Rebuilding the bundle

```powershell
npm run build && npx @anthropic-ai/mcpb pack
```

This regenerates `dist/` and repacks `windows-live-connector-0.2.0.mcpb` (manifest, compiled JS, and `node_modules`; see `.mcpbignore` for exclusions — `src/`, TypeScript sources, `tsconfig.json`, `PLAN.md`). devDependencies are pruned before packing and restored with `npm install` afterward to keep the archive small.

To get **Keychain-backed** token storage in a mac-distributed bundle instead of the plaintext fallback, run the pack step on macOS itself (or `npm rebuild keytar` on a Mac before packing) — `keytar`'s own install script (`prebuild-install`) then fetches the correct darwin arm64/x64 native binding automatically, no manual steps needed. A single `node_modules` tree built on one OS can't serve both platforms' native `keytar.node` binding at once, because `keytar`'s loader (`lib/keytar.js`) always requires one fixed path rather than picking a binary per-platform at runtime — which is exactly why the connector degrades gracefully to the plaintext cache instead of crashing when the binding doesn't match the host OS.

## Tools (19)

**Auth:** `ms_login`, `ms_logout`, `ms_whoami`

**Outlook Mail:** `mail_list`, `mail_search`, `mail_read`, `mail_get_attachment`, `mail_create_draft` (preferred compose path — review in Outlook before sending), `mail_send` (confirmation-gated, irreversible), `mail_move`, `mail_mark`

**OneDrive:** `onedrive_list`, `onedrive_search`, `onedrive_get_metadata`, `onedrive_read_file` (text inline ≤1 MB, binaries saved to `Downloads`), `onedrive_upload_file` (chunked upload sessions above 4 MB, up to 250 MB), `onedrive_create_folder`, `onedrive_move`, `onedrive_delete` (recycle bin only, confirmation-gated)

## Safety properties

- Send/delete are separate, `destructiveHint`-annotated tools; Claude is instructed to confirm with you first.
- Deletes go to the OneDrive recycle bin, never permanent.
- Attachment saves cap at 25 MB, file reads at 100 MB; filenames are sanitized.
- Token cache uses the OS-native secure credential store (DPAPI on Windows, Keychain on macOS when available), scoped to your user account; falls back to a permissions-restricted plaintext file with a logged warning if the native binding is unavailable.
- stdout carries only MCP JSON-RPC; all diagnostics go to stderr (visible in Claude Desktop's MCP logs).

## Development

```powershell
npm run typecheck   # tsc --noEmit
npm run build       # emit dist/
```

Layout: `src/config.ts` (client id, scopes, cache path) · `src/auth.ts` (MSAL PKCE + DPAPI cache) · `src/graph.ts` (Graph fetch with 429/503 backoff) · `src/tools/{authTools,mail,onedrive}.ts` · `src/index.ts` (server bootstrap).

Packaging: `manifest.json` (MCPB manifest, spec version 0.3) at the project root, `.mcpbignore` excludes source/dev files from the bundle. See "Rebuilding the bundle" above.
