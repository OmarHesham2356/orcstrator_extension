// Content-script relay (isolated world): bridges page <-> background.
// Works in Chrome and Firefox: `browser` preferred, `chrome` fallback.
//
// NOTE: the SSE stream to the bridge lives in the BACKGROUND script, not here.
// In Firefox, content-script EventSource/fetch to http://127.0.0.1:* is blocked
// by page CORS/mixed-content rules; the background is the only context that can
// reach the bridge. This script just shuttles messages both ways.
(function () {
  const ext = (typeof globalThis.browser !== "undefined" ? globalThis.browser : globalThis.chrome);

  async function inject() {
    try {
      const src = ext.runtime.getURL("injected.js");
      const s = document.createElement("script");
      // CLASSIC script, not `type="module"`: module scripts are always
      // deferred to the end of parsing, which let the ChatGPT bundle run and
      // snapshot window.fetch BEFORE our network hook was installed. Classic
      // scripts injected at document_start execute before the page's own
      // bundles, so our fetch hook is in place first.
      s.type = "text/javascript";
      s.async = false; // keep in-order execution semantics
      s.src = src;
      (document.head || document.documentElement).appendChild(s);
      s.onload = () => s.remove();
    } catch (e) {
      console.warn("[orcstrator] inject failed", e);
    }
  }
  inject();

  const getCfg = () =>
    new Promise((res) => {
      try {
        const p = ext.storage.local.get("orc");
        // `browser.*` returns a promise, `chrome.*` uses a callback.
        if (p && typeof p.then === "function") {
          p.then(
            (v) => res((v && v.orc) || {}),
            () => res({})
          );
        } else {
          ext.storage.local.get("orc", (v) => res((v && v.orc) || {}));
        }
      } catch (e) {
        res({});
      }
    });

  // Events coming FROM the background stream -> the page.
  function tryAddListener() {
    if (ext.runtime.onMessage && !ext.runtime.onMessage.hasListener(onBackgroundMessage)) {
      ext.runtime.onMessage.addListener(onBackgroundMessage);
    }
  }
  function onBackgroundMessage(msg) {
    if (!msg) return;
    if (msg.type === "orcstrator:stream-event") {
      window.postMessage(
        { type: "orcstrator:event", chatId: msg.chatId, evType: msg.evType, data: msg.data },
        "*"
      );
    } else if (msg.type === "orcstrator:stream-status") {
      window.postMessage(
        { type: "orcstrator:event-status", chatId: msg.chatId, status: msg.status, text: msg.text },
        "*"
      );
    }
    // No response needed (this returns undefined; support one-off listeners via
    // the promise-style callers in background).
  }
  tryAddListener();

  // Belt-and-braces: some Firefox builds deliver runtime messages before the
  // page finished wiring; listen as soon as we know the page is ready.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tryAddListener, { once: true });
  }

  window.addEventListener("message", async (e) => {
    if (e.source !== window) return;
    if (!e.data) return;
    if (e.data.type === "orcstrator:config-request") {
      const config = await getCfg();
      window.postMessage({ type: "orcstrator:config", config }, "*");
    } else if (e.data.type === "orcstrator:subscribe") {
      relayToBackground({ type: "orcstrator:stream", action: "subscribe", chatId: e.data.chatId, bridgeUrl: e.data.bridgeUrl });
    } else if (e.data.type === "orcstrator:unsubscribe") {
      relayToBackground({ type: "orcstrator:stream", action: "unsubscribe", chatId: e.data.chatId });
    } else if (e.data.type === "orcstrator:to-bridge") {
      const msg = e.data.payload;
      const reply = (resp) =>
        window.postMessage({ type: "orcstrator:bridge-resp", id: e.data.id, resp }, "*");
      try {
        const p = ext.runtime.sendMessage(msg);
        if (p && typeof p.then === "function") {
          p.then(reply, (err) => reply({ ok: false, error: String((err && err.message) || err) }));
        } else {
          ext.runtime.sendMessage(msg, (resp) => {
            const lastErr =
              (ext.runtime && ext.runtime.lastError) ||
              (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError);
            if (lastErr) reply({ ok: false, error: String(lastErr.message) });
            else reply(resp);
          });
        }
      } catch (err) {
        reply({ ok: false, error: String(err) });
      }
    } else if (e.data.type === "orcstrator:to-chatgpt") {
      // Same one-shot relay pattern as to-bridge, but to ChatGPT's backend
      // API (background fetch includes the session cookies).
      const msg = e.data.payload;
      const reply = (resp) =>
        window.postMessage({ type: "orcstrator:bridge-resp", id: e.data.id, resp }, "*");
      try {
        const p = ext.runtime.sendMessage(msg);
        if (p && typeof p.then === "function") {
          p.then(reply, (err) => reply({ ok: false, error: String((err && err.message) || err) }));
        } else {
          ext.runtime.sendMessage(msg, (resp) => {
            const lastErr =
              (ext.runtime && ext.runtime.lastError) ||
              (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError);
            if (lastErr) reply({ ok: false, error: String(lastErr.message) });
            else reply(resp);
          });
        }
      } catch (err) {
        reply({ ok: false, error: String(err) });
      }
    } else if (e.data.type === "orcstrator:notify") {
      // Ask the background to show a system notification (panel may be hidden).
      try {
        const p = ext.runtime.sendMessage({
          type: "orcstrator:notify",
          title: e.data.title,
          text: e.data.text,
        });
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch {}
    } else if (e.data.type === "orcstrator:config-write") {
      // Merge a config patch from the page (panel dropdowns) into storage.
      (async () => {
        try {
          let cur = await new Promise((res) => {
            try {
              const p = ext.storage.local.get("orc");
              if (p && typeof p.then === "function") p.then((v) => res((v && v.orc) || {}), () => res({}));
              else ext.storage.local.get("orc", (v) => res((v && v.orc) || {}));
            } catch { res({}); }
          });
          const patch = e.data.patch || {};
          // undefined values DELETE the key (e.g. agent back to default).
          const merged = Object.assign({}, cur, patch);
          for (const k of Object.keys(patch)) if (patch[k] === undefined) delete merged[k];
          ext.storage.local.set({ orc: merged }, () => {});
        } catch {}
      })();
    }
  });

  function relayToBackground(payload) {
    try {
      const p = ext.runtime.sendMessage(payload);
      if (p && typeof p.then === "function") p.catch(() => {});
    } catch {
      ext.runtime.sendMessage(payload, () => void ext.runtime.lastError);
    }
  }
})();
