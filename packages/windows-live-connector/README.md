# Windows Live Connector for Claude Desktop

Local MCP server giving Claude Desktop access to a **personal Microsoft Account**'s OneDrive and Outlook Mail via Microsoft Graph. Auth is OAuth 2.0 authorization-code + PKCE (public client, no secret); the token cache is always encrypted at rest — DPAPI on Windows (`%LOCALAPPDATA%\windows-live-connector\`), AES-256-GCM under a macOS Keychain key on macOS (`~/Library/Application Support/windows-live-connector/`) — and the connector **refuses to sign in** rather than storing refresh tokens unencrypted. Ships as a one-click Claude Desktop extension (`.mcpb`), built separately per platform.

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

Grab the bundle for your platform from `dist-bundle/` (`windows-live-connector-<version>-macos.mcpb` or `-windows.mcpb`) and either double-click it or drag it onto Claude Desktop, then go to **Settings → Extensions**, find "Windows Live (OneDrive + Outlook)", and click Install. Claude Desktop prompts for one field — **Microsoft App (client) ID** — paste the Application (client) ID from step 1 there. The bundle carries its own Node runtime dependencies, so there is nothing else to install.

Restart Claude Desktop if prompted, then ask Claude to run `ms_login` — a browser window opens for Microsoft sign-in and consent. The session persists across restarts; you only sign in again if you change your password or go ~90 days without use.

**Pick the bundle for your platform.** Bundles are named `...-macos.mcpb` and `...-windows.mcpb`, and each declares its platform in the manifest, so Claude Desktop will decline the wrong one. A `.mcpb` is a frozen `node_modules`, which is why one artifact cannot serve both.

### Token storage

| | Windows | macOS |
|---|---|---|
| At rest | DPAPI, scoped to your Windows user | AES-256-GCM file, key held in your login Keychain |
| Mechanism | `dpapi.node` native binding | `/usr/bin/security` — **no native module** |
| If unavailable | Sign-in refused | Sign-in refused |

The macOS path deliberately avoids a compiled addon. The usual library for this (`keytar`) is archived, and its binding is tied to one CPU architecture *and* one Node ABI — so a bundle packed on one machine routinely fails to load under a different Claude Desktop build, which is precisely how an earlier version of this connector ended up silently writing refresh tokens to a plaintext file. The `security` CLI ships with macOS and has neither coupling.

If a secure store genuinely cannot be reached, the connector raises an error instead of degrading. Upgrading from ≤0.2.x also re-seals any plaintext cache the old version left behind and deletes it, so the exposure is removed rather than merely stopped. The escape hatch `MS_ALLOW_PLAINTEXT_TOKEN_CACHE=1` restores the old behaviour for environments with no secret service at all; it is off by default and not recommended — that file grants full access to your mailbox and OneDrive until you revoke the session at https://account.live.com/consent/Manage.

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

From the monorepo root:

```bash
node scripts/pack-mcpb.mjs windows-live-connector --platform=darwin
```

`--platform` defaults to the host OS; `win32` produces the Windows bundle. Output lands in `dist-bundle/windows-live-connector-<version>-<macos|windows>.mcpb`.

The macOS bundle can be packed on any host, because nothing in it is compiled — `@azure/msal-node-extensions` (and with it `keytar`) is dropped for `darwin` via `mcpb.omitDependencies` in `package.json`, and the pack script fails if a `.node` file makes it into a macOS bundle at all. The **Windows** bundle must be packed on Windows, since it needs the real `dpapi.node` binding; the pack script checks for it. See the root README for what else the pack step verifies.

## Tools (19)

**Auth:** `ms_login`, `ms_logout`, `ms_whoami`

**Outlook Mail:** `mail_list`, `mail_search`, `mail_read`, `mail_get_attachment`, `mail_create_draft` (preferred compose path — review in Outlook before sending), `mail_send` (confirmation-gated, irreversible), `mail_move`, `mail_mark`

**OneDrive:** `onedrive_list`, `onedrive_search`, `onedrive_get_metadata`, `onedrive_read_file` (text inline ≤1 MB, binaries saved to `Downloads`), `onedrive_upload_file` (chunked upload sessions above 4 MB, up to 250 MB), `onedrive_create_folder`, `onedrive_move`, `onedrive_delete` (recycle bin only, confirmation-gated)

## Safety properties

- Send/delete are separate, `destructiveHint`-annotated tools; Claude is instructed to confirm with you first.
- Deletes go to the OneDrive recycle bin, never permanent.
- Attachment saves cap at 25 MB, file reads at 100 MB; filenames are sanitized.
- Recipient addresses and subjects are validated before use; line breaks and control characters are rejected, so a composed message cannot inject extra headers.
- Token cache is encrypted at rest and scoped to your user account (DPAPI on Windows; AES-256-GCM under a login-Keychain key on macOS, `0600` file in a `0700` directory). If neither is reachable the connector errors out instead of writing tokens in the clear — see "Token storage" above.
- stdout carries only MCP JSON-RPC; all diagnostics go to stderr (visible in Claude Desktop's MCP logs).

## Development

```powershell
npm run typecheck   # tsc --noEmit
npm run build       # emit dist/
```

Layout: `src/config.ts` (client id, scopes, cache paths) · `src/auth.ts` (MSAL PKCE + per-platform encrypted cache) · `src/graph.ts` (Graph fetch with 429/503 backoff) · `src/tools/{authTools,mail,onedrive}.ts` · `src/index.ts` (server bootstrap). The macOS Keychain and sealed-file primitives live in `@cloud-connectors/core` (`src/keychain.ts`, `src/sealedStore.ts`).

Packaging: `manifest.json` (MCPB manifest, spec version 0.3) at the project root, `.mcpbignore` excludes source/dev files from the bundle. See "Rebuilding the bundle" above.
