# Windows Live Connector for Claude Desktop — Project Plan

**Goal:** A local MCP connector for Claude Desktop that gives Claude access to a personal Microsoft Account's OneDrive, Outlook email, and (where possible) Teams, authenticated via Microsoft OAuth.

**Status:** In build (2026-07-16). Owner decision: **Teams descoped from v1** (no Graph API for personal-MSA Teams). Build order: auth → Outlook Mail → OneDrive. Implementation delegated to subagents.
**Location:** `C:\data\apps\windows-live-connector`

---

## 1. Critical constraint discovered up front

**Microsoft Graph does not support Teams chat APIs for personal Microsoft accounts.** Delegated permissions like `Chat.Read` / `Chat.ReadWrite` are valid only for work/school (Entra ID) accounts. Personal-MSA Teams users ("Teams for personal use") appear in the Graph data model only as *message senders* (`personalMicrosoftAccountUser`), not as signed-in API callers. There is no supported Graph surface for reading a personal account's Teams chats.

OneDrive (`Files.*`) and Outlook Mail (`Mail.*`) delegated permissions **are** fully supported for personal accounts.

**Consequences for scope:**

| Service | MSA support | Plan |
|---|---|---|
| OneDrive | ✅ Full (Files.ReadWrite) | Phase 2 — core deliverable |
| Outlook Mail | ✅ Full (Mail.ReadWrite, Mail.Send) | Phase 3 — core deliverable |
| Outlook Calendar/Contacts | ✅ (Calendars.ReadWrite, Contacts.Read) | Optional stretch, nearly free once Mail works |
| Teams (personal MSA) | ❌ No Graph API | Phase 0 spike re-verifies; if still unsupported, descope to backlog |
| Teams Free / "Teams Essentials" | ✅ (these are Entra ID accounts) | Works if the account is actually Entra-backed, not MSA |

**Phase 0 must determine which kind of Teams account you actually have.** If you signed into Teams with a pure personal Microsoft account, Teams is out of v1. If it's a Teams Free org account, Teams support becomes a config option (the app registration below already allows both account types).

---

## 2. Architecture

```
Claude Desktop
   │  stdio (MCP protocol)
   ▼
windows-live-connector (.mcpb bundle)
   ├─ Node.js 20+ / TypeScript
   ├─ @modelcontextprotocol/sdk        (MCP server, stdio transport)
   ├─ @azure/msal-node                 (OAuth 2.0 auth-code + PKCE, public client)
   ├─ @azure/msal-node-extensions      (token cache persisted via Windows DPAPI)
   └─ Microsoft Graph REST v1.0        (plain fetch or @microsoft/microsoft-graph-client)
        ├─ /me/drive/...               OneDrive
        ├─ /me/messages, /me/sendMail  Outlook Mail
        └─ /me/chats (conditional)     Teams
```

**Key decisions:**

- **Local MCP server, stdio transport, packaged as `.mcpb`** (MCP Bundle — the current Claude Desktop extension format, successor to `.dxt`). One-click install; Claude Desktop ships its own Node runtime, so no prerequisites for the user. During development, run unpackaged via a `claude_desktop_config.json` entry.
- **Auth = OAuth 2.0 authorization-code flow with PKCE, public client** (no client secret — it can't be kept secret in a desktop app and MSA public clients don't need one). Redirect to `http://localhost:<ephemeral-port>` loopback; MSAL Node handles the local listener and opens the system browser for sign-in.
- **Token cache encrypted at rest** with DPAPI via `msal-node-extensions` `PersistenceCreator` — refresh tokens for a personal mailbox must never sit in plaintext JSON.
- **All Graph calls via v1.0 endpoint**, retry-with-backoff on 429/503 (Graph throttles aggressively on consumer mailboxes).

### App registration (Microsoft Entra portal, one-time)

- New registration, supported account types: **"Personal Microsoft accounts and accounts in any organizational directory"** (keeps the Teams-Free door open).
- Platform: **Mobile and desktop applications**, redirect URI `http://localhost`.
- Delegated permissions (all MSA-compatible, no admin consent needed):
  `User.Read`, `Files.ReadWrite.All`, `Mail.ReadWrite`, `Mail.Send`, `offline_access`
  Optional: `Calendars.ReadWrite`, `Contacts.Read`
  Conditional (Entra accounts only): `Chat.Read`, `Chat.ReadWrite`, `Team.ReadBasic.All`
- No verification/publisher process needed for personal use; the consent screen will show "unverified" — acceptable for a single-user tool.

---

## 3. Tool surface (MCP tools exposed to Claude)

### Auth / meta
| Tool | Behavior |
|---|---|
| `ms_login` | Kicks off browser sign-in; returns account display name when done |
| `ms_logout` | Clears token cache |
| `ms_whoami` | Current account, granted scopes, token expiry |

