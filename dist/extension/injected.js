// dist/extension/injected.js
(function() {
  "use strict";
  let _reqId = 0;
  const _pending = /* @__PURE__ */ new Map();
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
      }, timeoutMs || 3e4);
      _pending.set(id, { resolve, timer });
      window.postMessage({ type: "orcstrator:to-bridge", id, payload: msg }, "*");
    });
  }
  const bridgePost = (bridgeUrl, path, body) => sendToBridge({ type: "to-bridge", bridgeUrl, path, method: "POST", body });
  const bridgeGet = (bridgeUrl, path) => sendToBridge({ type: "to-bridge", bridgeUrl, path, method: "GET" }, 15e3);
  const chatgptApiGet = (path) => sendToBridge({ type: "to-chatgpt", path }, 15e3);
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
      }, 3e3);
      window.postMessage({ type: "orcstrator:config-request" }, "*");
    });
  }
  function getPromptEl() {
    return document.querySelector("#prompt-textarea") || document.querySelector('[data-qa="message-input"]') || document.querySelector('textarea[placeholder*="message" i]') || document.querySelector("form textarea") || document.querySelector('[contenteditable="true"][role="textbox"]') || Array.from(document.querySelectorAll("textarea")).find((x) => x.offsetParent !== null);
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
      if (ta && ta.value !== void 0) {
        ta.focus();
        ta.value = "";
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const pm = document.querySelector("#prompt-textarea");
      if (pm) {
        pm.focus();
        document.execCommand("selectAll", false, null);
        document.execCommand("delete", false, null);
        pm.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } catch {
    }
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
    const label = ((btn.getAttribute("aria-label") || "") + " " + (btn.getAttribute("data-testid") || "") + " " + (btn.innerText || "")).toLowerCase();
    if (label.includes("stop")) return false;
    if (label.includes("send")) return true;
    if (btn.getAttribute("type") === "submit" && btn.closest("form")) return true;
    return false;
  }
  function findSendBtn() {
    return document.querySelector('[data-testid="send-button"]') || document.querySelector('button[aria-label*="send" i]') || (() => {
      const subs = Array.from(document.querySelectorAll('form button[type="submit"]')).filter(
        (b) => !b.disabled && b.getAttribute("aria-disabled") !== "true"
      );
      return subs.length ? subs[subs.length - 1] : null;
    })();
  }
  const PANEL_ID = "orcstrator-panel";
  let panel = null;
  let bodyEl = null;
  let statusEl = null;
  let dirEl = null;
  let relayBadgeEl = null;
  let currentAnswer = null;
  let state = {
    bridgeUrl: "",
    chatId: "",
    busy: false,
    busyLabel: "",
    collapsed: false,
    directory: "",
    // relay loop: ChatGPT reply -> OpenCode -> OpenCode reply -> ChatGPT ...
    relayMode: "relay",
    // "relay" | "direct"
    maxTurns: 4,
    turnBudget: 0,
    relayActive: false
    // a chain is currently running
  };
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }
  function ensurePanel() {
    if (panel && document.contains(panel)) return panel;
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = '<div class="orc-head"><span class="orc-dot"></span><span class="orc-title">Orcstrator \xB7 OpenCode</span><span class="orc-status">idle</span><button class="orc-btn orc-relay" title="toggle ChatGPT\u21C4OpenCode relay loop">relaying</button><button class="orc-btn orc-toggle" title="collapse">\u2013</button><button class="orc-btn orc-abort" title="stop OpenCode run">stop</button><button class="orc-btn orc-close" title="hide panel">\xD7</button></div><div class="orc-sub"><span class="orc-dir" title="OpenCode working directory">\u2026</span><button class="orc-btn orc-folders" title="choose working folder">folders</button></div><div class="orc-body"></div>';
    const css = document.createElement("style");
    css.textContent = "#" + PANEL_ID + "{position:fixed;top:64px;right:12px;width:380px;max-height:70vh;display:flex;flex-direction:column;z-index:2147483647;background:#0d0d12;color:#e8e8ef;border:1px solid #2c2c3a;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.5);font:13px/1.5 system-ui,sans-serif;overflow:hidden}#" + PANEL_ID + ".orc-hidden{display:none}#" + PANEL_ID + " .orc-head{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#15151d;border-bottom:1px solid #2c2c3a}#" + PANEL_ID + " .orc-dot{width:8px;height:8px;border-radius:50%;background:#555}#" + PANEL_ID + ".orc-busy .orc-dot{background:#f5b301;animation:orc-blink 1s infinite}#" + PANEL_ID + ".orc-error .orc-dot{background:#e5484d}#" + PANEL_ID + ".orc-ok .orc-dot{background:#46a758}@keyframes orc-blink{50%{opacity:.3}}#" + PANEL_ID + " .orc-title{font-weight:600;font-size:12px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#" + PANEL_ID + " .orc-status{font-size:11px;opacity:.7}#" + PANEL_ID + " .orc-btn{background:#22222e;border:1px solid #33334a;color:#fff;border-radius:6px;padding:2px 8px;cursor:pointer;font-size:12px}#" + PANEL_ID + " .orc-body{padding:10px;overflow-y:auto;max-height:calc(70vh - 41px)}#" + PANEL_ID + " .orc-collapsed .orc-body{display:none}#" + PANEL_ID + " .orc-msg{margin:0 0 10px;white-space:pre-wrap;word-break:break-word}#" + PANEL_ID + " .orc-msg.user{opacity:.75}#" + PANEL_ID + " .orc-msg .orc-meta{font-size:11px;opacity:.6;margin-bottom:2px}#" + PANEL_ID + " .orc-think{border:1px solid #2c2c3a;border-radius:8px;margin:0 0 8px}#" + PANEL_ID + " .orc-think summary{cursor:pointer;font-size:11px;opacity:.7;padding:4px 8px}#" + PANEL_ID + " .orc-think pre{margin:0;padding:4px 8px 8px;font-size:11px;opacity:.6;white-space:pre-wrap}#" + PANEL_ID + " .orc-err{color:#ff9a9e}#" + PANEL_ID + " .orc-tools{font-size:11px;opacity:.65;margin:0 0 8px}#" + PANEL_ID + " .orc-sub{display:flex;align-items:center;gap:8px;padding:5px 10px;background:#101018;border-bottom:1px solid #2c2c3a;font-size:11px}#" + PANEL_ID + " .orc-dir{flex:1;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#" + PANEL_ID + " .orc-note{font-size:11px;opacity:.6;margin:0 0 8px}#orcstrator-folders{position:fixed;z-index:2147483647;top:120px;right:404px;width:340px;max-height:60vh;display:flex;flex-direction:column;background:#0d0d12;color:#e8e8ef;border:1px solid #2c2c3a;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.5);font:13px/1.5 system-ui,sans-serif;overflow:hidden}#orcstrator-folders.orc-hidden{display:none}#orcstrator-folders .orc-fhead{padding:8px 10px;background:#15151d;border-bottom:1px solid #2c2c3a;font-weight:600;font-size:12px}#orcstrator-folders .orc-crumb{padding:6px 10px;font-size:11px;opacity:.8;word-break:break-all;border-bottom:1px solid #2c2c3a}#orcstrator-folders .orc-crumb button{background:none;border:none;color:#8ab4ff;cursor:pointer;font-size:11px;padding:0 4px}#orcstrator-folders .orc-flist{overflow-y:auto;padding:4px}#orcstrator-folders .orc-fitem{display:block;width:100%;text-align:left;background:none;border:none;color:#e8e8ef;padding:5px 8px;border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#orcstrator-folders .orc-fitem.dir:hover{background:#1d1d28}#orcstrator-folders .orc-fitem.file{opacity:.4;cursor:default}#orcstrator-folders .orc-ffoot{display:flex;gap:8px;padding:8px 10px;border-top:1px solid #2c2c3a}#orcstrator-folders .orc-ffoot .orc-btn{flex:1;padding:6px;cursor:pointer}";
    document.documentElement.appendChild(css);
    document.documentElement.appendChild(panel);
    bodyEl = panel.querySelector(".orc-body");
    statusEl = panel.querySelector(".orc-status");
    dirEl = panel.querySelector(".orc-dir");
    relayBadgeEl = panel.querySelector(".orc-relay");
    relayBadgeEl.onclick = () => {
      setRelay(state.relayMode === "relay" ? "direct" : "relay");
      appendNote(
        state.relayMode === "relay" ? "relay ON: ChatGPT \u21C4 OpenCode loop active \u2014 messages flow between them" : "relay OFF: your prompt goes straight to OpenCode, answer shows only here"
      );
    };
    renderRelayBadge();
    panel.querySelector(".orc-close").onclick = () => panel.classList.add("orc-hidden");
    panel.querySelector(".orc-toggle").onclick = (ev) => {
      state.collapsed = !state.collapsed;
      panel.classList.toggle("orc-collapsed", state.collapsed);
      ev.target.textContent = state.collapsed ? "+" : "\u2013";
    };
    panel.querySelector(".orc-abort").onclick = async () => {
      try {
        await bridgePost(state.bridgeUrl, "/chatgpt/abort", { chatId: state.chatId });
      } catch (e) {
      }
      stopRelayChain();
      setStatus("idle", "aborted");
    };
    panel.querySelector(".orc-folders").onclick = () => openFolders(state.directory || null);
    return panel;
  }
  function renderRelayBadge() {
    if (!relayBadgeEl) return;
    relayBadgeEl.textContent = state.relayMode === "relay" ? "relaying \u27F3" : "panel-only";
    relayBadgeEl.title = state.relayMode === "relay" ? "Relay loop is ON: ChatGPT's replies are sent to OpenCode and OpenCode answers back into the chat. Click for panel-only." : "Panel-only mode: prompts go to OpenCode, answers show here. Click to enable the ChatGPT\u21C4OpenCode loop.";
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
    ensurePanel();
    panel.classList.remove("orc-hidden");
    const d = document.createElement("div");
    d.className = "orc-note";
    d.textContent = text;
    bodyEl.appendChild(d);
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }
  let foldersEl = null;
  let browseDir = "";
  function ensureFolders() {
    if (foldersEl && document.contains(foldersEl)) return foldersEl;
    foldersEl = document.createElement("div");
    foldersEl.id = "orcstrator-folders";
    foldersEl.className = "orc-hidden";
    foldersEl.innerHTML = '<div class="orc-fhead">Working folder \u2014 where OpenCode writes</div><div class="orc-crumb"></div><div class="orc-flist"></div><div class="orc-ffoot"><button class="orc-btn orc-use">Use this folder</button><button class="orc-btn orc-fclose">Close</button></div>';
    document.documentElement.appendChild(foldersEl);
    foldersEl.querySelector(".orc-fclose").onclick = () => foldersEl.classList.add("orc-hidden");
    foldersEl.querySelector(".orc-use").onclick = () => {
      state.directory = browseDir;
      setDirLabel(browseDir);
      foldersEl.classList.add("orc-hidden");
      appendNote("working folder set to " + browseDir + " \u2014 next message starts a session there");
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
    list.innerHTML = "<div class='orc-note'>loading\u2026</div>";
    let j = null;
    try {
      const r = await bridgeGet(state.bridgeUrl, "/browse?dir=" + encodeURIComponent(dir));
      j = r && r.ok ? r.json : null;
    } catch {
    }
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
    mk("\u2191", j.parent);
    mk("home", j.home);
    mk("default", j.defaultDir);
    list.innerHTML = "";
    for (const e of j.entries || []) {
      const b = document.createElement("button");
      b.className = "orc-fitem " + (e.isDir ? "dir" : "file");
      b.textContent = (e.isDir ? "\u{1F4C1} " : "\u{1F4C4} ") + e.name;
      if (e.isDir) b.onclick = () => browse(e.path);
      list.appendChild(b);
    }
    if ((j.entries || []).length === 0) list.innerHTML = "<div class='orc-note'>(empty)</div>";
  }
  function setStatus(kind, text) {
    ensurePanel();
    panel.classList.remove("orc-hidden", "orc-busy", "orc-error", "orc-ok");
    if (kind === "busy") panel.classList.add("orc-busy");
    else if (kind === "error") panel.classList.add("orc-error");
    else if (kind === "ok") panel.classList.add("orc-ok");
    if (statusEl) statusEl.textContent = text || kind;
  }
  function appendUser(text, meta) {
    ensurePanel();
    panel.classList.remove("orc-hidden");
    const d = document.createElement("div");
    d.className = "orc-msg user";
    d.innerHTML = '<div class="orc-meta">' + esc(meta || "you \u2192 OpenCode") + "</div><div>" + esc(text).slice(0, 4e3) + "</div>";
    bodyEl.appendChild(d);
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }
  function startAnswer(meta) {
    ensurePanel();
    panel.classList.remove("orc-hidden");
    const wrap = document.createElement("div");
    wrap.className = "orc-msg assistant";
    wrap.innerHTML = '<div class="orc-meta">' + esc(meta || "opencode") + '</div><details class="orc-think" style="display:none"><summary>thinking</summary><pre></pre></details><div class="orc-text"></div><div class="orc-tools"></div>';
    bodyEl.appendChild(wrap);
    bodyEl.scrollTop = bodyEl.scrollHeight;
    currentAnswer = {
      wrap,
      textEl: wrap.querySelector(".orc-text"),
      thinkEl: wrap.querySelector(".orc-think"),
      thinkBody: wrap.querySelector(".orc-think pre"),
      toolsEl: wrap.querySelector(".orc-tools"),
      text: "",
      thinking: ""
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
    currentAnswer.thinkBody.textContent = currentAnswer.thinking.slice(-6e3);
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }
  function appendToolNote(note) {
    if (!currentAnswer) startAnswer("opencode");
    const d = document.createElement("div");
    d.textContent = note;
    currentAnswer.toolsEl.appendChild(d);
  }
  function appendError(msg) {
    ensurePanel();
    panel.classList.remove("orc-hidden");
    const d = document.createElement("div");
    d.className = "orc-msg orc-err";
    d.textContent = "error: " + msg;
    bodyEl.appendChild(d);
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.type === "orcstrator:event" && e.data.chatId === state.chatId) {
      let payload = null;
      try {
        payload = JSON.parse(e.data.data);
      } catch {
        return;
      }
      routeEvent(e.data.evType || payload && payload.type || "", payload);
    } else if (e.data.type === "orcstrator:event-status" && e.data.chatId === state.chatId) {
      handleStreamStatus(e.data.status, e.data.text);
    }
  });
  function attachSse(chatId, bridgeUrl) {
    window.postMessage({ type: "orcstrator:subscribe", chatId, bridgeUrl }, "*");
  }
  const netHook = { installed: false, last: null, url: "", loggedNonStream: false };
  function installNetHook() {
    if (netHook.installed) return;
    netHook.installed = true;
    const origFetch = window.fetch;
    if (typeof origFetch !== "function") return;
    window.fetch = function(input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : input && input.url || "";
        if (isCandidateUrl(url)) watchStream(p, url);
      } catch {
      }
      return p;
    };
    console.log("[orcstrator] net hook installed");
  }
  function isCandidateUrl(url) {
    if (!url) return false;
    const s = String(url);
    if (/^https?:\/\/(127\.|localhost)/i.test(s)) return false;
    if (/^https?:\/\//i.test(s)) {
      return /(^|\.)chatgpt\.com|(^|\.)openai\.com|oaistatic\.com/i.test(s);
    }
    return true;
  }
  function watchStream(p, url) {
    const started = Date.now();
    const candidate = /conversation|chat|completions|companion/i.test(String(url));
    p.then(async (res) => {
      try {
        if (!res || !res.body) return;
        const ct = res.headers && res.headers.get("content-type") || "";
        if (!/event-stream|stream|text\/plain/i.test(ct)) {
          if (candidate && replyWatch.active && !netHook.loggedNonStream) {
            netHook.loggedNonStream = true;
            console.log("[orcstrator] net hook skips non-stream response " + ct + " from \u2026" + String(url).slice(-70));
          }
          return;
        }
        netHook.url = url;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        const merge = makeMerger();
        for (; ; ) {
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
            try {
              ev = JSON.parse(data);
            } catch {
              continue;
            }
            merge(ev);
          }
        }
        hookFinish(started, url, merge.value());
      } catch {
      }
    }).catch(() => {
    });
  }
  function makeMerger() {
    let id = null;
    let acc = "";
    const segs = [];
    const merge = function(ev) {
      const piece = extractAssistantPiece(ev);
      if (!piece) return;
      const mid = ev && ev.message && ev.message.id || null;
      if (mid && id && mid !== id) {
        if (acc) segs.push(acc);
        acc = "";
        id = mid;
      } else if (mid && !id) {
        id = mid;
      }
      if (!acc) {
        acc = piece;
        return;
      }
      if (acc === piece) return;
      if (piece.startsWith(acc) || acc.startsWith(piece)) {
        acc = piece;
        return;
      }
      if (acc.endsWith(piece)) return;
      acc += piece;
    };
    merge.value = () => (segs.length ? segs.join("\n\n") + (acc ? "\n\n" + acc : "") : acc).trim();
    return merge;
  }
  function extractAssistantPiece(ev) {
    if (!ev || typeof ev !== "object") return "";
    const m = ev.message || ev.v && ev.v.message || null;
    if (m && typeof m === "object") {
      const author = m.author || {};
      if (author.role !== "assistant") return "";
      if (m.recipient != null && m.recipient !== "all") return "";
      if (m.channel != null && m.channel !== "final") return "";
      const c = m.content || {};
      const ct = String(c.content_type || c.contentType || "text").toLowerCase();
      if (ct && ct !== "text") return "";
      const parts = Array.isArray(c.parts) ? c.parts.filter((x) => typeof x === "string") : null;
      if (!parts) return "";
      return parts.join("");
    }
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
        console.log("[orcstrator] net hook: stream from \u2026" + String(url).slice(-80) + " completed but no assistant-matched chunks (wrong format?)");
      }
      return;
    }
    netHook.last = { text, at: Date.now(), consumed: false };
    if (replyWatch.active) {
      if (started >= replyWatch.startedAt - 1500) {
        console.log("[orcstrator] net hook captured ChatGPT reply (" + text.length + " chars) via " + String(url).slice(-80));
        consumeReply(text, "net hook");
      }
    }
  }
  function consumeReply(text, via) {
    if (!replyWatch.active) return;
    if (netHook.last) netHook.last.consumed = true;
    stopReplyWatch();
    console.log("[orcstrator] ChatGPT reply captured via " + via + ", " + text.length + " chars");
    onChatGptReply(text);
  }
  const replyWatch = {
    active: false,
    gen: 0,
    // generation counter; stale observer/poller ticks are ignored
    observer: null,
    poller: null,
    fallback: false,
    // true when ChatGPT's role attributes are unavailable
    anchorPos: -1,
    // primary mode: DOM index of the user message we await a reply for
    seen: /* @__PURE__ */ new WeakSet(),
    // fallback mode: assistant elements already relayed
    lastText: "",
    stableSince: 0,
    streamingSince: 0,
    startedAt: 0,
    // arm time; net-hook catch-up window = startedAt-1500ms
    deadline: 0
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
  function assistantRealText(el) {
    if (!el) return "";
    const md = el.querySelector(".markdown");
    return String(md && md.innerText || "").trim();
  }
  function chatIsStreaming() {
    const stop = document.querySelector('[data-testid="stop-button"]') || document.querySelector('button[aria-label="Stop streaming"]') || Array.from(document.querySelectorAll("button[aria-label]")).find(
      (b) => /stop (generat|stream|respond)/i.test(b.getAttribute("aria-label") || "")
    );
    return !!stop;
  }
  function startReplyWatch(reason) {
    if (state.relayMode !== "relay") return;
    if (replyWatch.active) return;
    const gen = ++replyWatch.gen;
    replyWatch.active = true;
    replyWatch.startedAt = Date.now();
    replyWatch.deadline = Date.now() + 24e4;
    replyWatch.lastText = "";
    replyWatch.stableSince = 0;
    replyWatch.streamingSince = 0;
    replyWatch.recovered = false;
    netHook.loggedNonStream = false;
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
      replyWatch.fallback = false;
      let idx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (roleOf(msgs[i]) === "user") {
          idx = i;
          break;
        }
      }
      if (idx < 0) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (roleOf(msgs[i]) === "assistant") {
            idx = i;
            break;
          }
        }
      }
      if (idx >= 0) {
        replyWatch.anchorPos = idx;
        console.log("[orcstrator] watch started (" + reason + "), mode=anchor, anchor=" + idx + "/" + msgs.length);
      } else {
        replyWatch.fallback = true;
        replyWatch.anchorPos = -1;
        replyWatch.seen = /* @__PURE__ */ new WeakSet();
        console.log("[orcstrator] watch started (" + reason + "), mode=fallback (no anchors in DOM)");
      }
    } else {
      replyWatch.fallback = true;
      replyWatch.anchorPos = -1;
      replyWatch.seen = /* @__PURE__ */ new WeakSet();
      for (const el of getAssistantEls()) {
        if (assistantRealText(el)) replyWatch.seen.add(el);
      }
      const census = {
        role: document.querySelectorAll("[data-message-author-role]").length,
        roleA: document.querySelectorAll('[data-message-author-role="assistant"]').length,
        article: document.querySelectorAll("article").length,
        md: document.querySelectorAll(".markdown").length,
        msgid: document.querySelectorAll("[data-message-id]").length,
        testid: document.querySelectorAll("[data-testid]").length
      };
      console.log("[orcstrator] watch started (" + reason + "), mode=fallback");
      console.log("[orcstrator] DOM census:", JSON.stringify(census));
    }
    netHook.active = true;
    startApiPoller(gen);
    setStatus("busy", "waiting for ChatGPT" + (reason ? " (" + reason + ")" : ""));
    replyWatch.observer = new MutationObserver(() => checkReply(gen));
    replyWatch.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    replyWatch.poller = setInterval(() => checkReply(gen), 600);
  }
  const apiPoller = { timer: null, quietCount: 0, warned: false };
  function startApiPoller(gen) {
    stopApiPoller();
    apiPoller.quietCount = 0;
    apiPoller.warned = false;
    let failures = 0;
    const tick = async () => {
      if (!replyWatch.active || replyWatch.gen !== gen) return;
      const convId = state.chatId;
      if (!convId || /^(local|unknown)/.test(convId)) return;
      try {
        const r = await chatgptApiGet("/conversation/" + encodeURIComponent(convId));
        if (!replyWatch.active || replyWatch.gen !== gen) return;
        if (!r.ok) {
          failures += 1;
          if (failures === 3 && !apiPoller.warned) {
            apiPoller.warned = true;
            console.warn("[orcstrator] api poller failing (HTTP " + r.status + ") \u2014 net hook / DOM watch still active");
          }
          return;
        }
        failures = 0;
        const parsed = parseConversationReply(r.json, replyWatch.startedAt);
        if (!parsed) return;
        if (parsed.inProgressLater) return;
        if (parsed.finished && parsed.finished.text) {
          console.log("[orcstrator] api poller sees finished reply from " + new Date(parsed.finished.t * 1e3).toISOString());
          consumeReply(parsed.finished.text, "api poll");
        }
      } catch (e) {
        failures += 1;
        if (failures === 3 && !apiPoller.warned) {
          apiPoller.warned = true;
          console.warn("[orcstrator] api poller error:", String(e && e.message || e));
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
  function parseConversationReply(json, armMs) {
    if (!json || typeof json !== "object") return null;
    const root = json.data && json.data.mapping ? json.data : json;
    const mapping = root.mapping;
    if (!mapping) return null;
    const armSec = armMs / 1e3;
    let finished = null;
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
      if (status === "in_progress" || !status && !text) {
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
      } catch {
      }
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
    if (!replyWatch.active || replyWatch.gen !== gen) return;
    if (Date.now() > replyWatch.deadline) {
      console.warn("[orcstrator] watch timed out");
      stopReplyWatch();
      finishRelay("timed out waiting for ChatGPT");
      return;
    }
    let cand = null;
    if (!replyWatch.fallback) {
      const msgs = getMsgEls();
      for (let i = replyWatch.anchorPos + 1; i < msgs.length; i++) {
        if (roleOf(msgs[i]) === "assistant") {
          cand = msgs[i];
          break;
        }
      }
      if (!cand) return;
      if (!assistantRealText(cand)) return;
    } else {
      const msgs = getMsgEls();
      if (msgs.length > 0 && !replyWatch.recovered) {
        let idx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (roleOf(msgs[i]) === "user") {
            idx = i;
            break;
          }
        }
        if (idx < 0) {
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (roleOf(msgs[i]) === "assistant") {
              idx = i;
              break;
            }
          }
        }
        if (idx >= 0) {
          replyWatch.fallback = false;
          replyWatch.anchorPos = idx;
          replyWatch.recovered = true;
          console.log("[orcstrator] watch recovered into anchor mode, anchor=" + idx + "/" + msgs.length);
        }
      }
      const els = getAssistantEls();
      for (let i = els.length - 1; i >= 0; i--) {
        const el = els[i];
        if (replyWatch.seen.has(el)) continue;
        if (assistantRealText(el)) {
          cand = el;
          break;
        }
      }
      if (!cand) return;
    }
    const text = assistantText(cand);
    if (!text) return;
    const streaming = chatIsStreaming();
    if (streaming) {
      if (!replyWatch.streamingSince) replyWatch.streamingSince = Date.now();
      if (Date.now() - replyWatch.streamingSince < 9e4) {
        replyWatch.stableSince = 0;
        replyWatch.lastText = text;
        return;
      }
      console.warn("[orcstrator] stop-button visible 90s+ \u2014 proceeding on text stability");
    } else {
      replyWatch.streamingSince = 0;
    }
    if (text !== replyWatch.lastText) {
      replyWatch.lastText = text;
      replyWatch.stableSince = Date.now();
      return;
    }
    if (!replyWatch.stableSince || Date.now() - replyWatch.stableSince < 1200) return;
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
    appendNote("ChatGPT \u2192 OpenCode \xB7 " + text.replace(/\s+/g, " ").slice(0, 140));
    relayToOpenCode(text);
  }
  async function relayToOpenCode(text) {
    state.busy = true;
    setStatus("busy", "OpenCode thinking\u2026");
    state.chatId = getCurrentChatId();
    console.log("[orcstrator] relaying to OpenCode, chatId=" + state.chatId);
    try {
      const r = await bridgePost(state.bridgeUrl, "/chatgpt/prompt", {
        chatId: state.chatId,
        text,
        model: bridgeModel,
        agent: bridgeAgent,
        directory: state.directory || void 0
      });
      if (!r || !r.ok) {
        const err = r && (r.json && r.json.error || r.error) || "bridge error";
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
      startAnswer("opencode");
    } catch (err) {
      console.warn("[orcstrator] relay error:", err);
      setStatus("error", "bridge unreachable");
      appendError(String(err && err.message || err));
      stopRelayChain();
    }
  }
  function onOpenCodeFinished() {
    const answer = currentAnswer && currentAnswer.text ? currentAnswer.text : "";
    if (state.relayMode !== "relay") return;
    console.log("[orcstrator] OpenCode finished, answer " + answer.length + " chars, turns left " + state.turnBudget);
    if (!answer.trim()) {
      appendNote("relay: OpenCode produced no text to send back");
      return finishRelay("no answer");
    }
    if (state.turnBudget <= 0) {
      appendNote("relay: turn budget used up \u2014 OpenCode's last reply stays in the panel");
      return finishRelay("");
    }
    appendNote("OpenCode \u2192 ChatGPT \xB7 " + answer.replace(/\s+/g, " ").slice(0, 140));
    injectOpenCodeReply("[OpenCode] " + answer).then((sent) => {
      if (sent) {
        console.log("[orcstrator] OpenCode reply injected into ChatGPT");
        startReplyWatch("OpenCode reply sent");
      } else {
        console.warn("[orcstrator] composer inject failed");
        setStatus("error", "inject failed");
        appendError("could not type into the ChatGPT composer \u2014 inject manually or switch to panel-only");
        finishRelay("compose failed");
      }
    });
  }
  async function injectOpenCodeReply(text) {
    const ta = document.querySelector("#prompt-textarea") || document.querySelector('[contenteditable="true"][role="textbox"]') || document.querySelector("form textarea");
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
    selfInjecting = Date.now() + 1500;
    send.click();
    try {
      await new Promise((r2) => setTimeout(r2, 2e3));
      if ((readPromptText() || "").includes("[OpenCode]")) {
        console.warn("[orcstrator] auto-send click did not register \u2014 retrying with keyboard Enter");
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
              cancelable: true
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
    if (reason) setStatus("idle", "relay stopped");
  }
  let bridgeModel = void 0;
  let bridgeAgent = void 0;
  function handleStreamStatus(status, text) {
    if (status === "live") {
      if (state.busy) setStatus("busy", state.busyLabel || "working");
      else setStatus("ok", "live");
    } else if (status === "connecting" || status === "retry") {
      setStatus("busy", text || "connecting\u2026");
    } else if (status === "bridge-down") {
      setStatus("error", "stream error");
      appendError(
        (text || "bridge unreachable") + " \u2014 start the bridge (tsx bridge/src/server.ts), check the popup Bridge URL, then send again."
      );
    } else {
      setStatus("error", "stream error");
      appendError(text || "stream error");
    }
  }
  function routeEvent(type, payload) {
    const d = payload && payload.data || {};
    switch (type) {
      case "session.text.delta":
        if (typeof d.delta === "string") appendTextDelta(d.delta);
        else if (typeof payload.delta === "string") appendTextDelta(payload.delta);
        break;
      case "session.reasoning.delta":
        if (typeof d.delta === "string") appendThinkDelta(d.delta);
        break;
      case "session.step.started":
        state.busyLabel = "working" + (d.model && d.model.id ? " \xB7 " + d.model.id : "");
        setStatus("busy", state.busyLabel);
        if (d.assistantMessageID) startAnswer("opencode \xB7 " + (d.model && d.model.id || (d.agent || "")));
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
      case "session.step.ended":
        setStatus("ok", "done");
        break;
      case "session.step.failed":
      case "session.execution.failed": {
        state.busy = false;
        state.busyLabel = "";
        const msg = d.error && (d.error.message || d.error.type) || payload.error && (payload.error.message || payload.error.type) || "run failed";
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
        break;
    }
  }
  let busyUntil = 0;
  let selfInjecting = 0;
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
        directory: state.directory || void 0
      });
      if (!r || !r.ok) {
        state.busy = false;
        const err = r && (r.json && r.json.error || r.error) || "bridge error";
        setStatus("error", "bridge error");
        appendError(String(err));
        return false;
      }
      if (r.json && r.json.directory) {
        state.directory = r.json.directory;
        setDirLabel(r.json.directory);
        if (r.json.fresh) appendNote("new OpenCode session \u2192 " + r.json.directory);
      }
      attachSse(chatId, state.bridgeUrl);
      clearPromptInput();
      setStatus("busy", "working");
      startAnswer("opencode");
      return true;
    } catch (err) {
      state.busy = false;
      setStatus("error", "bridge unreachable");
      appendError(String(err && err.message || err));
      return false;
    }
  }
  async function loadConv() {
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
    } catch {
    }
  }
  installNetHook();
  (async function boot() {
    const cfg = await getConfig();
    state.bridgeUrl = cfg && cfg.bridgeUrl || "http://127.0.0.1:8787";
    bridgeModel = cfg && cfg.model || void 0;
    bridgeAgent = cfg && cfg.agent || void 0;
    const forwardTo = cfg && cfg.forwardTo || "opencode";
    state.relayMode = (cfg && cfg.relay) === "direct" ? "direct" : "relay";
    state.maxTurns = Math.max(1, Number(cfg && cfg.maxTurns) || 4);
    document.body || await new Promise((res) => {
      if (document.body) res();
      else document.addEventListener("DOMContentLoaded", res, { once: true });
    });
    renderRelayBadge();
    state.chatId = getCurrentChatId();
    ensurePanel();
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        state.chatId = getCurrentChatId();
        state.busy = false;
        state.busyLabel = "";
        currentAnswer = null;
        stopRelayChain();
        replyWatch.seen = /* @__PURE__ */ new WeakSet();
        loadConv();
        loadHistory();
      }
    }, 1e3);
    loadConv();
    loadHistory();
    if (forwardTo !== "opencode") {
      setStatus("idle", "passthrough");
      return;
    }
    setStatus("idle", state.relayMode === "relay" ? "relay ready" : "panel-only");
    console.log("[orcstrator] page script v0.4.9 live \u2014 relay=" + state.relayMode + ", maxTurns=" + state.maxTurns + ", bridge=" + state.bridgeUrl);
    const noticeSend = (capturedText) => {
      if (state.relayMode !== "relay") return;
      if (isSelfSend()) return;
      if (state.relayActive) return;
      state.relayActive = true;
      state.turnBudget = state.maxTurns;
      if (capturedText) appendUser("you (\u2192 ChatGPT, it plans)", String(capturedText).slice(0, 3e3));
      startReplyWatch("planning reply");
    };
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        const ta = document.activeElement;
        const editable = ta && (ta.tagName === "TEXTAREA" || ta.getAttribute("contenteditable") === "true" || ta.closest && ta.closest('[contenteditable="true"]'));
        if (!editable) return;
        const text = String(
          ta.value !== void 0 && ta.value ? ta.value : ta.innerText || ta.textContent || ""
        ).trim();
        if (!text) return;
        if (state.relayMode === "relay") {
          if (isSelfSend()) return;
          setTimeout(() => noticeSend(text), 120);
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        handleSend(cfg);
      },
      true
    );
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
        setTimeout(() => btn.removeAttribute("data-orc"), 3e3);
        handleSend(cfg);
      },
      true
    );
  })();
})();
//# sourceMappingURL=injected.js.map
