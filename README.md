# Orcstrator — ChatGPT ⇄ OpenCode (Firefox)

Type in ChatGPT, have **OpenCode** do the work locally, and read the streamed
answer back in a side panel on the ChatGPT page.

```
ChatGPT page (injected.js) ──► content.js ──► background.js ──► bridge :8787 ──► opencode :49374
                                       ▲                              │
                                       └──── SSE /events/:chatId ◄────┘
```

## Status (v0.3.0, verified)

- Bridge talks to **OpenCode v2** (`/api/info`, `/api/session`,
  `/api/session/:id/prompt`, `/api/session/:id/message`, `/api/event`) over
  direct HTTP with Basic auth. End-to-end tested: prompt → `session.text.delta`
  SSE → message history.
- Extension is **Firefox-first** (event-page background, `browser.*` with
  `chrome.*` fallback, `browser_specific_settings.gecko`). A Chrome build is
  emitted too.
- **ChatGPT ⇄ OpenCode conversation loop** (relay mode, default): you write in
  ChatGPT, **ChatGPT answers first**, its answer is relayed to OpenCode, and
  OpenCode's reply is injected back into the ChatGPT chat (marked
  `[OpenCode]`), so the two agents keep talking. Bounded by "loop turns"
  (popup, default 4); the panel header shows a `relaying ⟳` badge you can
  click to switch to panel-only mode at any time; **stop** ends the loop.
- The page panel renders streamed text/reasoning deltas, run status, tool
  notes, errors, plus a stop button and recent history.
- **Streaming fix**: the SSE connection is owned by the **background script**
  and forwarded to the page (`content.js` → `window.postMessage`). Neither the
  page nor content scripts can reach `http://127.0.0.1:*` from `chatgpt.com`
  (page CSP in Chrome; CORS/mixed-content in Firefox), but the background can.
- **Model/agent pickers**: popup inputs suggest live values from the bridge
  (`GET /models`, `GET /agents`); free text still works (`provider/model`).
- **Folder browser**: the panel shows the OpenCode working directory and a
  `folders` button opens a server-side browser (`GET /browse`). Choosing a
  folder starts the next message in a new session rooted there, so OpenCode
  writes to the right place.

## Prerequisites

- Firefox 121+ (you have 157 — good).
- OpenCode v2 (`opencode` on PATH; background service on
  `http://127.0.0.1:49374`).
- Node 22 (only needed to run the bridge / rebuild the extension).

## 1. Start the bridge

```bash
cd /home/omarcash/Documents/GitHub/orcstrator_extension
export PATH=/tmp/opencode/node-v22.17.1-linux-x64/bin:$PATH   # if node isn't on PATH
cp config.example.json config.json   # optional; then edit projectDir etc.
./node_modules/.bin/tsx bridge/src/server.ts
# Orcstrator bridge v0.2.0 listening at http://127.0.0.1:8787
```

Config resolution (first hit wins for top-level keys): `config.json` in cwd →
`~/.config/orcstrator/config.json` → env (`ORC_PORT`, `ORC_HOST`,
`OPENCODE_URL`, `OPENCODE_USERNAME`, `OPENCODE_PASSWORD`, `ORC_PROJECT_DIR`).
If no OpenCode password is configured, the bridge auto-reads it from
`~/.local/state/opencode/service.json` (written by `opencode serve --service`).

Check: `curl http://127.0.0.1:8787/health` → `{"ok":true,...}`.

Bridge API:

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | bridge + OpenCode status |
| POST | `/chatgpt/new` | `{chatId,title?,model?,agent?}` → new OpenCode session |
| POST | `/chatgpt/prompt` | `{chatId,text,model?,agent?,resume?}` → send prompt |
| GET | `/chatgpt/messages?chatId=` | recent OpenCode messages for the chat |
| POST | `/chatgpt/abort` | `{chatId}` → stop the run |
| GET | `/events/:chatId` | SSE fan-out of the OpenCode event stream |
| GET | `/convs` | chatId → session map (`?chatId=` filters to one) |
| GET | `/models` | live OpenCode models for the popup picker |
| GET | `/agents` | live OpenCode agents for the popup picker |
| GET | `/browse?dir=` | server-side folder listing for the panel folder browser |

Model format: `"provider/model"`, e.g. `"opencode/longcat-2.5-preview-free"`.
`POST /chatgpt/prompt` also accepts `"directory"` — an absolute local path.
If it differs from the chat's current session directory, the bridge starts a
new OpenCode session there (response includes `fresh:true`).

Model format: `"provider/model"`, e.g. `"opencode/longcat-2.5-preview-free"`.

## 2. Load the extension in Firefox

1. Rebuild (if you changed `extension/`): `node scripts/build-ext.mjs`
   (needs the node on PATH as above). Outputs `dist/extension` (Chrome) and
   **`dist/extension-firefox`** (Firefox).
2. Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** →
   select `dist/extension-firefox/manifest.json`.
3. Open the extension popup → set **Bridge URL** (`http://127.0.0.1:8787`),
   optional agent/model → **Test** should show green → **Save**.
4. Open `https://chatgpt.com`, type a message, press Enter. The Orcstrator
   panel (top-right) shows the streamed OpenCode answer. Use **stop** to abort.

Notes:

- Temporary add-ons unload when Firefox closes; reload them the same way.
  For persistence, package/sign via `web-ext build` + addons.mozilla.org.
- ChatGPT SPA navigation is tracked: each `/c/<id>` conversation maps to its
  own OpenCode session.
- Set **Forward to → ChatGPT (passthrough)** in the popup to disable
  interception without unloading the extension.

## 3. Develop

### The panel (v0.5.0 UI)

- **Hide it freely**: the `×` button hides the panel; an **Orcstrator launcher chip** stays bottom-right of the page — click it to reopen anytime. While a loop runs while hidden, the chip's dot pulses (amber = working, red = error).
- **Model & agent dropdowns** live in the panel: pick from every OpenCode model (`provider/id`) and agent. Choices apply from the very next message and are saved (the popup still works too).
- **Stop button** is red, enabled only while a run/relay chain is active, and aborts the OpenCode run plus ends the loop.
- `⟳` toggles the ChatGPT ⇄ OpenCode relay loop on/off; `–` collapses the panel to the header.
- **Resilient loop end detection (v0.6.1)**: OpenCode normally ends with `session.execution.succeeded`,
  but stalled/aborted runs can go `session.idle` with no end event — the relay now treats that as
  finish (and reports "no text to send back" if there is none), plus a watchdog warns if OpenCode
  is eventless for 15+ minutes instead of waiting forever in silence.
- **Edge cases (v0.7.0)**:
  - *ChatGPT usage limits* ("Chat paused until usage resets tomorrow at 12:07 AM", file/image-chat
    limits, max-message limits): detected on send, while the loop runs (each watchdog minute) and
    before each inject-back. One desktop notification raises per distinct banner and the panel logs
    it. While the limit stands, OpenCode still runs and streams into the panel, but the reply is
    **not** auto-sent back into ChatGPT (it would just be refused); when the banner disappears the
    relay resumes normal sending automatically.
  - *Smarter stall reports*: the watchdog's 15-min warning now queries the bridge for OpenCode's
    real last-activity time, so it can tell you "OpenCode IS progressing, the SSE pipe probably
    died" vs "OpenCode itself looks stalled". The warning is also a desktop notification.
- **`⌨ TUI`** opens this conversation's OpenCode session in a live terminal window (spawned by the
  bridge, which runs on your machine): a new tmux window when `TMUX` is set, else a desktop
  **kitty**/**alacritty** window cd'd into the session's folder. If no terminal can be spawned
  (e.g. systemd-run bridge), the exact `cd … && opencode -s …` command is copied to your clipboard
  instead — each ChatGPT conversation maps to one OpenCode session, and the TUI streams the loop
  live (ChatGPT's prompt lands, tools fire, the reply streams).

```bash
./node_modules/.bin/tsc --noEmit   # typecheck bridge
node scripts/build-ext.mjs         # rebuild both extension targets
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Popup shows `unreachable` | bridge not running / wrong Bridge URL; `curl :8787/health` |
| `Authentication required` in bridge log | set `OPENCODE_PASSWORD`, or ensure `opencode serve --service` state file exists |
| `Model ... has been deprecated` in panel | pick a live model in the popup (e.g. `opencode/longcat-2.5-preview-free`) |
| Prompt still goes to ChatGPT | popup **Forward to** must be `opencode`; reload the ChatGPT tab after Save |
| Panel shows `stream error` | **Fixed in v0.3.0**: reload the extension (new `content.js` relay) **and** reload the ChatGPT tab. If it persists, the bridge is down: `curl :8787/health` |
| Panel shows `bridge unreachable` on send | popup Bridge URL wrong, or bridge not running |
| Relay loop answers endlessly | it's bounded by **Loop turns** in the popup (default 4 ChatGPT→OpenCode relays per message); **stop** or the panel badge also pauses the loop; switch to panel-only to disable it |
| Nothing relays automatically / stops mid-loop | the loop is fully automatic: only your **first** message needs Enter. After every OpenCode finish, Orcstrator types the `[OpenCode] …` reply into the composer and presses send itself, then watches for ChatGPT's reaction — bounded by the popup's Loop turns. v0.4.8 also self-heals the auto-send: if the send button didn't register the click, the extension verifies the composer and retries with a keyboard Enter automatically. Console breadcrumbs: `OpenCode finished` → `OpenCode reply injected into ChatGPT` → `auto-send retry …` (only when needed) → `api poller sees finished reply` etc. |
