// Cross-browser background: `browser` (Firefox/Safari standard, promises)
// with fallback to `chrome` (Chrome/older Firefox, callbacks).
//
// ALL network to the bridge happens here. Content scripts in Firefox are
// subject to page CORS/mixed-content rules, so fetch/EventSource to
// http://127.0.0.1:* from chatgpt.com only works from the background.
const ext = (typeof globalThis.browser !== "undefined" ? globalThis.browser : globalThis.chrome);

console.log("[orcstrator] background v0.7.0 live");

// ---------- one-shot relay (prompts, health, browse, models, ...) ----------
// Message-response contract differs per engine:
// - Firefox: an async response MUST be a Promise returned from the listener.
//   Chrome's `return true` + delayed sendResponse() makes Firefox log
//   "promised response from onMessage listener went out of scope" and drop
//   the response (relays then die silently). Firefox also DOES pass a
//   sendResponse argument, so its presence is NOT a valid engine test.
// - Chrome: sendResponse() + `return true` is the supported async pattern.
// Branch on the user agent, the only reliable signal.
const IS_FIREFOX = typeof navigator !== "undefined" && /Firefox\//.test(navigator.userAgent);

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const hasSendResponse = typeof sendResponse === "function";

  if (!msg || typeof msg !== "object") return hasSendResponse ? false : undefined;

  if (msg.type === "orcstrator:stream") {
    // Fire-and-forget: the stream pushes events to the tab itself.
    const { action, chatId, bridgeUrl } = msg;
    const tabId = sender && sender.tab && sender.tab.id;
    if (chatId && tabId) {
      if (action === "subscribe") startStream(chatId, bridgeUrl, tabId);
      else stopStream(chatId);
    }
    return hasSendResponse ? false : undefined;
  }

  if (msg.type === "to-bridge") {
    const p = toBridge(msg).catch((e) => ({ ok: false, error: String(e) }));
    if (IS_FIREFOX) {
      // Firefox path: the returned promise IS the response.
      return p;
    }
    // Chrome path (callback style).
    p.then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true; // keep the channel open until the promise settles
  }

  if (msg.type === "to-chatgpt") {
    // REST polling of ChatGPT's own backend API. Auth mirrors the web app
    // (decoded from its bundle): fetch GET /api/auth/session for
    // session.accessToken, then send `Authorization: Bearer` + cookies.
    const p = toChatGptApi(msg).catch((e) => ({ ok: false, error: String(e) }));
    if (IS_FIREFOX) return p;
    p.then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === "orcstrator:notify") {
    // System notification for things the user must see even with the panel
    // hidden (ChatGPT usage limits, relay dead-ends). Fire and forget.
    try {
      ext.notifications &&
        ext.notifications.create("orcstrator-" + Date.now(), {
          type: "basic",
          title: String(msg.title || "Orcstrator").slice(0, 60),
          message: String(msg.text || "").slice(0, 300) || "\u2014",
        });
    } catch (e2) {
      /* notifications unsupported — panel/chip still signal it */
    }
    return hasSendResponse ? false : undefined;
  }

  return hasSendResponse ? false : undefined;
});

let _cpToken = null; // { token, ts }

async function chatgptAccessToken() {
  if (_cpToken && Date.now() - _cpToken.ts < 4 * 60 * 1000) return _cpToken.token;
  const r = await fetch("https://chatgpt.com/api/auth/session", {
    method: "GET",
    headers: { accept: "application/json" },
    credentials: "include",
    mode: "cors",
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
    if (withAuth) headers.Authorization = "Bearer " + (await chatgptAccessToken());
    return fetch(`https://chatgpt.com/backend-api${path}`, {
      method: "GET",
      headers,
      credentials: "include",
      mode: "cors",
    });
  };
  let res;
  try {
    res = await attempt(true);
    if (res.status === 401 || res.status === 403) {
      _cpToken = null; // token expired/rotated -> refetch once
      res = await attempt(true);
    }
  } catch (e) {
    // Token acquisition or network failure; try anonymous base as fallback
    // (the app maps unauthenticated calls to /backend-anon).
    try {
      const res2 = await fetch(`https://chatgpt.com/backend-anon${path}`, {
        method: "GET",
        headers: { accept: "application/json" },
        credentials: "include",
        mode: "cors",
      });
      const text = await res2.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
      return { ok: res2.ok, status: res2.status, json };
    } catch (e2) {
      return { ok: false, error: String((e && e.message) || e) + " / " + String(e2) };
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
    body: body ? JSON.stringify(body) : undefined,
    mode: "cors",
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

// ---------- SSE stream owned by the background ----------
// Parse the bridge's text/event-stream and push each named event to the tab.
const streams = new Map(); // chatId -> { controller, tabId }

function toTab(tabId, payload) {
  try {
    const p = ext.tabs && ext.tabs.sendMessage(tabId, payload);
    if (p && typeof p.then === "function") p.catch(() => {});
  } catch {}
}

function status(tabId, chatId, status, text) {
  toTab(tabId, { type: "orcstrator:stream-status", chatId, status, text });
}

function stopStream(chatId) {
  const s = streams.get(chatId);
  if (s) {
    try {
      s.controller.abort();
    } catch {}
    streams.delete(chatId);
  }
}

async function startStream(chatId, bridgeUrl, tabId) {
  stopStream(chatId);
  const controller = new AbortController();
  streams.set(chatId, { controller, tabId });
  status(tabId, chatId, "connecting", "connecting…");
  try {
    // Pre-check health so a dead bridge yields a clear message, not a hang.
    const h = await fetch(`${bridgeUrl}/health`, { mode: "cors", signal: controller.signal });
    if (!h.ok) throw new Error(`bridge responded HTTP ${h.status}`);
    await h.json();

    const res = await fetch(`${bridgeUrl}/events/${encodeURIComponent(chatId)}`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);

    status(tabId, chatId, "live", "live");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let curEvent = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line || line.startsWith(":")) continue; // empty or heartbeat comment
        if (line.startsWith("event:")) {
          curEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (curEvent === "ping" || ext.runtime.id === undefined) {
            curEvent = "";
            continue;
          }
          toTab(tabId, { type: "orcstrator:stream-event", chatId, evType: curEvent || "", data });
          curEvent = "";
        }
      }
    }
    // Normal close: server ended the stream (or bridge restarted).
    if (streams.has(chatId)) {
      streams.delete(chatId);
      status(tabId, chatId, "retry", "stream closed — press stop or send again to reconnect");
    }
  } catch (e) {
    if (streams.has(chatId)) streams.delete(chatId);
    const aborted = controller.signal.aborted;
    if (!aborted) {
      status(tabId, chatId, "bridge-down", String((e && e.message) || e));
    }
  }
}

// Browser shutdown / add-on update: drop all streams.
ext.runtime.onSuspend && ext.runtime.onSuspend.addListener(() => {
  for (const id of Array.from(streams.keys())) stopStream(id);
});
