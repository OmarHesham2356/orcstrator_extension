// dist/extension-firefox/background.js
var ext = typeof globalThis.browser !== "undefined" ? globalThis.browser : globalThis.chrome;
console.log("[orcstrator] background v0.4.8 live");
var IS_FIREFOX = typeof navigator !== "undefined" && /Firefox\//.test(navigator.userAgent);
ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const hasSendResponse = typeof sendResponse === "function";
  if (!msg || typeof msg !== "object") return hasSendResponse ? false : void 0;
  if (msg.type === "orcstrator:stream") {
    const { action, chatId, bridgeUrl } = msg;
    const tabId = sender && sender.tab && sender.tab.id;
    if (chatId && tabId) {
      if (action === "subscribe") startStream(chatId, bridgeUrl, tabId);
      else stopStream(chatId);
    }
    return hasSendResponse ? false : void 0;
  }
  if (msg.type === "to-bridge") {
    const p = toBridge(msg).catch((e) => ({ ok: false, error: String(e) }));
    if (IS_FIREFOX) {
      return p;
    }
    p.then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "to-chatgpt") {
    const p = toChatGptApi(msg).catch((e) => ({ ok: false, error: String(e) }));
    if (IS_FIREFOX) return p;
    p.then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  return hasSendResponse ? false : void 0;
});
var _cpToken = null;
async function chatgptAccessToken() {
  if (_cpToken && Date.now() - _cpToken.ts < 4 * 60 * 1e3) return _cpToken.token;
  const r = await fetch("https://chatgpt.com/api/auth/session", {
    method: "GET",
    headers: { accept: "application/json" },
    credentials: "include",
    mode: "cors"
  });
  if (!r.ok) throw new Error("auth session HTTP " + r.status);
  const j = await r.json();
  const token = j && j.accessToken;
  if (!token) throw new Error("no accessToken in session (logged out?)");
  _cpToken = { token, ts: Date.now() };
  return token;
}
async function toChatGptApi(msg) {
  const { path } = msg;
  const attempt = async (withAuth) => {
    const headers = { accept: "application/json" };
    if (withAuth) headers.Authorization = "Bearer " + await chatgptAccessToken();
    return fetch(`https://chatgpt.com/backend-api${path}`, {
      method: "GET",
      headers,
      credentials: "include",
      mode: "cors"
    });
  };
  let res;
  try {
    res = await attempt(true);
    if (res.status === 401 || res.status === 403) {
      _cpToken = null;
      res = await attempt(true);
    }
  } catch (e) {
    try {
      const res2 = await fetch(`https://chatgpt.com/backend-anon${path}`, {
        method: "GET",
        headers: { accept: "application/json" },
        credentials: "include",
        mode: "cors"
      });
      const text2 = await res2.text();
      let json2;
      try {
        json2 = JSON.parse(text2);
      } catch {
        json2 = { raw: text2.slice(0, 300) };
      }
      return { ok: res2.ok, status: res2.status, json: json2 };
    } catch (e2) {
      return { ok: false, error: String(e && e.message || e) + " / " + String(e2) };
    }
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { ok: res.ok, status: res.status, json };
}
async function toBridge(msg) {
  const { bridgeUrl, path, method = "POST", body } = msg;
  const res = await fetch(`${bridgeUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : void 0,
    mode: "cors"
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, json };
}
var streams = /* @__PURE__ */ new Map();
function toTab(tabId, payload) {
  try {
    const p = ext.tabs && ext.tabs.sendMessage(tabId, payload);
    if (p && typeof p.then === "function") p.catch(() => {
    });
  } catch {
  }
}
function status(tabId, chatId, status2, text) {
  toTab(tabId, { type: "orcstrator:stream-status", chatId, status: status2, text });
}
function stopStream(chatId) {
  const s = streams.get(chatId);
  if (s) {
    try {
      s.controller.abort();
    } catch {
    }
    streams.delete(chatId);
  }
}
async function startStream(chatId, bridgeUrl, tabId) {
  stopStream(chatId);
  const controller = new AbortController();
  streams.set(chatId, { controller, tabId });
  status(tabId, chatId, "connecting", "connecting\u2026");
  try {
    const h = await fetch(`${bridgeUrl}/health`, { mode: "cors", signal: controller.signal });
    if (!h.ok) throw new Error(`bridge responded HTTP ${h.status}`);
    await h.json();
    const res = await fetch(`${bridgeUrl}/events/${encodeURIComponent(chatId)}`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal
    });
    if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);
    status(tabId, chatId, "live", "live");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let curEvent = "";
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line || line.startsWith(":")) continue;
        if (line.startsWith("event:")) {
          curEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (curEvent === "ping" || ext.runtime.id === void 0) {
            curEvent = "";
            continue;
          }
          toTab(tabId, { type: "orcstrator:stream-event", chatId, evType: curEvent || "", data });
          curEvent = "";
        }
      }
    }
    if (streams.has(chatId)) {
      streams.delete(chatId);
      status(tabId, chatId, "retry", "stream closed \u2014 press stop or send again to reconnect");
    }
  } catch (e) {
    if (streams.has(chatId)) streams.delete(chatId);
    const aborted = controller.signal.aborted;
    if (!aborted) {
      status(tabId, chatId, "bridge-down", String(e && e.message || e));
    }
  }
}
ext.runtime.onSuspend && ext.runtime.onSuspend.addListener(() => {
  for (const id of Array.from(streams.keys())) stopStream(id);
});
//# sourceMappingURL=background.js.map
