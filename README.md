# cloud-connectors

Monorepo of MCP connectors for personal cloud services, packaged as one-click Claude Desktop extensions (`.mcpb`). Built for eventual marketplace publishing: each connector ships separately with its own credential model and privacy story; shared plumbing lives in a core package.

## Packages

| Package | What | Auth |
|---|---|---|
| [`packages/core`](packages/core) | `@cloud-connectors/core` — shared MCP skeleton: stdio bootstrap, tool-result/error helpers, retry-aware fetch, file utils, HTML→text, macOS Keychain + sealed-file credential storage, mail-address validation | — |
| [`packages/windows-live-connector`](packages/windows-live-connector) | Personal Microsoft Account: Outlook Mail + OneDrive via Microsoft Graph (19 tools) | OAuth 2.0 + PKCE; token cache encrypted at rest (DPAPI / macOS Keychain), fails closed |
| [`packages/icloud-connector`](packages/icloud-connector) | iCloud: Mail via IMAP/SMTP + iCloud Drive via the local sync folder (17 tools) | Apple app-specific password (stored in OS keychain by Claude Desktop, `sensitive` user_config) |

## Build & pack

```bash
npm install            # workspace install at repo root
npm run build          # core -> windows-live -> icloud, deterministic order
node scripts/pack-mcpb.mjs windows-live-connector --platform=darwin
node scripts/pack-mcpb.mjs icloud-connector --platform=darwin
```

`--platform` accepts `darwin` or `win32` and defaults to the host, producing `dist-bundle/<name>-<version>-<macos|windows>.mcpb`.

**Bundles are per-platform.** A `.mcpb` is a frozen `node_modules`, so anything platform-specific in it is baked in at pack time — which is how a Windows-packed bundle used to end up storing macOS tokens in plaintext. The target platform now selects the dependency set, is stamped into the staged manifest's `compatibility.platforms`, and appears in the filename.

`scripts/pack-mcpb.mjs` exists because npm workspaces hoist dependencies to the root `node_modules` (and symlink `core`), which would break `mcpb pack`'s self-contained-bundle assumption. It stages the target package with a real `npm install --omit=dev` (core injected as a tarball) and packs from the staging dir. Along the way it enforces:

- **`--ignore-scripts`** on the staging install, so a compromised transitive package cannot run code on the packing machine.
- **`npm audit` gate** over the exact tree that ships — any high or critical advisory fails the pack. (The root workspace being clean doesn't prove staging is: it resolves fresh, so unpinned transitives can float. `overrides` in each `package.json` pin the ones that matter.)
- **Native-binding policy** — a macOS bundle must contain *no* `.node` files; a Windows bundle must contain `dpapi.node`.
- **Smoke test** — boots the staged server and requires a real `initialize` + non-empty `tools/list` over stdio.
- **Bundle inspection** — manifest at root, no `src/`/`.ts`, no stray `.env`/`.npmrc`.

The macOS bundles can be packed on any host (nothing in them is compiled). The **Windows** bundle must be packed on Windows, since `dpapi.node` has to be built there.

Bundles install by double-clicking the `.mcpb` / dragging it onto Claude Desktop (Settings → Extensions). Per-connector setup (Entra app registration, Apple app-specific password) is documented in each package's README/manifest description.

## Security model

- **Credentials at rest.** The Microsoft connector encrypts its MSAL token cache on every platform: DPAPI on Windows, AES-256-GCM under a key in the login Keychain on macOS. The macOS path goes through the built-in `/usr/bin/security` tool rather than a native addon, so it cannot be defeated by an architecture or Node-ABI mismatch between the packing machine and Claude Desktop's runtime — the failure mode that produced plaintext tokens before. Writes go over stdin, never the command line, so the secret is not visible to `ps`. If no secure store is reachable the connector **refuses to sign in**; `MS_ALLOW_PLAINTEXT_TOKEN_CACHE=1` opts back out and is off by default. Upgrading also re-seals and deletes any plaintext cache an older version left behind. The iCloud connector holds no credential of its own — Claude Desktop keeps the app-specific password in the OS keychain and injects it per run.
- **Credentials in transit.** iCloud IMAP and SMTP pin TLS ≥1.2 with certificate and hostname verification stated explicitly (not left to library defaults), and STARTTLS is mandatory rather than opportunistic, so the app-specific password can't be sent over an unverified connection. IMAP wire logging stays off — it would put credentials on stdout, which is the MCP channel.
- **Injection.** Recipients and subjects are validated in `core/src/mailAddress.ts` before reaching a header or an SMTP command; CR/LF and control characters are rejected, display names are quoted, and the SMTP envelope gets bare addr-specs only. iCloud Drive paths are confined to the sync folder, re-checked after resolving symlinks on the nearest existing ancestor.
- **Supply chain.** Zero known advisories in either shipped tree, enforced at pack time. The macOS bundles contain no compiled code at all, so there is no unsigned native binary for Gatekeeper to weigh in on.

## History

Grew out of the standalone project where I tinkered with windows live connectivity because I live in that eco system in addition to Google and Apple. 
