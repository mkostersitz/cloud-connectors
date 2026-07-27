# iCloud Connector for Claude Desktop — Plan

**Goal:** MCP connector (`.mcpb`) for a personal iCloud account: Mail + iCloud Drive. Sibling of the Microsoft connector, built on `@cloud-connectors/core`.

**Status:** In build (2026-07-17). Delegated to subagents.

## Constraints that shape the design

Apple has no Graph-style consumer API and no OAuth for third parties. Consequences:

| Service | Approach |
|---|---|
| Mail | IMAP (`imap.mail.me.com:993` TLS) + SMTP (`smtp.mail.me.com:587` STARTTLS), authenticated with the Apple ID email + an **app-specific password** the user generates at account.apple.com. Officially supported, stable. |
| Drive | No API. Operate on the **local iCloud Drive sync folder** (Windows: `%USERPROFILE%\iCloudDrive`; macOS: `~/Library/Mobile Documents/com~apple~CloudDocs`), configurable override. Requires the iCloud client installed and syncing. |
| Calendar/Contacts | CalDAV/CardDAV — deferred to v2. |
| Photos, Notes, Reminders, Messages | No viable supported path. Out of scope. Reverse-engineered private icloud.com APIs (pyicloud-style) rejected: ToS risk, 2FA automation, breaks silently. |

**Security model note:** the app-specific password is a full-mailbox credential (no scoping). It is declared `"sensitive": true` in the manifest so Claude Desktop stores it in the OS keychain and injects it as an env var; the connector never persists it itself and never logs it. Revocable at account.apple.com.

## Architecture

```
packages/icloud-connector
  src/config.ts      env (ICLOUD_EMAIL, ICLOUD_APP_PASSWORD, ICLOUD_DRIVE_PATH), hosts, drive-root resolution
  src/imap.ts        connection helper (connect → op → logout per call), message-id convention "MAILBOX:UID"
  src/tools/mail.ts  icloud_status + 8 mail tools (IMAP/SMTP via imapflow, nodemailer, mailparser)
  src/tools/drive.ts 8 drive tools (local FS confined to the iCloud root; deletes via `trash` → OS recycle bin)
  src/index.ts       serveStdio bootstrap (core)
```

Deps: `imapflow` (IMAP), `nodemailer` (SMTP), `mailparser` (MIME→text), `trash` (recycle-bin delete), plus core/sdk/zod.

## Tool surface

**Meta:** `icloud_status` — verifies IMAP login + drive folder presence.
**Mail (mirrors the Microsoft set):** `icloud_mail_list`, `icloud_mail_search`, `icloud_mail_read`, `icloud_mail_get_attachment`, `icloud_mail_create_draft` (APPEND to Drafts), `icloud_mail_send` (SMTP + append to Sent Messages; destructive, confirm-first), `icloud_mail_move`, `icloud_mail_mark`.
**Drive:** `icloud_drive_list`, `icloud_drive_search`, `icloud_drive_get_metadata`, `icloud_drive_read_file`, `icloud_drive_write_file`, `icloud_drive_create_folder`, `icloud_drive_move`, `icloud_drive_delete` (recycle bin via `trash`; destructive annotation).

Safety invariants: all drive paths resolved and confined under the iCloud root (no `..` escapes, symlinks resolved); deletes recoverable; send confirmation-gated; attachment/read size caps as in the Microsoft connector.

## Phases

1. Scaffold package (done by orchestrator).
2. Mail module + Drive module — parallel subagents.
3. Integration, build, manifest, `.mcpb` pack (orchestrator + pack script).
4. Live verification — needs the user to generate an app-specific password and configure the extension; connector is testable against the owner's iCloud account.
5. v2 candidates: CalDAV calendar, CardDAV contacts, IMAP IDLE-based "check for new mail since".

## Risks

- **Files-on-demand placeholders:** un-hydrated iCloud Drive files on Windows hydrate on first read via the cloud filter driver — reads may block or fail if the iCloud client isn't running. Surface a clear error.
- **IMAP quirks:** iCloud folder names ("Sent Messages", "Deleted Messages"), UIDVALIDITY changes invalidating "MAILBOX:UID" ids, `$search` charset issues. Mitigate: list folders dynamically, tolerate stale ids with a clear "re-list the folder" error.
- **SMTP sent-copy:** iCloud does not auto-save SMTP sends; the connector must APPEND to Sent Messages itself or sent mail silently vanishes from the mailbox view.
- **App-specific password breadth:** documented in README; nothing technical can narrow it.