### OneDrive (Phase 2)
| Tool | Graph call |
|---|---|
| `onedrive_list` | `GET /me/drive/root:/{path}:/children` (paged) |
| `onedrive_search` | `GET /me/drive/root/search(q='...')` |
| `onedrive_read_file` | `GET .../content` — text returned inline, binaries to a download dir with size cap (~4 MB simple GET; ranged download above) |
| `onedrive_upload_file` | `PUT .../content` small files; upload session ≥ 4 MB |
| `onedrive_get_metadata` | item facets, share links, modified times |
| `onedrive_create_folder` / `onedrive_move` / `onedrive_delete` | standard item ops (`delete` → recycle bin only, never permanent) |

### Outlook Mail (Phase 3)
| Tool | Graph call |
|---|---|
| `mail_search` | `GET /me/messages?$search=...` or `$filter` |
| `mail_list` | folder listing with paging, `$select` to keep payloads small |
| `mail_read` | full message, body as text; attachments listed, fetched on demand |
| `mail_create_draft` | `POST /me/messages` — **default path for composing** |
| `mail_send` | `POST /me/sendMail` — annotated so Claude asks the user before sending |
| `mail_move` / `mail_flag` / `mail_mark_read` | triage ops |

### Teams (conditional, Phase 6)
`teams_list_chats`, `teams_read_chat`, `teams_send_message` — built only if Phase 0 shows the account is Entra-backed.

---

## 4. Phases

**Phase 0 — Spike (½ day).** Register the Entra app. Throwaway Node script: MSAL PKCE login with the real account → call `/me`, `/me/drive/root/children`, `/me/messages?$top=1`, `/me/chats`. Record exactly which succeed. *Exit criteria: auth works end-to-end; Teams verdict is documented.* This kills the biggest risks before any real code.

**Phase 1 — Skeleton + auth (1–2 days).** TypeScript project, MCP server over stdio with `ms_login`/`ms_whoami`/`ms_logout`, DPAPI-persisted token cache, silent token refresh, dev entry in `claude_desktop_config.json`. *Exit: Claude Desktop can sign in, restart, and still be signed in.*

**Phase 2 — OneDrive (2–3 days).** Read-only tools first (list/search/read/metadata), then writes (upload/folder/move/delete-to-recycle-bin). Paging, large-file handling, path vs. item-id addressing. *Exit: "find my tax PDF on OneDrive and summarize it" works in Claude Desktop.*

**Phase 3 — Outlook Mail (2–3 days).** Read/search/triage first, then draft + send. HTML→text body conversion, attachment handling, `$select`/`$top` discipline to keep token usage sane. *Exit: "summarize unread mail from this week and draft a reply to X" works.*

**Phase 4 — Packaging (1 day).** `manifest.json`, build with `@anthropic-ai/mcpb` CLI (`mcpb pack`), user-config surface for optional settings (download directory, read-only mode toggle). Install the `.mcpb` from scratch on a clean profile. *Exit: double-click install works without a dev setup.*

**Phase 5 — Hardening (1–2 days).** 429 retry/backoff, token-expiry mid-call recovery, clear error strings surfaced to Claude ("not signed in — run ms_login"), integration test checklist, README.

**Phase 6 — Teams (conditional, 2 days).** Only if Phase 0 said yes. Otherwise document the limitation and the workaround (Teams personal chats are reachable only through the Teams client itself — no API).

**Total: roughly 8–12 working days**, with OneDrive + Mail shippable at the end of Phase 4.

---

## 5. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Teams personal has no API | **Near-certain** | Phase 0 verdict; descope, document, offer Teams-Free path |
| MSA consent screen quirks (some Graph scopes silently dropped for MSA) | Medium | Phase 0 spike tests every scope with the real account |
| Refresh-token expiry (MSA refresh tokens revoke on password change / ~90-day inactivity) | Medium | Silent-fail → clear "please ms_login again" error, never crash |
| Graph throttling on consumer mailboxes | Medium | Backoff + `$select`/`$top` discipline from day one |
| Prompt-injection via mail/file content driving destructive tool calls | Medium | `mail_send` and all destructive ops annotated to require user confirmation; deletes go to recycle bin only; optional read-only mode |
| Large attachments/files blowing out context | High | Size caps, inline-text vs. save-to-disk split |

## 6. Security notes

- Public client + PKCE, no secrets in the bundle.
- Token cache DPAPI-encrypted, scoped to the Windows user.
- Least-privilege scopes; read-only mode as a manifest user-config option.
- Destructive/irreversible actions (send mail, delete) are separate tools with warning annotations so Claude confirms with the user first — never bundled into "helpful" composite tools.

## 7. Open questions for the owner

1. Which Teams are you actually using — Teams personal (MSA sign-in) or Teams Free (Entra)? Determines whether Phase 6 exists.
2. Should mail **send** be in v1, or draft-only (safer default)?
3. Any interest in Calendar/Contacts while the Mail plumbing is warm?
