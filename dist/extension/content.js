// dist/extension/content.js
(function() {
  const ext = typeof globalThis.browser !== "undefined" ? globalThis.browser : globalThis.chrome;
  async function inject() {
    try {
      const src = ext.runtime.getURL("injected.js");
      const s = document.createElement("script");
      s.type = "text/javascript";
      s.async = false;
      s.src = src;
      (document.head || document.documentElement).appendChild(s);
      s.onload = () => s.remove();
    } catch (e) {
      console.warn("[orcstrator] inject failed", e);
    }
  }
  inject();
  const getCfg = () => new Promise((res) => {
    try {
      const p = ext.storage.local.get("orc");
      if (p && typeof p.then === "function") {
        p.then(
          (v) => res(v && v.orc || {}),
          () => res({})
        );
      } else {
        ext.storage.local.get("orc", (v) => res(v && v.orc || {}));
      }
    } catch (e) {
      res({});
    }
  });
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
  }
  tryAddListener();
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
      const reply = (resp) => window.postMessage({ type: "orcstrator:bridge-resp", id: e.data.id, resp }, "*");
      try {
        const p = ext.runtime.sendMessage(msg);
        if (p && typeof p.then === "function") {
          p.then(reply, (err) => reply({ ok: false, error: String(err && err.message || err) }));
        } else {
          ext.runtime.sendMessage(msg, (resp) => {
            const lastErr = ext.runtime && ext.runtime.lastError || typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError;
            if (lastErr) reply({ ok: false, error: String(lastErr.message) });
            else reply(resp);
          });
        }
      } catch (err) {
        reply({ ok: false, error: String(err) });
      }
    } else if (e.data.type === "orcstrator:to-chatgpt") {
      const msg = e.data.payload;
      const reply = (resp) => window.postMessage({ type: "orcstrator:bridge-resp", id: e.data.id, resp }, "*");
      try {
        const p = ext.runtime.sendMessage(msg);
        if (p && typeof p.then === "function") {
          p.then(reply, (err) => reply({ ok: false, error: String(err && err.message || err) }));
        } else {
          ext.runtime.sendMessage(msg, (resp) => {
            const lastErr = ext.runtime && ext.runtime.lastError || typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError;
            if (lastErr) reply({ ok: false, error: String(lastErr.message) });
            else reply(resp);
          });
        }
      } catch (err) {
        reply({ ok: false, error: String(err) });
      }
    } else if (e.data.type === "orcstrator:notify") {
      try {
        const p = ext.runtime.sendMessage({
          type: "orcstrator:notify",
          title: e.data.title,
          text: e.data.text
        });
        if (p && typeof p.catch === "function") p.catch(() => {
        });
      } catch {
      }
    } else if (e.data.type === "orcstrator:config-write") {
      (async () => {
        try {
          let cur = await new Promise((res) => {
            try {
              const p = ext.storage.local.get("orc");
              if (p && typeof p.then === "function") p.then((v) => res(v && v.orc || {}), () => res({}));
              else ext.storage.local.get("orc", (v) => res(v && v.orc || {}));
            } catch {
              res({});
            }
          });
          const patch = e.data.patch || {};
          const merged = Object.assign({}, cur, patch);
          for (const k of Object.keys(patch)) if (patch[k] === void 0) delete merged[k];
          ext.storage.local.set({ orc: merged }, () => {
          });
        } catch {
        }
      })();
    }
  });
  function relayToBackground(payload) {
    try {
      const p = ext.runtime.sendMessage(payload);
      if (p && typeof p.then === "function") p.catch(() => {
      });
    } catch {
      ext.runtime.sendMessage(payload, () => void ext.runtime.lastError);
    }
  }
})();
//# sourceMappingURL=content.js.map
