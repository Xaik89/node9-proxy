# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added

- **Shadow Git Snapshots (Phase 2):** (Coming Soon) Automatic lightweight git commits before AI edits, allowing `node9 undo`.

---

## [0.3.0] - 2026-03-06

### Added

- **Multi-Channel Race Engine:** Node9 now fires all enabled approval channels simultaneously (Native Popup, Browser UI, Cloud/Slack, and Terminal). The first channel to receive a human signature wins and instantly cancels all other pending racers.
- **AI Negotiation Loop:** Replaced generic "Access Denied" errors with instructional feedback prompts. When blocked, Node9 injects a structured message into the LLM's context window, teaching the agent to apologize, explain its reasoning, or pivot to a safer alternative.
- **Native OS Dialogs:** Integrated sub-second, keyboard-navigable approval dialogs via `osascript` (macOS), `zenity` (Linux), and `PowerShell` (Windows).
- **Resolution Waterfall:** Implemented a strict 5-tier configuration precedence engine: `Environment Variables` > `Cloud (SaaS)` > `Project Config` > `Global Config` > `Defaults`.
- **Identity-Aware Execution:** The policy engine now distinguishes between a Human (`Terminal`) and an AI Agent (`Claude/Gemini`). Manual shell commands now benefit from "Nuclear-only" protection, while AI agents remain under "Zero Trust" restrictions.
- **Extended Hook Timeouts:** Default hook timeouts for Claude and Gemini have been increased to 10 minutes to support asynchronous Slack and remote approvals.
- **Sandbox Paths:** Added `policy.sandboxPaths` support. Any command operating strictly within defined safe zones (e.g., `/tmp/**`) is automatically allowed without human intervention.
- **Atomic File Writes:** Implemented `atomicWriteSync` for all state files (`decisions.json`, `trust.json`, `PAUSED`). This prevents JSON corruption during concurrent AI tool calls.

### Fixed

- **True Proxy Interception:** Rewrote the Proxy/MCP runner to intercept the Agent's `stdin` (requests) rather than just monitoring the Server's `stdout` (responses). Dangerous actions are now caught _before_ they reach the target server.
- **Port Conflict Resurrection:** The daemon now detects zombie PID files and `EADDRINUSE` errors, automatically clearing dead processes and resurrecting the server.
- **Credential Separation:** API keys are now strictly isolated in `~/.node9/credentials.json` and are never read from project-level config files to prevent accidental leakage to version control.

### Security

- **Waterfall Governance:** Cloud-level "Organization Policies" now act as a Master Lock, disabling local "Allow" buttons in the Native and Browser UIs when a remote manager signature is required.
- **Graceful Idle Timeout:** The background daemon now implements a 12-hour inactivity timer to automatically shut down and free system resources after use.

---

## [0.2.0] - 2026-03-01

### Added

- **Local Approval Daemon:** `node9 daemon` starts a browser-based approval UI at `http://127.0.0.1:7391`. Approve, deny, or set persistent per-tool decisions ("Always Allow" / "Always Deny") without a Slack account.
- **Persistent Decisions Panel:** The daemon browser UI shows a `📋 Persistent Decisions` panel listing every "Always Allow" / "Always Deny" decision with a **Revoke** button. Revoking a decision removes it from `~/.node9/decisions.json` and updates all open tabs instantly via SSE.
- **`GET /decisions` endpoint:** Returns the current persistent decisions map (read-only, no CSRF required).
- **`DELETE /decisions/:toolName` endpoint:** Removes a persistent decision (requires `X-Node9-Token` CSRF header).
- **Auto-start Daemon:** When a dangerous call arrives and no approval mechanism is running, Node9 automatically starts the daemon and opens the browser — no manual setup required.
- **Browser-Close Fallback:** If the browser tab is closed mid-approval, Node9 waits 2 seconds (to allow for an accidental refresh), then abandons the request and falls back to a terminal Y/N prompt, then blocks if there is no TTY. The daemon shuts down cleanly after abandonment.
- **`autoStartDaemon` Setting:** Toggle daemon auto-start from the browser UI (⚙️ Settings) or via `settings.autoStartDaemon: false` in `~/.node9/config.json`. When disabled, dangerous commands fall back directly to a terminal prompt.
- **Smart Runner — Browser-First Flow:** `node9 "rm -rf ./data"` now prefers the browser popup over a plain terminal prompt. Terminal Y/N is only shown if the daemon fails to start. This makes the full approval UI available without pre-running `node9 daemon`.
- **Terminal Prompt Timeout:** The interactive Y/N approval prompt now auto-denies after 30 seconds if no response is given, preventing agents from hanging indefinitely when a human walks away.
- **Smart Runner:** Node9 intercepts the initial command you pass to it (e.g., `node9 "rm -rf /"`) and checks it against your security policy before execution.
- **Improved Gemini CLI Integration:** Fully supports the latest Gemini CLI hook schema (array-based `BeforeTool`/`AfterTool`).
- **Verbose Policy Debugging:** Added `~/.node9/hook-debug.log` to help troubleshoot hook payloads (`NODE9_DEBUG=1`).
- **`getGlobalSettings()` API:** Reads machine-level settings from `~/.node9/config.json` independently of project config, so daemon lifecycle preferences are never overridden by a project's policy file.

### Fixed

- **Case-Insensitive Tool Matching:** Tool names like `Shell`, `shell`, and `run_shell_command` are now correctly identified and intercepted regardless of casing.
- **Robust Hook Setup:** `node9 addto gemini` now automatically detects and fixes outdated object-based hook configurations in `settings.json`.
- **Duplicate Interception:** Fixed a bug where `run_shell_command` was in the default `ignoredTools` list, preventing it from being properly inspected. Also corrected the example `node9.config.json`.
- **`node9 check` stdin Hang:** The hook no longer hangs if the AI agent opens stdin but never sends EOF. A 5-second safety timeout ensures the process exits cleanly.
- **Smart Runner Terminal Prompt:** `allowTerminalFallback` was not being passed in the smart runner path, so the Y/N prompt never appeared. Now correctly shown when no daemon is running and a TTY is available.

### Security

- **CSRF Token on Daemon:** A per-run UUID token is embedded in the browser UI and required as `X-Node9-Token` on all state-changing requests (`POST /decision`, `POST /settings`). Prevents other local processes from silently approving pending actions.
- **Credentials File Permissions:** `~/.node9/credentials.json` is now written with `0o600` (owner read/write only).
- **Daemon Error Logging:** Handler errors in `/check`, `/decision`, and `/settings` are now logged to stderr when `NODE9_DEBUG=1`, making production debugging possible without exposing errors by default.

### Changed

- `node9 addto` now supports the new array-based hook structure for Gemini CLI.
- Updated internal `GeminiSettings` interfaces to match the latest CLI specifications.

---

## [0.1.0] - 2026-02-01

### Added

- Initial release
- `node9 proxy` — MCP JSON-RPC interceptor (wraps any MCP server or shell command)
- `node9 login` — saves API key to `~/.node9/credentials.json` for Slack routing
- `node9.config.json` — project-level policy configuration (`standard` / `strict` modes, `dangerousWords`, `ignoredTools`)
- Local terminal HITL approval via `@inquirer/prompts`
- Slack remote approval via Node9 Cloud API (Pro)
