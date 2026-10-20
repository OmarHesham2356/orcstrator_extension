/* Orcstrator page script (runs in ChatGPT page context).
 * Forwards prompts to the local bridge (which drives OpenCode) and renders
 * OpenCode's streamed answer in a side panel.
 */
(function () {
  "use strict";

  // ---------- bridge RPC (relayed by content.js -> background.js) ----------
  let _reqId = 0;
  const _pending = new Map();
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.type === "orcstrator:bridge-resp" && _pending.has(e.data.id)) {
      const { resolve, timer } = _pending.get(e.data.id);
      _pending.delete(e.data.id);
      clearTimeout(timer);
      resolve(e.data.resp);
    }
  });
  function sendToBridge(msg, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++_reqId;
      const timer = setTimeout(() => {
        _pending.delete(id);
        reject(new Error("bridge timeout"));
      }, timeoutMs || 30000);
      _pending.set(id, { resolve, timer });
      window.postMessage({ type: "orcstrator:to-bridge", id, payload: msg }, "*");
    });
  }
  const bridgePost = (bridgeUrl, path, body) =>
    sendToBridge({ type: "to-bridge", bridgeUrl, path, method: "POST", body });
  const bridgeGet = (bridgeUrl, path) =>
    sendToBridge({ type: "to-bridge", bridgeUrl, path, method: "GET" }, 15000);
  // GET path under https://chatgpt.com/backend-api with session cookies,
  // executed by the background script (same-origin credentials included).
  const chatgptApiGet = (path) =>
    sendToBridge({ type: "to-chatgpt", path }, 15000);

  function getConfig() {
    return new Promise((res) => {
      const onMsg = (e) => {
        if (e.source !== window) return;
        if (e.data && e.data.type === "orcstrator:config") {
          window.removeEventListener("message", onMsg);
          clearTimeout(t);
          res(e.data.config || {});
        }
      };
      window.addEventListener("message", onMsg);
      const t = setTimeout(() => {
        window.removeEventListener("message", onMsg);
        res({});
      }, 3000);
      window.postMessage({ type: "orcstrator:config-request" }, "*");
    });
  }

  // ---------- ChatGPT DOM helpers ----------
  function getPromptEl() {
    return (
      document.querySelector("#prompt-textarea") ||
      document.querySelector('[data-qa="message-input"]') ||
      document.querySelector('textarea[placeholder*="message" i]') ||
      document.querySelector("form textarea") ||
      document.querySelector('[contenteditable="true"][role="textbox"]') ||
      Array.from(document.querySelectorAll("textarea")).find((x) => x.offsetParent !== null)
    );
  }
  function readPromptText() {
    let text = "";
    const vis = (el) => el && el.offsetParent !== null;
    for (const t of Array.from(document.querySelectorAll("textarea"))) {
      if (vis(t) && t.value && t.value.trim()) {
        text = t.value;
        break;
      }
    }
    if (!text) {
      for (const ce of Array.from(document.querySelectorAll('[contenteditable="true"]'))) {
        if (!vis(ce)) continue;
        const t = ce.innerText || ce.textContent || "";
        if (t.trim()) {
          text = t;
          break;
        }
      }
    }
    return String(text || "").trim();
  }
  function clearPromptInput() {
    const ta = getPromptEl();
    try {
      if (ta && ta.value !== undefined) {
        ta.focus();
        ta.value = "";
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const pm = document.querySelector("#prompt-textarea");
      if (pm) {
        pm.focus();
        // ProseMirror: select-all + delete so its view model updates.
        document.execCommand("selectAll", false, null);
        document.execCommand("delete", false, null);
        pm.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } catch {}
  }
  function getCurrentChatId() {
    try {
      const m = location.pathname.match(/\/c\/([^/]+)/);
      if (m) return m[1];
      return "local-" + btoa(location.pathname + "|" + Date.now()).slice(0, 12);
    } catch {
      return "unknown";
    }
  }
  function isSendBtn(btn) {
    if (!btn) return false;
    const label = (
      (btn.getAttribute("aria-label") || "") +
      " " +
      (btn.getAttribute("data-testid") || "") +
      " " +
      (btn.innerText || "")
    ).toLowerCase();
    if (label.includes("stop")) return false; // streaming stop button
    if (label.includes("send")) return true;
    // Only an actual type=submit counts. NOTE: never treat "any button
    // inside a form that has a textbox" as send — that rule used to match
    // the + / attach / tools icons, which come EARLIER in DOM order, so
    // the auto-click hit the attach ("+") button instead of Send.
    if (btn.getAttribute("type") === "submit" && btn.closest("form")) return true;
    return false;
  }
  // Pick the best send widget: dedicated testid > aria-label send > the
  // last enabled type=submit (send is the rightmost composer action).
  function findSendBtn() {
    return (
      document.querySelector('[data-testid="send-button"]') ||
      document.querySelector('button[aria-label*="send" i]') ||
      (() => {
        const subs = Array.from(document.querySelectorAll('form button[type="submit"]')).filter(
          (b) => !b.disabled && b.getAttribute("aria-disabled") !== "true"
        );
        return subs.length ? subs[subs.length - 1] : null;
      })()
    );
  }

  // ---------- side panel ----------
  const PANEL_ID = "orcstrator-panel";
  let panel = null;
  let chipEl = null; // reopen launcher, visible while the panel is hidden
  let bodyEl = null;
  let statusEl = null;
  let dirEl = null;
  let relayBadgeEl = null;
  let currentAnswer = null; // { textEl, thinkEl, thinkBody, metaEl, text, thinking }
  let state = {
    bridgeUrl: "",
    chatId: "",
    busy: false,
    busyLabel: "",
    collapsed: false,
    directory: "",
    // relay loop: ChatGPT reply -> OpenCode -> OpenCode reply -> ChatGPT ...
    relayMode: "relay", // "relay" | "direct"
    maxTurns: 4,
    turnBudget: 0,
    relayActive: false, // a chain is currently running
  };

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function ensurePanel() {
    if (panel && document.contains(panel)) return panel;
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML =
      '<div class="orc-accent"></div>' +
      '<div class="orc-head">' +
      '<span class="orc-dot"></span><span class="orc-title">Orcstrator</span>' +
      '<span class="orc-status">idle</span>' +
      '<button class="orc-btn orc-icon orc-relay" title="toggle ChatGPT⇄OpenCode relay loop">⟳</button>' +
      '<button class="orc-btn orc-icon orc-toggle" title="collapse">–</button>' +
      '<button class="orc-btn orc-icon orc-close" title="hide panel — reopen it from the launcher">×</button>' +
      "</div>" +
      '<div class="orc-sub"><span class="orc-dir" title="OpenCode working directory">…</span>' +
      '<button class="orc-btn orc-tui" title="watch this conversation\'s OpenCode session in a live terminal TUI">⌨ TUI</button>' +
      '<button class="orc-btn orc-folders" title="choose working folder">📁 folders</button></div>' +
      '<div class="orc-selrow">' +
      '<label class="orc-selwrap" title="OpenCode model (provider/model)"><span class="orc-selcap">model</span><select class="orc-model"><option value="">…</option></select></label>' +
      '<label class="orc-selwrap" title="OpenCode agent"><span class="orc-selcap">agent</span><select class="orc-agent"><option value="">…</option></select></label>' +
      '<button class="orc-btn orc-abort" title="abort the OpenCode run and end the relay chain">■ stop</button>' +
      "</div>" +
      '<div class="orc-body"></div>';
    const css = document.createElement("style");
    css.textContent =
      "#" + PANEL_ID + "{position:fixed;top:64px;right:12px;width:392px;max-height:74vh;display:flex;flex-direction:column;z-index:2147483647;background:rgba(15,15,22,.92);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);color:#e9e9f2;border:1px solid rgba(255,255,255,.09);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.55);font:13px/1.5 system-ui,-apple-system,sans-serif;overflow:hidden}" +
      "#" + PANEL_ID + ".orc-hidden{display:none}" +
      // reopen launcher chip
      "#orcstrator-chip{position:fixed;bottom:18px;right:16px;z-index:2147483647;display:none;align-items:center;gap:6px;background:rgba(15,15,22,.94);color:#e9e9f2;border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:7px 14px;cursor:pointer;font:600 12px/1 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.5);transition:transform .15s ease}" +
      "#orcstrator-chip:hover{transform:translateY(-2px);border-color:#6f7bff}" +
      "#orcstrator-chip .c-dot{width:7px;height:7px;border-radius:50%;background:#555}" +
      "#orcstrator-chip.orc-live .c-dot{background:#f5b301;animation:orc-blink 1s infinite}" +
      "#orcstrator-chip.orc-live.err .c-dot{background:#e5484d}" +
      // gradient accent line
      "#" + PANEL_ID + " .orc-accent{height:3px;background:linear-gradient(90deg,#6f7bff,#8a4bff 45%,#00c9a7);flex:none}" +
      "#" + PANEL_ID + " .orc-head{display:flex;align-items:center;gap:8px;padding:9px 10px 8px;background:transparent;border-bottom:1px solid rgba(255,255,255,.07)}" +
      "#" + PANEL_ID + " .orc-dot{width:8px;height:8px;border-radius:50%;background:#555;flex:none}" +
      "#" + PANEL_ID + ".orc-busy .orc-dot{background:#f5b301;animation:orc-blink 1s infinite}" +
      "#" + PANEL_ID + ".orc-error .orc-dot{background:#e5484d}" +
      "#" + PANEL_ID + ".orc-ok .orc-dot{background:#46a758}" +
      "@keyframes orc-blink{50%{opacity:.3}}" +
      "#" + PANEL_ID + " .orc-title{font-weight:700;font-size:12.5px;white-space:nowrap}" +
      "#" + PANEL_ID + " .orc-status{font-size:10.5px;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.07);color:#b9b9c9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:118px;flex:1}" +
      "#" + PANEL_ID + ".orc-busy .orc-status{background:rgba(245,179,1,.12);color:#f5b301}" +
      "#" + PANEL_ID + ".orc-error .orc-status{background:rgba(229,72,77,.14);color:#ff9a9e}" +
      "#" + PANEL_ID + ".orc-ok .orc-status{background:rgba(70,167,88,.14);color:#7adaa0}" +
      "#" + PANEL_ID + " .orc-btn{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#e9e9f2;border-radius:8px;padding:3px 9px;cursor:pointer;font-size:11.5px;line-height:1.4;transition:background .15s,border-color .15s}" +
      "#" + PANEL_ID + " .orc-btn:hover{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.25)}" +
      "#" + PANEL_ID + " .orc-btn.orc-icon{width:24px;height:24px;padding:0;display:inline-flex;align-items:center;justify-content:center;font-size:13px;flex:none}" +
      "#" + PANEL_ID + " .orc-abort{flex:none;margin-left:auto;border-color:rgba(229,72,77,.45);color:#ff9a9e;background:rgba(229,72,77,.08)}" +
      "#" + PANEL_ID + " .orc-abort:hover{background:rgba(229,72,77,.2);border-color:rgba(229,72,77,.7)}" +
      "#" + PANEL_ID + " .orc-abort:disabled{opacity:.35;cursor:not-allowed;background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.1);color:#b9b9c9}" +
      "#" + PANEL_ID + " .orc-relay.orc-on{color:#8ab4ff;border-color:rgba(111,123,255,.5);background:rgba(111,123,255,.12)}" +
      "#" + PANEL_ID + " .orc-sub{display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(255,255,255,.02);border-bottom:1px solid rgba(255,255,255,.06);font-size:11px}" +
      "#" + PANEL_ID + " .orc-dir{flex:1;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}" +
      // picker row
      "#" + PANEL_ID + " .orc-selrow{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid rgba(255,255,255,.06);background:rgba(255,255,255,.02)}" +
      "#" + PANEL_ID + " .orc-selwrap{display:flex;align-items:center;gap:5px;min-width:0}" +
      "#" + PANEL_ID + " .orc-selcap{font-size:10px;text-transform:uppercase;letter-spacing:.5px;opacity:.55}" +
      "#" + PANEL_ID + " .orc-selwrap select{max-width:130px;background:#171722;color:#e9e9f2;border:1px solid rgba(255,255,255,.14);border-radius:7px;padding:2px 5px;font-size:11.5px;cursor:pointer;outline:none}" +
      "#" + PANEL_ID + " .orc-selwrap select:hover{border-color:rgba(255,255,255,.3)}" +
      "#" + PANEL_ID + " .orc-selwrap select:focus{border-color:#6f7bff}" +
      "#" + PANEL_ID + " .orc-body{padding:10px;overflow-y:auto;flex:1;min-height:80px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}" +
      "#" + PANEL_ID + " .orc-body::-webkit-scrollbar{width:8px}" +
      "#" + PANEL_ID + " .orc-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:8px}" +
      "#" + PANEL_ID + " .orc-collapsed .orc-sub,.orc-collapsed .orc-selrow,.orc-collapsed .orc-body{display:none}" +
      "#" + PANEL_ID + " .orc-msg{margin:0 0 10px;white-space:pre-wrap;word-break:break-word;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.05)}" +
      "#" + PANEL_ID + " .orc-msg.user{background:rgba(111,123,255,.08);border-color:rgba(111,123,255,.18)}" +
      "#" + PANEL_ID + " .orc-msg .orc-meta{font-size:10.5px;opacity:.6;margin-bottom:3px;text-transform:uppercase;letter-spacing:.4px}" +
      "#" + PANEL_ID + " .orc-think{border:1px solid rgba(255,255,255,.08);border-radius:8px;margin:0 0 8px;background:rgba(0,0,0,.2)}" +
      "#" + PANEL_ID + " .orc-think summary{cursor:pointer;font-size:10.5px;opacity:.7;padding:3px 8px}" +
      "#" + PANEL_ID + " .orc-think pre{margin:0;padding:2px 8px 8px;font-size:11px;opacity:.6;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}" +
      "#" + PANEL_ID + " .orc-err{color:#ff9a9e;background:rgba(229,72,77,.08);border-color:rgba(229,72,77,.2)}" +
      "#" + PANEL_ID + " .orc-tools{font-size:10.5px;opacity:.6;margin-top:5px}" +
      "#" + PANEL_ID + " .orc-note{font-size:11px;opacity:.65;margin:0 0 8px;padding:5px 8px;border-radius:8px;background:rgba(255,255,255,.02);border:1px dashed rgba(255,255,255,.08)}" +
      "#orcstrator-folders{position:fixed;z-index:2147483647;top:120px;right:420px;width:340px;max-height:60vh;display:flex;flex-direction:column;background:rgba(15,15,22,.95);backdrop-filter:blur(14px);color:#e9e9f2;border:1px solid rgba(255,255,255,.09);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.55);font:13px/1.5 system-ui,sans-serif;overflow:hidden}" +
      "#orcstrator-folders.orc-hidden{display:none}" +
      "#orcstrator-folders .orc-fhead{padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.08);font-weight:600;font-size:12px;background:rgba(255,255,255,.03)}" +
      "#orcstrator-folders .orc-crumb{padding:6px 10px;font-size:11px;opacity:.85;word-break:break-all;border-bottom:1px solid rgba(255,255,255,.06)}" +
      "#orcstrator-folders .orc-crumb button{background:none;border:none;color:#8ab4ff;cursor:pointer;font-size:11px;padding:0 4px}" +
      "#orcstrator-folders .orc-flist{overflow-y:auto;padding:4px}" +
      "#orcstrator-folders .orc-fitem{display:block;width:100%;text-align:left;background:none;border:none;color:#e9e9f2;padding:5px 9px;border-radius:7px;cursor:pointer;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      "#orcstrator-folders .orc-fitem.dir:hover{background:rgba(255,255,255,.07)}" +
      "#orcstrator-folders .orc-fitem.file{opacity:.35;cursor:default}" +
      "#orcstrator-folders .orc-ffoot{display:flex;gap:8px;padding:8px 10px;border-top:1px solid rgba(255,255,255,.09)}" +
      "#orcstrator-folders .orc-ffoot .orc-btn{flex:1;padding:6px;cursor:pointer;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#e9e9f2;border-radius:8px;font-size:12px}" +
      "#orcstrator-folders .orc-ffoot .orc-use{border-color:rgba(70,167,88,.5);color:#7adaa0;background:rgba(70,167,88,.1)}";
    document.documentElement.appendChild(css);
    document.documentElement.appendChild(panel);

    // Floating launcher chip: the ONLY way back in after hiding (×).
    chipEl = document.createElement("button");
    chipEl.id = "orcstrator-chip";
    chipEl.innerHTML = '<span class="c-dot"></span>Orcstrator';
    chipEl.title = "reopen the Orcstrator panel";
    chipEl.onclick = () => showPanel();
    document.documentElement.appendChild(chipEl);

    bodyEl = panel.querySelector(".orc-body");
    statusEl = panel.querySelector(".orc-status");
    dirEl = panel.querySelector(".orc-dir");
    relayBadgeEl = panel.querySelector(".orc-relay");
    relayBadgeEl.onclick = () => {
      setRelay(state.relayMode === "relay" ? "direct" : "relay");
      appendNote(
        state.relayMode === "relay"
          ? "relay ON: ChatGPT ⇄ OpenCode loop active — messages flow between them"
          : "relay OFF: your prompt goes straight to OpenCode, answer shows only here"
      );
    };
    renderRelayBadge();
    panel.querySelector(".orc-close").onclick = () => hidePanel();
    panel.querySelector(".orc-toggle").onclick = (ev) => {
      state.collapsed = !state.collapsed;
      panel.classList.toggle("orc-collapsed", state.collapsed);
      ev.target.textContent = state.collapsed ? "+" : "–";
    };
    panel.querySelector(".orc-abort").onclick = async () => {
      try {
        await bridgePost(state.bridgeUrl, "/chatgpt/abort", { chatId: state.chatId });
      } catch (e) {}
      stopRelayChain();
      appendNote("stopped by user — OpenCode run aborted, chain ended");
      setStatus("idle", "aborted");
      refreshStopBtn();
    };
    panel.querySelector(".orc-folders").onclick = () => openFolders(state.directory || null);
    panel.querySelector(".orc-tui").onclick = () => openTui();
    populatePickers();
    return panel;
  }

  function panelVisible() {
    return !!(panel && document.contains(panel)) && !panel.classList.contains("orc-hidden");
  }
  function showPanel() {
    ensurePanel();
    panel.classList.remove("orc-hidden");
    chipEl.style.display = "none";
  }
  function hidePanel() {
    ensurePanel();
    panel.classList.add("orc-hidden");
    chipEl.style.display = "flex";
  }

  // ---------- in-panel model/agent dropdowns ----------
  // Live dropdowns replace the popup datalists as the primary picker.
  // Changes apply instantly (used by the very next relay/send) and persist
  // to the same "orc" config the popup reads.
  function writeCfg(patch) {
    window.postMessage({ type: "orcstrator:config-write", patch }, "*");
  }
  function fillSel(sel, items, saved, emptyLabel) {
    sel.innerHTML = "";
    const o0 = document.createElement("option");
    o0.value = "";
    o0.textContent = emptyLabel;
    sel.appendChild(o0);
    for (const it of items) {
      const o = document.createElement("option");
      o.value = it.value;
      o.textContent = it.label;
      sel.appendChild(o);
    }
    if (saved) {
      if (!Array.from(sel.options).some((o) => o.value === saved)) {
        const o = document.createElement("option");
        o.value = saved;
        o.textContent = saved + " (saved)";
        sel.appendChild(o);
      }
      sel.value = saved;
    }
  }
  async function populatePickers() {
    if (!panel) return;
    const mSel = panel.querySelector(".orc-model");
    const aSel = panel.querySelector(".orc-agent");
    try {
      const [mr, ar] = await Promise.all([
        bridgeGet(state.bridgeUrl, "/models"),
        bridgeGet(state.bridgeUrl, "/agents"),
      ]);
      const models = ((mr && mr.ok && mr.json.data) || []).map((x) => ({
        value: x.providerID + "/" + x.id,
        label: x.providerID + "/" + x.id,
      }));
      const agents = ((ar && ar.ok && ar.json.data) || []).map((x) => ({
        value: x.id,
        label: x.name || x.id,
      }));
      fillSel(mSel, models, bridgeModel, "auto (default)");
      fillSel(aSel, agents, bridgeAgent, "default agent");
      mSel.onchange = () => {
        bridgeModel = mSel.value || undefined;
        writeCfg({ model: bridgeModel });
        appendNote("model set to " + (bridgeModel || "auto") + " (applies to the next message)");
      };
      aSel.onchange = () => {
        bridgeAgent = aSel.value || undefined;
        writeCfg({ agent: bridgeAgent });
        appendNote("agent set to " + (bridgeAgent || "default") + " (applies to the next message)");
      };
    } catch {
      // Bridge down: leave the (saved) selection editable via popup.
      fillSel(mSel, [], bridgeModel, "bridge offline");
      fillSel(aSel, [], bridgeAgent, "bridge offline");
    }
    refreshStopBtn();
  }
  function refreshStopBtn() {
    if (!panel) return;
    const stop = panel.querySelector(".orc-abort");
    if (!stop) return;
    const running = state.relayActive || state.busy;
    stop.disabled = !running;
    stop.textContent = running ? "■ stop" : "■ stop";
    stop.title = running
      ? "abort the OpenCode run and end the relay chain"
      : "nothing running";
  }

  // ---------- OpenCode TUI launcher ----------
  // Asks the bridge (which runs on your machine) to spawn a terminal window
  // running `opencode -s <id>` in this conversation's working directory.
  function copyText(t) {
    return new Promise(async (resolve) => {
      try {
        await navigator.clipboard.writeText(t);
        resolve(true);
        return;
      } catch {}
      try {
        const ta = document.createElement("textarea");
        ta.value = t;
        ta.style.cssText = "position:fixed;opacity:0;left:-999px";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        resolve(ok);
      } catch {
        resolve(false);
      }
    });
  }
  async function openTui() {
    ensurePanel();
    if (!state.chatId) {
      appendNote("no ChatGPT conversation detected yet — the TUI opens this chat's OpenCode session, so send a message first");
      return;
    }
    appendNote("asking bridge to open a terminal for session of " + state.chatId.slice(0, 8) + "…");
    try {
      const r = await bridgePost(state.bridgeUrl, "/tui", { chatId: state.chatId });
      const j = (r && r.json) || {};
      if (j.ok) {
        appendNote("OpenCode TUI opened in a new terminal (" + j.method + ") — session " + String(j.session || "").slice(0, 14) + "… — the conversation streams live there");
      } else if (j.command) {
        const copied = await copyText(j.command);
        appendError(
          (j.error || "bridge could not open a terminal") +
            (copied ? " — copied to clipboard, paste it into a terminal:" : " — run this in a terminal:") +
            "\n" + j.command
        );
      } else {
        appendError(j.error || "bridge refused the TUI request");
      }
    } catch (e) {
      appendError("TUI open failed — bridge unreachable: " + String((e && e.message) || e));
    }
  }

  // ---------- ChatGPT usage-limit handling (v0.7.0) ----------
  // Edge case: ChatGPT account caps the loop dead — "Chat paused until usage
  // resets tomorrow at 12:07 AM", "You've reached the limit for chats that
  // include files or images", and friends. While a limit notice is visible:
  //   1. OpenCode still gets the prompt and produces its reply,
  //   2. but NOTHING is auto-sent into ChatGPT (the reply stays in the panel),
  //   3. a system notification + prominent panel note tell the user why,
  //   4. auto-send re-enables:
  //        - at the parsed reset time ("tomorrow at 12:07 AM" style), or
  //        - when the notice has been gone for 3 scans and no reset time
  //          could be parsed (false alarm / transient toast).
  const LIMIT_RE =
    /chat paused until[\s\S]{0,120}?usage resets?|you(?:'ve| have)? (?:reached|hit)[^\n]{0,60}limit for (?:chats|files|images|messages)|reached your [^\n]{0,30}(?:usage|quota|cap|daily|file|image) limit|usage limit was reached|(?:your|the)[^\n]{0,40}limit (?:will )?resets?/i;
  const limitState = { active: false, detail: "", untilTs: 0, missStreak: 0 };
  let limitTimer = null;
  function notifyOrc(title, text) {
    window.postMessage({ type: "orcstrator:notify", title, text }, "*");
  }
  function parseResetTime(text) {
    // "usage resets tomorrow at 12:07 AM" — take the next occurrence of the
    // clock time (ChatGPT's resets are almost always tomorrow/morning).
    const m = String(text).match(/(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)/i);
    if (!m) return 0;
    let h = parseInt(m[1], 10) % 12;
    const n = 60 * 1000;
    const min = parseInt(m[2], 10);
    if (/p/i.test(m[3])) h += 12;
    const now = new Date();
    const cand = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0);
    if (cand.getTime() <= Date.now() + 60 * 1000) cand.setDate(cand.getDate() + 1);
    return cand.getTime();
  }
  function scanLimitBanner() {
    let found = null;
    const nodes = document.querySelectorAll("div,span,p,h1,h2,h3,h4,h5,li,td");
    for (const el of nodes) {
      if (el.closest && el.closest('form,[id^="prompt-textarea"],[contenteditable="true"]')) continue;
      const t = (el.textContent || "").trim();
      if (!t || t.length > 420) continue;
      if (!LIMIT_RE.test(t)) continue;
      found = t;
      break;
    }
    return found;
  }
  function resetTimeLabel() {
    return limitState.untilTs
      ? new Date(limitState.untilTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";
  }
  function syncLimitNote() {
    if (!limitState.active) return;
    const label = resetTimeLabel();
    setStatus("busy", "ChatGPT limited" + (label ? " (resets " + label + ")" : ""));
  }
  function limitClear(reason) {
    limitState.active = false;
    limitState.untilTs = 0;
    limitState.detail = "";
    appendNote("usage-limit pause lifted — " + reason);
    notifyOrc("Orcstrator — relay re-enabled", "ChatGPT limit " + reason);
  }
  function limitTick() {
    if (!limitState.active) {
      const found = scanLimitBanner();
      if (!found) return;
      limitState.active = true;
      limitState.detail = found.slice(0, 220);
      limitState.untilTs = parseResetTime(found);
      limitState.missStreak = 0;
      console.warn("[orcstrator] ChatGPT usage limit detected:", limitState.detail);
      appendError(
        "ChatGPT usage limit detected — auto-send PAUSED; OpenCode replies stay in this panel" +
          (limitState.untilTs ? " until ~" + resetTimeLabel() : "") +
          ' Banner: "' + limitState.detail + '"'
      );
      notifyOrc(
        "Orcstrator — auto-send paused",
        "ChatGPT hit a usage limit" +
          (limitState.untilTs ? " (resets " + resetTimeLabel() + ")" : "") +
          ". OpenCode replies stay in the panel until it lifts."
      );
      syncLimitNote();
      return;
    }
    if (limitState.untilTs) {
      if (Date.now() >= limitState.untilTs) limitClear("reset time reached");
      return;
    }
    // No reset time parsed: end the pause once the notice is gone for sure.
    if (scanLimitBanner()) {
      limitState.missStreak = 0;
      syncLimitNote();
    } else if (++limitState.missStreak >= 3) {
      limitClear("no limit notice visible anymore");
    }
  }
  function armLimitWatch() {
    if (limitTimer) return;
    limitTimer = setInterval(limitTick, 6000);
  }
  function renderRelayBadge() {
    if (!relayBadgeEl) return;
    relayBadgeEl.textContent = state.relayMode === "relay" ? "⟳" : "◇";
    relayBadgeEl.classList.toggle("orc-on", state.relayMode === "relay");
    relayBadgeEl.title =
      state.relayMode === "relay"
        ? "Relay loop is ON: ChatGPT's replies are sent to OpenCode and OpenCode answers back into the chat. Click for panel-only."
        : "Panel-only mode: prompts go to OpenCode, answers show here. Click to enable the ChatGPT⇄OpenCode loop.";
  }
  function setRelay(mode) {
    state.relayMode = mode;
    if (mode === "direct") {
      stopRelayChain("relay off");
    }
    renderRelayBadge();
  }
  function setDirLabel(dir) {
    ensurePanel();
    if (dirEl) {
      dirEl.textContent = dir || "(default project dir)";
      dirEl.title = "OpenCode working directory: " + (dir || "(bridge default)");
    }
  }
  function appendNote(text) {
    ensurePanel(); // visibility stays under the user's control (×/launcher chip)
    const d = document.createElement("div");
    d.className = "orc-note";
    d.textContent = text;
    bodyEl.appendChild(d);
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  // ---------- folder browser overlay ----------
  let foldersEl = null;
  let browseDir = "";
  function ensureFolders() {
    if (foldersEl && document.contains(foldersEl)) return foldersEl;
    foldersEl = document.createElement("div");
    foldersEl.id = "orcstrator-folders";
    foldersEl.className = "orc-hidden";
    foldersEl.innerHTML =
      '<div class="orc-fhead">Working folder — where OpenCode writes</div>' +
      '<div class="orc-crumb"></div>' +
      '<div class="orc-flist"></div>' +
      '<div class="orc-ffoot"><button class="orc-btn orc-use">Use this folder</button>' +
      '<button class="orc-btn orc-fclose">Close</button></div>';
    document.documentElement.appendChild(foldersEl);
    foldersEl.querySelector(".orc-fclose").onclick = () => foldersEl.classList.add("orc-hidden");
    foldersEl.querySelector(".orc-use").onclick = () => {
      state.directory = browseDir;
      setDirLabel(browseDir);
      foldersEl.classList.add("orc-hidden");
      appendNote("working folder set to " + browseDir + " — next message starts a session there");
    };
    return foldersEl;
  }
  async function openFolders(startDir) {
    ensureFolders();
    foldersEl.classList.remove("orc-hidden");
    await browse(startDir || state.directory || "");
  }
  async function browse(dir) {
    const list = foldersEl.querySelector(".orc-flist");
    const crumb = foldersEl.querySelector(".orc-crumb");
    list.innerHTML = "<div class='orc-note'>loading…</div>";
    let j = null;
    try {
      const r = await bridgeGet(state.bridgeUrl, "/browse?dir=" + encodeURIComponent(dir));
      j = r && r.ok ? r.json : null;
    } catch {}
    if (!j || !j.dir) {
      list.innerHTML = "<div class='orc-note'>cannot list folders (bridge down?)</div>";
      return;
    }
    browseDir = j.dir;
    crumb.innerHTML = "";
    crumb.appendChild(document.createTextNode(j.dir + " "));
    const mk = (label, target) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = () => browse(target);
      crumb.appendChild(b);
    };
    mk("↑", j.parent);
    mk("home", j.home);
    mk("default", j.defaultDir);
    list.innerHTML = "";
    for (const e of j.entries || []) {
      const b = document.createElement("button");
      b.className = "orc-fitem " + (e.isDir ? "dir" : "file");
      b.textContent = (e.isDir ? "📁 " : "📄 ") + e.name;
      if (e.isDir) b.onclick = () => browse(e.path);
      list.appendChild(b);
    }
    if ((j.entries || []).length === 0) list.innerHTML = "<div class='orc-note'>(empty)</div>";
  }
  function setStatus(kind, text) {
    ensurePanel();
    panel.classList.remove("orc-busy", "orc-error", "orc-ok");
    if (kind === "busy") panel.classList.add("orc-busy");
    else if (kind === "error") panel.classList.add("orc-error");
    else if (kind === "ok") panel.classList.add("orc-ok");
    // NOTE: visibility is owned by the × button + launcher chip now;
    // status changes must not force-reopen a panel the user hid.
    if (statusEl) statusEl.textContent = text || kind;
    if (!panelVisible() && chipEl) {
      chipEl.classList.toggle("orc-live", kind === "busy");
      chipEl.classList.toggle("err", kind === "error");
    }
    refreshStopBtn();
  }
  function appendUser(text, meta) {
    ensurePanel(); // visibility stays under the user's control (×/launcher chip)
    const d = document.createElement("div");
    d.className = "orc-msg user";
    d.innerHTML = '<div class="orc-meta">' + esc(meta || "you → OpenCode") + "</div><div>" + esc(text).slice(0, 4000) + "</div>";
    bodyEl.appendChild(d);
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }
  function startAnswer(meta) {
    ensurePanel(); // visibility stays under the user's control (×/launcher chip)
    const wrap = document.createElement("div");
    wrap.className = "orc-msg assistant";
    wrap.innerHTML =
      '<div class="orc-meta">' + esc(meta || "opencode") + "</div>" +
      '<details class="orc-think" style="display:none"><summary>thinking</summary><pre></pre></details>' +
      '<div class="orc-text"></div>' +
      '<div class="orc-tools"></div>';
    bodyEl.appendChild(wrap);
    bodyEl.scrollTop = bodyEl.scrollHeight;
    currentAnswer = {
      wrap,
      textEl: wrap.querySelector(".orc-text"),
      thinkEl: wrap.querySelector(".orc-think"),
      thinkBody: wrap.querySelector(".orc-think pre"),
      toolsEl: wrap.querySelector(".orc-tools"),
      text: "",
      thinking: "",
    };
    return currentAnswer;
  }
  function appendTextDelta(delta) {
    if (!currentAnswer) startAnswer("opencode");
    currentAnswer.text += String(delta || "");
    currentAnswer.textEl.textContent = currentAnswer.text;
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }
  function appendThinkDelta(delta) {
    if (!currentAnswer) startAnswer("opencode");
    currentAnswer.thinkEl.style.display = "";
    currentAnswer.thinking += String(delta || "");
    currentAnswer.thinkBody.textContent = currentAnswer.thinking.slice(-6000);
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }
  function appendToolNote(note) {
    if (!currentAnswer) startAnswer("opencode");
    const d = document.createElement("div");
    d.textContent = note;
    currentAnswer.toolsEl.appendChild(d);
  }
  function appendError(msg) {
    console.warn("[orcstrator] error:", msg); // visible in the console too
    ensurePanel(); // visibility stays under the user's control (×/launcher chip)
    const d = document.createElement("div");
    d.className = "orc-msg orc-err";
    d.textContent = "error: " + msg;
    bodyEl.appendChild(d);
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  // ---------- stream events (owned by background, relayed via content.js) ----------
  // ChatGPT's page CSP blocks page-context streams to localhost, so the
  // background script owns the SSE connection and content.js forwards us
  // each parsed event via window.postMessage.
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.type === "orcstrator:event" && e.data.chatId === state.chatId) {
      let payload = null;
      try {
        payload = JSON.parse(e.data.data);
      } catch {
        return;
      }
      routeEvent(e.data.evType || (payload && payload.type) || "", payload);
    } else if (e.data.type === "orcstrator:event-status" && e.data.chatId === state.chatId) {
      handleStreamStatus(e.data.status, e.data.text);
    }
  });

  function attachSse(chatId, bridgeUrl) {
    window.postMessage({ type: "orcstrator:subscribe", chatId, bridgeUrl }, "*");
  }

  // ---------- network-hook reply capture (primary) ----------
  // ChatGPT's DOM classes/attributes drift; the assistant's reply always
  // arrives over the page's own fetch stream, which we can observe directly
  // from the page context. The hook collects passively at all times but is
  // host-filtered (chatgpt.com/openai.com only; localhost is excluded so it
  // never sees Orcstrator's own bridge traffic). Consumption is gated on an
  // armed reply watch, and a short catch-up window covers streams that
  // finished in the ~120ms gap between the user pressing Enter and the
  // watcher arming. A stream closing marks the reply complete — no DOM
  // stability guessing needed.
  const netHook = { installed: false, last: null, url: "", loggedNonStream: false }; // last = {text, at, consumed}

  function installNetHook() {
    if (netHook.installed) return;
    netHook.installed = true;
    const origFetch = window.fetch;
    if (typeof origFetch !== "function") return;
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (isCandidateUrl(url)) watchStream(p, url);
      } catch {}
      return p;
    };
    console.log("[orcstrator] net hook installed");
  }
  function isCandidateUrl(url) {
    if (!url) return false;
    const s = String(url);
    if (/^https?:\/\/(127\.|localhost)/i.test(s)) return false; // never our bridge
    if (/^https?:\/\//i.test(s)) {
      return /(^|\.)chatgpt\.com|(^|\.)openai\.com|oaistatic\.com/i.test(s);
    }
    return true; // same-origin relative URL
  }

  function watchStream(p, url) {
    const started = Date.now();
    const candidate = /conversation|chat|completions|companion/i.test(String(url));
    p.then(async (res) => {
      try {
        if (!res || !res.body) return;
        const ct = (res.headers && res.headers.get("content-type")) || "";
        if (!/event-stream|stream|text\/plain/i.test(ct)) {
          if (candidate && replyWatch.active && !netHook.loggedNonStream) {
            netHook.loggedNonStream = true;
            console.log("[orcstrator] net hook skips non-stream response " + ct + " from …" + String(url).slice(-70));
          }
          return;
        }
        netHook.url = url;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        const merge = makeMerger();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            let ev = null;
            try { ev = JSON.parse(data); } catch { continue; }
            merge(ev);
          }
        }
        hookFinish(started, url, merge.value());
      } catch {}
    }).catch(() => {});
  }

  // Segment-by-message-id text merger, mirroring ChatGPT's own logic: each
  // message id gets cumulative snapshot text (later chunks replace shorter
  // prefixes/rollbacks), a new id starts a new segment, and delta chunks
  // (no id) append. Verified by unit tests against the decoded bundle format.
  function makeMerger() {
    let id = null;
    let acc = "";
    const segs = [];
    const merge = function (ev) {
      const piece = extractAssistantPiece(ev);
      if (!piece) return;
      const mid = (ev && ev.message && ev.message.id) || null;
      if (mid && id && mid !== id) {
        if (acc) segs.push(acc);
        acc = "";
        id = mid;
      } else if (mid && !id) {
        id = mid;
      }
      if (!acc) { acc = piece; return; }
      if (acc === piece) return;
      if (piece.startsWith(acc) || acc.startsWith(piece)) { acc = piece; return; }
      if (acc.endsWith(piece)) return; // duplicate tail
      acc += piece; // delta style
    };
    merge.value = () => (segs.length ? segs.join("\n\n") + (acc ? "\n\n" + acc : "") : acc).trim();
    return merge;
  }

  // Pull assistant text out of one SSE JSON chunk. This shape was decoded
  // from ChatGPT's own bundle: chunks carry a `message` with author.role /
  // recipient / channel / content{content_type,parts} and end_turn/status.
  // Visible reply text is ONLY: role assistant, recipient "all"/null,
  // channel "final"/null, content_type text with string parts. Chunk data
  // lines are separated with \n\n and the stream ends with a `[DONE]` line.
  function extractAssistantPiece(ev) {
    if (!ev || typeof ev !== "object") return "";
    const m = (ev.message || (ev.v && ev.v.message)) || null;
    if (m && typeof m === "object") {
      const author = m.author || {};
      if (author.role !== "assistant") return "";
      if (m.recipient != null && m.recipient !== "all") return "";
      if (m.channel != null && m.channel !== "final") return ""; // reasoning/commentary/side channels
      const c = m.content || {};
      const ct = String(c.content_type || c.contentType || "text").toLowerCase();
      if (ct && ct !== "text") return "";
      const parts = Array.isArray(c.parts) ? c.parts.filter((x) => typeof x === "string") : null;
      if (!parts) return "";
      return parts.join("");
    }
    // Fallback shapes: {author:"assistant", text:"..."} or bounded deep scan.
    if ((ev.role || ev.author) === "assistant" && typeof ev.text === "string") return ev.text;
    const stack = [ev];
    let steps = 0;
    while (stack.length && steps++ < 60) {
      const obj = stack.pop();
      if (!obj || typeof obj !== "object") continue;
      if (obj.author && obj.author.role === "assistant" && obj.content && Array.isArray(obj.content.parts)) {
        const parts = obj.content.parts.filter((x) => typeof x === "string");
        if (parts.length) return parts.join("");
      }
      for (const k of Object.keys(obj)) {
        if (obj[k] && typeof obj[k] === "object") stack.push(obj[k]);
      }
    }
    return "";
  }

  function hookFinish(started, url, acc) {
    const text = String(acc || "").trim();
    if (!text || text.length < 2) {
      if (replyWatch.active && /conversation|chat|completions|companion/i.test(String(url))) {
        console.log("[orcstrator] net hook: stream from …" + String(url).slice(-80) + " completed but no assistant-matched chunks (wrong format?)");
      }
      return;
    }
    netHook.last = { text, at: Date.now(), consumed: false };
    if (replyWatch.active) {
      // Live path: a stream that started after this watch armed and now
      // closed IS the reply we are waiting for.
      if (started >= replyWatch.startedAt - 1500) {
        console.log("[orcstrator] net hook captured ChatGPT reply (" + text.length + " chars) via " + String(url).slice(-80));
        consumeReply(text, "net hook");
      }
    }
  }

  // Single capture gate: whichever detector fires first (net hook or DOM
  // watch) wins; the other is cancelled.
  function consumeReply(text, via) {
    if (!replyWatch.active) return;
    if (netHook.last) netHook.last.consumed = true;
    stopReplyWatch();
    console.log("[orcstrator] ChatGPT reply captured via " + via + ", " + text.length + " chars");
    onChatGptReply(text);
  }

  // ---------- ChatGPT ⇄ OpenCode relay loop ----------
  // Flow: user sends -> ChatGPT answers (its own model plans) -> we capture that
  // answer -> send to OpenCode -> OpenCode work+reply -> we inject the reply
  // back into the ChatGPT composer (marked "[OpenCode]") -> ChatGPT reacts ->
  // loop until turn budget runs out. "maxTurns" = how many ChatGPT->OpenCode
  // relays are allowed per user message.
  const replyWatch = {
    active: false,
    gen: 0, // generation counter; stale observer/poller ticks are ignored
    observer: null,
    poller: null,
    fallback: false, // true when ChatGPT's role attributes are unavailable
    anchorPos: -1, // primary mode: DOM index of the user message we await a reply for
    seen: new WeakSet(), // fallback mode: assistant elements already relayed
    lastText: "",
    stableSince: 0,
    streamingSince: 0,
    startedAt: 0, // arm time; net-hook catch-up window = startedAt-1500ms
    deadline: 0,
  };

  function getMsgEls() {
    return Array.from(document.querySelectorAll("[data-message-author-role]"));
  }
  function roleOf(el) {
    return el.getAttribute("data-message-author-role") || "";
  }
  function getAssistantEls() {
    const sel = '[data-message-author-role="assistant"]';
    let els = Array.from(document.querySelectorAll(sel));
    if (els.length === 0) {
      els = Array.from(document.querySelectorAll("article")).filter(
        (a) => a.querySelector(".markdown") || a.querySelector(".whitespace-pre-wrap")
      );
    }
    return els;
  }
  function assistantText(el) {
    if (!el) return "";
    const md = el.querySelector(".markdown");
    return String((md || el).innerText || "").trim();
  }
  // Real content only. Before the model streams, ChatGPT pre-mounts the reply
  // bubble with shimmer/placeholder/thinking decoration that has NO .markdown
  // node — this is how we tell pre-mount junk from an actual reply. (The old
  // WeakSet arm-time marking wrongly "saw" placeholders that carried junk
  // text and then never captured the real reply appended into that same node.)
  function assistantRealText(el) {
    if (!el) return "";
    const md = el.querySelector(".markdown");
    return String((md && md.innerText) || "").trim();
  }
  function chatIsStreaming() {
    const stop =
      document.querySelector('[data-testid="stop-button"]') ||
      document.querySelector('button[aria-label="Stop streaming"]') ||
      Array.from(document.querySelectorAll('button[aria-label]')).find((b) =>
        /stop (generat|stream|respond)/i.test(b.getAttribute("aria-label") || "")
      );
    return !!stop;
  }

  function startReplyWatch(reason) {
    if (state.relayMode !== "relay") return;
    if (replyWatch.active) return;
    const gen = ++replyWatch.gen;
    replyWatch.active = true;
    replyWatch.startedAt = Date.now();
    replyWatch.deadline = Date.now() + 240000; // 4 min cap
    replyWatch.lastText = "";
    replyWatch.stableSince = 0;
    replyWatch.streamingSince = 0;
    replyWatch.recovered = false;
    netHook.loggedNonStream = false;

    // Catch-up: an assistant stream that finished in the arming gap
    // (between pressing Enter and this watch activating) is the reply.
    if (netHook.last && !netHook.last.consumed && netHook.last.at >= replyWatch.startedAt - 2500) {
      const last = netHook.last;
      setTimeout(() => {
        if (!replyWatch.active || replyWatch.gen !== gen) return;
        if (last === netHook.last && !last.consumed) {
          console.log("[orcstrator] net hook catch-up: reply finished before arming");
          consumeReply(last.text, "net hook catch-up");
        }
      }, 250);
    }

    const msgs = getMsgEls();
    if (msgs.length > 0) {
      // Position-anchored detection. Messages only ever APPEND to the
      // conversation, so DOM indexes stay stable. The anchor is the user
      // message whose reply we are waiting for; the first assistant element
      // positioned after it is that reply. This is immune to the empty/
      // shimmering placeholders ChatGPT pre-mounts before streaming (the old
      // arm-time WeakSet marking could capture those and then never fire).
      replyWatch.fallback = false;
      let idx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (roleOf(msgs[i]) === "user") { idx = i; break; }
      }
      if (idx < 0) {
        // User message not mounted yet (watch armed before the SPA echoed
        // it): anchor just after the previous turn's assistant message.
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (roleOf(msgs[i]) === "assistant") { idx = i; break; }
        }
      }
      if (idx >= 0) {
        replyWatch.anchorPos = idx;
        console.log("[orcstrator] watch started (" + reason + "), mode=anchor, anchor=" + idx + "/" + msgs.length);
      } else {
        replyWatch.fallback = true;
        replyWatch.anchorPos = -1;
        replyWatch.seen = new WeakSet();
        console.log("[orcstrator] watch started (" + reason + "), mode=fallback (no anchors in DOM)");
      }
    } else {
      // No role attributes at all -> element-identity fallback + diagnostics:
      // dump a selector census once so a missing-attribute DOM is visible
      // straight from the user's console log.
      replyWatch.fallback = true;
      replyWatch.anchorPos = -1;
      replyWatch.seen = new WeakSet();
      for (const el of getAssistantEls()) {
        if (assistantRealText(el)) replyWatch.seen.add(el);
      }
      const census = {
        role: document.querySelectorAll("[data-message-author-role]").length,
        roleA: document.querySelectorAll('[data-message-author-role="assistant"]').length,
        article: document.querySelectorAll("article").length,
        md: document.querySelectorAll(".markdown").length,
        msgid: document.querySelectorAll("[data-message-id]").length,
        testid: document.querySelectorAll("[data-testid]").length,
      };
      console.log("[orcstrator] watch started (" + reason + "), mode=fallback");
      console.log("[orcstrator] DOM census:", JSON.stringify(census));
    }
    netHook.active = true; // arm the network capture for the same window
    startApiPoller(gen); // third detector: ChatGPT backend REST polling
    setStatus("busy", "waiting for ChatGPT" + (reason ? " (" + reason + ")" : ""));
    replyWatch.observer = new MutationObserver(() => checkReply(gen));
    replyWatch.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    replyWatch.poller = setInterval(() => checkReply(gen), 600); // safety net
  }

  // ---------- detector #3: ChatGPT backend REST polling ----------
  // Like the browser-daemon bridges: read the authoritative conversation
  // record (GET /backend-api/conversation/:id with session cookies) instead
  // of scraping anything. Runs every 2.5s while a reply watch is armed.
  const apiPoller = { timer: null, quietCount: 0, warned: false };

  function startApiPoller(gen) {
    stopApiPoller();
    apiPoller.quietCount = 0;
    apiPoller.warned = false;
    let failures = 0;
    const tick = async () => {
      if (!replyWatch.active || replyWatch.gen !== gen) return; // stale tick: silent, NEVER stop the live poller
      const convId = state.chatId;
      if (!convId || /^(local|unknown)/.test(convId)) return; // no URL uuid yet
      try {
        const r = await chatgptApiGet("/conversation/" + encodeURIComponent(convId));
        // Re-verify ownership AFTER the await: the watch may have been
        // consumed/stopped while this request was in flight.
        if (!replyWatch.active || replyWatch.gen !== gen) return;
        if (!r.ok) {
          failures += 1;
          if (failures === 3 && !apiPoller.warned) {
            apiPoller.warned = true;
            console.warn("[orcstrator] api poller failing (HTTP " + r.status + ") — net hook / DOM watch still active");
          }
          return;
        }
        failures = 0;
        const parsed = parseConversationReply(r.json, replyWatch.startedAt);
        if (!parsed) return;
        if (parsed.inProgressLater) return; // a newer assistant stream is running
        if (parsed.finished && parsed.finished.text) {
          console.log("[orcstrator] api poller sees finished reply from " + new Date(parsed.finished.t * 1000).toISOString());
          consumeReply(parsed.finished.text, "api poll");
        }
      } catch (e) {
        failures += 1;
        if (failures === 3 && !apiPoller.warned) {
          apiPoller.warned = true;
          console.warn("[orcstrator] api poller error:", String((e && e.message) || e));
        }
      }
    };
    tick();
    apiPoller.timer = setInterval(tick, 2500);
  }
  function stopApiPoller() {
    if (apiPoller.timer) {
      clearInterval(apiPoller.timer);
      apiPoller.timer = null;
    }
  }

  // Parse GET /backend-api/conversation/:id -> mapping of nodes holding
  // message objects (same shape as the stream chunks, plus create_time).
  function parseConversationReply(json, armMs) {
    if (!json || typeof json !== "object") return null;
    const root = json.data && json.data.mapping ? json.data : json;
    const mapping = root.mapping;
    if (!mapping) return null;
    const armSec = armMs / 1000;
    let finished = null; // {text, t}
    let inProgressLater = false;
    for (const key of Object.keys(mapping)) {
      const node = mapping[key];
      const m = node && node.message;
      if (!m || typeof m !== "object") continue;
      const author = m.author || {};
      if (author.role !== "assistant") continue;
      if (m.recipient != null && m.recipient !== "all") continue;
      if (m.channel != null && m.channel !== "final") continue;
      const c = m.content || {};
      const ct = String(c.content_type || c.contentType || "text").toLowerCase();
      if (ct && ct !== "text") continue;
      const parts = Array.isArray(c.parts) ? c.parts.filter((x) => typeof x === "string") : null;
      if (!parts) continue;
      const text = parts.join("").trim();
      const t = m.create_time || m.update_time || 0;
      const status = m.status || "";
      if (status === "in_progress" || (!status && !text)) {
        // still streaming — and if it started after the last finished
        // message we must wait for it instead of consuming the old text.
        if (finished && t > finished.t) inProgressLater = true;
        else if (!finished) inProgressLater = true;
        continue;
      }
      if (text && t >= armSec - 3) {
        if (!finished || t >= finished.t) finished = { text, t };
      }
    }
    return { finished, inProgressLater };
  }
  function stopReplyWatch() {
    if (replyWatch.observer) {
      try {
        replyWatch.observer.disconnect();
      } catch {}
      replyWatch.observer = null;
    }
    if (replyWatch.poller) {
      clearInterval(replyWatch.poller);
      replyWatch.poller = null;
    }
    replyWatch.active = false;
    stopApiPoller();
  }

  function checkReply(gen) {
    if (!replyWatch.active || replyWatch.gen !== gen) return; // stale tick
    if (Date.now() > replyWatch.deadline) {
      console.warn("[orcstrator] watch timed out");
      stopReplyWatch();
      finishRelay("timed out waiting for ChatGPT");
      return;
    }
    let cand = null;
    if (!replyWatch.fallback) {
      // First assistant element strictly after the anchor user message.
      const msgs = getMsgEls();
      for (let i = replyWatch.anchorPos + 1; i < msgs.length; i++) {
        if (roleOf(msgs[i]) === "assistant") { cand = msgs[i]; break; }
      }
      if (!cand) return; // reply bubble not mounted yet
      // Reject pre-mount placeholders: real replies carry a .markdown node.
      if (!assistantRealText(cand)) return;
    } else {
      // Late recovery: if role attributes appeared after we armed in
      // fallback mode, switch to the robust anchor scan instead.
      const msgs = getMsgEls();
      if (msgs.length > 0 && !replyWatch.recovered) {
        let idx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (roleOf(msgs[i]) === "user") { idx = i; break; }
        }
        if (idx < 0) {
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (roleOf(msgs[i]) === "assistant") { idx = i; break; }
          }
        }
        if (idx >= 0) {
          replyWatch.fallback = false;
          replyWatch.anchorPos = idx;
          replyWatch.recovered = true;
          console.log("[orcstrator] watch recovered into anchor mode, anchor=" + idx + "/" + msgs.length);
        }
      }
      // Fallback: newest assistant element not already relayed, with content.
      const els = getAssistantEls();
      for (let i = els.length - 1; i >= 0; i--) {
        const el = els[i];
        if (replyWatch.seen.has(el)) continue;
        if (assistantRealText(el)) { cand = el; break; }
      }
      if (!cand) return;
    }
    const text = assistantText(cand);
    if (!text) return; // can't happen (candidate had markdown text) but be safe

    const streaming = chatIsStreaming();
    if (streaming) {
      if (!replyWatch.streamingSince) replyWatch.streamingSince = Date.now();
      if (Date.now() - replyWatch.streamingSince < 90000) {
        replyWatch.stableSince = 0;
        replyWatch.lastText = text;
        return;
      }
      // "Streaming" stuck for 90s+ (e.g. a misdetected stop button) ->
      // trust text stability instead of the streaming flag.
      console.warn("[orcstrator] stop-button visible 90s+ — proceeding on text stability");
    } else {
      replyWatch.streamingSince = 0;
    }

    // Time-based stability: text unchanged for >=1.2s counts as complete.
    if (text !== replyWatch.lastText) {
      replyWatch.lastText = text;
      replyWatch.stableSince = Date.now();
      return;
    }
    if (!replyWatch.stableSince || Date.now() - replyWatch.stableSince < 1200) return;

    // ChatGPT's reply is complete -> relay it to OpenCode.
    if (replyWatch.fallback) replyWatch.seen.add(cand);
    consumeReply(text, "dom watch");
  }

  function onChatGptReply(text) {
    if (state.relayMode !== "relay") return stopRelayChain();
    if (state.turnBudget <= 0) {
      console.log("[orcstrator] turn budget exhausted, not relaying");
      return finishRelay("turn budget used up");
    }
    state.turnBudget -= 1;
    console.log("[orcstrator] relaying to OpenCode (turns left: " + state.turnBudget + ")");
    appendNote("ChatGPT → OpenCode · " + text.replace(/\s+/g, " ").slice(0, 140));
    relayToOpenCode(text);
  }

  async function relayToOpenCode(text) {
    state.busy = true;
    setStatus("busy", "OpenCode thinking…");
    state.chatId = getCurrentChatId();
    console.log("[orcstrator] relaying to OpenCode, chatId=" + state.chatId);
    try {
      const r = await bridgePost(state.bridgeUrl, "/chatgpt/prompt", {
        chatId: state.chatId,
        text,
        model: bridgeModel,
        agent: bridgeAgent,
        directory: state.directory || undefined,
      });
      if (!r || !r.ok) {
        const err = (r && (r.json && r.json.error || r.error)) || "bridge error";
        console.warn("[orcstrator] relay failed:", err);
        setStatus("error", "bridge error");
        appendError(String(err));
        return stopRelayChain();
      }
      if (r.json && r.json.directory) {
        state.directory = r.json.directory;
        setDirLabel(r.json.directory);
      }
      attachSse(state.chatId, state.bridgeUrl);
      armStallWatch();
      startAnswer("opencode");
    } catch (err) {
      console.warn("[orcstrator] relay error:", err);
      setStatus("error", "bridge unreachable");
      appendError(String((err && err.message) || err));
      stopRelayChain();
    }
  }

  // Called when OpenCode's run finishes; injects the reply back into ChatGPT.
  function onOpenCodeFinished() {
    const answer = currentAnswer && currentAnswer.text ? currentAnswer.text : "";
    if (state.relayMode !== "relay") return;
    console.log("[orcstrator] OpenCode finished, answer " + answer.length + " chars, turns left " + state.turnBudget);
    // Usage-limit gate: ChatGPT refuses submits while capped, so park the
    // answer in the panel instead of attempting an auto-send.
    if (limitState.active) {
      appendNote(
        "ChatGPT usage limit active — OpenCode's reply stays in this panel (auto-send paused" +
          (limitState.untilTs ? " until ~" + resetTimeLabel() : "") + ")"
      );
      syncLimitNote();
      return finishRelay("ChatGPT limited — reply kept in panel");
    }
    if (!answer.trim()) {
      appendNote("relay: OpenCode produced no text to send back");
      return finishRelay("no answer");
    }
    if (state.turnBudget <= 0) {
      appendNote("relay: turn budget used up — OpenCode's last reply stays in the panel");
      return finishRelay("");
    }
    appendNote("OpenCode → ChatGPT · " + answer.replace(/\s+/g, " ").slice(0, 140));
    injectOpenCodeReply("[OpenCode] " + answer)
      .then((sent) => {
        if (sent) {
          console.log("[orcstrator] OpenCode reply injected into ChatGPT");
          startReplyWatch("OpenCode reply sent");
        } else {
          console.warn("[orcstrator] composer inject failed");
          setStatus("error", "inject failed");
          appendError("could not type into the ChatGPT composer — inject manually or switch to panel-only");
          finishRelay("compose failed");
        }
      });
  }

  async function injectOpenCodeReply(text) {
    const ta =
      document.querySelector("#prompt-textarea") ||
      document.querySelector('[contenteditable="true"][role="textbox"]') ||
      document.querySelector("form textarea");
    if (!ta) return false;
    ta.focus();
    for (let i = 0; i < 10; i++) {
      if (document.activeElement === ta) break;
      ta.focus();
      await new Promise((r2) => setTimeout(r2, 100));
    }
    if (document.activeElement !== ta) return false;
    try {
      if (ta.tagName === "TEXTAREA") {
        ta.value = text;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        document.execCommand("selectAll", false, null);
        document.execCommand("insertText", false, text);
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } catch {
      return false;
    }
    await new Promise((r2) => setTimeout(r2, 150));
    const send = findSendBtn();
    if (!send || !send.isConnected) return false;
    selfInjecting = Date.now() + 1500; // our own send must not reset turn budget
    send.click();

    // Self-healing auto-send: verify the click actually took (the composer
    // should be empty afterwards). If the injected text is still sitting
    // there ~2s later, the button wasn't enabled yet when we clicked —
    // fall back to a keyboard Enter and a second click automatically.
    try {
      await new Promise((r2) => setTimeout(r2, 2000));
      if ((readPromptText() || "").includes("[OpenCode]")) {
        console.warn("[orcstrator] auto-send click did not register — retrying with keyboard Enter");
        selfInjecting = Date.now() + 1500;
        ta.focus();
        for (const type of ["keydown", "keypress", "keyup"]) {
          ta.dispatchEvent(
            new KeyboardEvent(type, {
              key: "Enter",
              code: "Enter",
              keyCode: 13,
              which: 13,
              bubbles: true,
              cancelable: true,
            })
          );
        }
        await new Promise((r2) => setTimeout(r2, 1200));
        if ((readPromptText() || "").includes("[OpenCode]")) {
          const send2 = findSendBtn();
          if (send2) send2.click();
          console.log("[orcstrator] auto-send retry via send button");
        } else {
          console.log("[orcstrator] auto-send retry (keyboard) delivered");
        }
      }
    } catch (e) {
      console.warn("[orcstrator] auto-send verify error:", e);
    }
    return true;
  }

  function finishRelay(reason) {
    stopRelayChain();
    if (reason) appendNote("relay ended: " + reason);
    setStatus("ok", "relay done");
  }
  function stopRelayChain(reason) {
    stopReplyWatch();
    state.relayActive = false;
    state.turnBudget = 0;
    state.busy = false;
    state.busyLabel = "";
    clearStallWatch();
    refreshStopBtn();
    if (reason) setStatus("idle", "relay stopped");
  }

  // ---------- OpenCode event watchdog ----------
  // OpenCode runs can legitimately take many minutes, but if NO events at all
  // arrive for 15 minutes (silent stall / dead provider / SSE hiccup) tell the
  // user instead of silently waiting forever. Non-destructive: if events
  // resume, the relay continues normally.
  let watchdogTimer = null;
  function armStallWatch() {
    clearStallWatch();
    state.lastEventTs = Date.now();
    watchdogTimer = setInterval(() => {
      if (!state.relayActive) return clearStallWatch();
      const since = Date.now() - (state.lastEventTs || 0);
      if (since >= 15 * 60 * 1000) {
        console.warn("[orcstrator] opencode silent for 15+ min — no events; run may be stalled");
        setStatus("error", "no OpenCode activity for 15 min");
        appendError(
          "OpenCode has emitted no events for over 15 minutes — the run may be stalled " +
            "(model/provider hang or a dead SSE pipe). Press ⏹ stop to end the chain, or keep waiting."
        );
        state.lastEventTs = Date.now(); // report once per silent window
      }
    }, 60 * 1000);
  }
  function clearStallWatch() {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }

  // The model/agent the bridge should use for relays (captured once at boot).
  let bridgeModel = undefined;
  let bridgeAgent = undefined;

  function handleStreamStatus(status, text) {
    if (status === "live") {
      if (state.busy) setStatus("busy", state.busyLabel || "working");
      else setStatus("ok", "live");
    } else if (status === "connecting" || status === "retry") {
      setStatus("busy", text || "connecting…");
    } else if (status === "bridge-down") {
      // The background pre-check failed — bridge is truly unreachable.
      setStatus("error", "stream error");
      appendError(
        (text || "bridge unreachable") +
          " — start the bridge (tsx bridge/src/server.ts), check the popup Bridge URL, then send again."
      );
    } else {
      setStatus("error", "stream error");
      appendError(text || "stream error");
    }
  }

  function routeEvent(type, payload) {
    // Watchdog bookkeeping: any event proves OpenCode is alive/progressing.
    state.lastEventTs = Date.now();
    const d = (payload && payload.data) || {};
    switch (type) {
      case "session.text.delta":
        if (typeof d.delta === "string") appendTextDelta(d.delta);
        else if (typeof payload.delta === "string") appendTextDelta(payload.delta);
        break;
      case "session.reasoning.delta":
        if (typeof d.delta === "string") appendThinkDelta(d.delta);
        break;
      case "session.step.started":
        state.busyLabel = "working" + (d.model && d.model.id ? " · " + d.model.id : "");
        setStatus("busy", state.busyLabel);
        if (d.assistantMessageID) startAnswer("opencode · " + ((d.model && d.model.id) || (d.agent || "")));
        break;
      case "session.execution.started":
        state.busyLabel = "running";
        setStatus("busy", "running");
        startAnswer("opencode");
        break;
      case "session.execution.succeeded":
        setStatus("ok", "done");
        state.busy = false;
        state.busyLabel = "";
        if (state.relayMode === "relay") onOpenCodeFinished();
        break;
      case "session.idle":
        // Backstop: some end paths only emit the session going idle
        // (e.g. a stalled/cancelled tool exec, abort) without a
        // succeeded/failed event. Without this the relay waits forever.
        state.busy = false;
        state.busyLabel = "";
        setStatus("ok", "done (idle)");
        console.log("[orcstrator] opencode session idle (no succeeded/failed event) — treating as finished");
        if (state.relayMode === "relay") onOpenCodeFinished();
        break;
      case "session.step.ended":
        setStatus("ok", "done");
        break;
      case "session.step.failed":
      case "session.execution.failed": {
        state.busy = false;
        state.busyLabel = "";
        const msg =
          (d.error && (d.error.message || d.error.type)) ||
          (payload.error && (payload.error.message || payload.error.type)) ||
          "run failed";
        setStatus("error", "failed");
        appendError(msg);
        if (state.relayMode === "relay") stopRelayChain("opencode failed");
        break;
      }
      case "session.tool.started":
      case "session.tool.updated":
        if (d.tool || d.name) appendToolNote("tool: " + (d.tool || d.name));
        break;
      default:
        // Unknown/verbose events are intentionally ignored to keep the panel clean.
        break;
    }
  }

  // ---------- send flow ----------
  let busyUntil = 0;
  let selfInjecting = 0; // timestamp until which sends are ours (relay loop)
  const isSelfSend = () => Date.now() < selfInjecting;

  async function handleSend(cfg) {
    const now = Date.now();
    if (now < busyUntil || state.busy) return false;
    const text = readPromptText();
    if (!text) return false;
    busyUntil = now + 2500;
    state.busy = true;
    const chatId = getCurrentChatId();
    state.chatId = chatId;
    setStatus("busy", "sending");
    appendUser(text);
    try {
      const r = await bridgePost(state.bridgeUrl, "/chatgpt/prompt", {
        chatId,
        text,
        model: cfg.model,
        agent: cfg.agent,
        directory: state.directory || undefined,
      });
      if (!r || !r.ok) {
        state.busy = false;
        const err = (r && (r.json && r.json.error || r.error)) || "bridge error";
        setStatus("error", "bridge error");
        appendError(String(err));
        return false;
      }
      if (r.json && r.json.directory) {
        state.directory = r.json.directory;
        setDirLabel(r.json.directory);
        if (r.json.fresh) appendNote("new OpenCode session → " + r.json.directory);
      }
      attachSse(chatId, state.bridgeUrl);
      clearPromptInput();
      setStatus("busy", "working");
      startAnswer("opencode");
      return true;
    } catch (err) {
      state.busy = false;
      setStatus("error", "bridge unreachable");
      appendError(String((err && err.message) || err));
      return false;
    }
  }

  async function loadConv() {
    // Working directory for this chat (bridge memory).
    try {
      const r = await bridgeGet(state.bridgeUrl, "/convs?chatId=" + encodeURIComponent(state.chatId));
      const c = r && r.ok && r.json && r.json.data && r.json.data[0];
      if (c && c.directory) {
        state.directory = c.directory;
        setDirLabel(c.directory);
      } else {
        setDirLabel("");
      }
    } catch {
      setDirLabel("");
    }
  }

  async function loadHistory() {
    try {
      const r = await bridgeGet(state.bridgeUrl, "/chatgpt/messages?chatId=" + encodeURIComponent(state.chatId));
      const items = r && r.ok && r.json && r.json.data;
      if (!Array.isArray(items) || items.length === 0) return;
      // Messages arrive newest-first; render oldest-first, text only.
      for (const m of items.slice().reverse().slice(-10)) {
        if (m.type === "user" && m.text) appendUser(m.text);
        else if (m.type === "assistant" && Array.isArray(m.content)) {
          const texts = m.content.filter((p) => p && p.type === "text" && p.text).map((p) => p.text);
          if (texts.length) {
            startAnswer("opencode");
            appendTextDelta(texts.join("\n"));
            currentAnswer = null;
          }
        }
      }
      currentAnswer = null;
    } catch {}
  }

  // ---------- boot ----------
  // installNetHook() is called at the TOP of this module, synchronously,
  // BEFORE any await — at document_start it must be in place before the
  // ChatGPT bundle executes and potentially snapshots window.fetch.
  installNetHook();
  (async function boot() {
    const cfg = await getConfig();
    state.bridgeUrl = (cfg && cfg.bridgeUrl) || "http://127.0.0.1:8787";
    bridgeModel = (cfg && cfg.model) || undefined;
    bridgeAgent = (cfg && cfg.agent) || undefined;
    const forwardTo = (cfg && cfg.forwardTo) || "opencode";
    state.relayMode = (cfg && cfg.relay) === "direct" ? "direct" : "relay";
    state.maxTurns = Math.max(1, Number(cfg && cfg.maxTurns) || 4);
    document.body || (await new Promise((res) => {
      if (document.body) res();
      else document.addEventListener("DOMContentLoaded", res, { once: true });
    }));
    renderRelayBadge();
    state.chatId = getCurrentChatId();
    ensurePanel();
    armLimitWatch(); // toggles the usage-limit pause whenever ChatGPT shows/retracts a cap notice
    // Re-resolve chat id on SPA navigation.
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        state.chatId = getCurrentChatId();
        state.busy = false;
        state.busyLabel = "";
        currentAnswer = null;
        stopRelayChain(); // new conversation = fresh loop state
        replyWatch.seen = new WeakSet();
        loadConv();
        loadHistory();
      }
    }, 1000);
    // Show working dir + history for the current conversation.
    loadConv();
    loadHistory();

    if (forwardTo !== "opencode") {
      setStatus("idle", "passthrough");
      return;
    }
    setStatus("idle", state.relayMode === "relay" ? "relay ready" : "panel-only");
    console.log("[orcstrator] page script v0.7.0 live — relay=" + state.relayMode + ", maxTurns=" + state.maxTurns + ", bridge=" + state.bridgeUrl);

    // Relay mode: ChatGPT must actually SEND the message (we never block it).
    // We passively notice the send, then watch for ChatGPT's reply.
    const noticeSend = (capturedText) => {
      if (state.relayMode !== "relay") return;
      if (isSelfSend()) return; // our own injected message — don't reset budget
      if (state.relayActive) return; // chain already running for this user msg
      state.relayActive = true;
      state.turnBudget = state.maxTurns;
      refreshStopBtn();
      if (capturedText) appendUser("you (→ ChatGPT, it plans)", String(capturedText).slice(0, 3000));
      startReplyWatch("planning reply");
    };

    // Enter (without shift) in the ProseMirror/textarea composer.
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        const ta = document.activeElement;
        const editable =
          ta &&
          (ta.tagName === "TEXTAREA" ||
            ta.getAttribute("contenteditable") === "true" ||
            (ta.closest && ta.closest('[contenteditable="true"]')));
        if (!editable) return;
        const text = String(
          ta.value !== undefined && ta.value ? ta.value : ta.innerText || ta.textContent || ""
        ).trim();
        if (!text) return;
        if (state.relayMode === "relay") {
          if (isSelfSend()) return;
          setTimeout(() => noticeSend(text), 120); // let ChatGPT handle the send first
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        handleSend(cfg);
      },
      true
    );

    // Form submit fallback.
    document.addEventListener(
      "submit",
      (e) => {
        if (state.relayMode === "relay") {
          if (!isSelfSend()) setTimeout(() => noticeSend(readPromptText()), 120);
          return false;
        }
        if (Date.now() < busyUntil || state.busy) {
          e.preventDefault();
          return false;
        }
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        handleSend(cfg);
        return false;
      },
      true
    );

    // Send-button click fallback (capture phase, before ChatGPT's handler).
    document.addEventListener(
      "click",
      (e) => {
        const t = e.target;
        const btn = t && t.closest ? t.closest("button") : null;
        if (!btn || !isSendBtn(btn)) return;
        if (btn.hasAttribute("data-orc")) return;
        if (state.relayMode === "relay") {
          if (isSelfSend()) return;
          const clickText = readPromptText();
          if (!clickText) return;
          setTimeout(() => noticeSend(clickText), 120);
          return;
        }
        const text = readPromptText();
        if (!text) return;
        if (Date.now() < busyUntil || state.busy) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        btn.setAttribute("data-orc", "routing");
        setTimeout(() => btn.removeAttribute("data-orc"), 3000);
        handleSend(cfg);
      },
      true
    );
  })();
})();
