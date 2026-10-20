// dist/extension/popup.js
var ext = typeof globalThis.browser !== "undefined" ? globalThis.browser : globalThis.chrome;
var $ = (id) => document.getElementById(id);
async function storageGet() {
  try {
    const p = ext.storage.local.get("orc");
    if (p && typeof p.then === "function") return (await p).orc || {};
    return await new Promise((res) => ext.storage.local.get("orc", (v) => res(v && v.orc || {})));
  } catch {
    return {};
  }
}
async function storageSet(orc) {
  try {
    const p = ext.storage.set ? ext.storage.local.set({ orc }) : null;
    if (p && typeof p.then === "function") {
      await p;
      return;
    }
    await new Promise((res, rej) => {
      ext.storage.local.set({ orc }, () => {
        const e = ext.runtime && ext.runtime.lastError;
        if (e) rej(new Error(e.message));
        else res();
      });
    });
  } catch (e) {
    await new Promise((res) => ext.storage.local.set({ orc }, res));
  }
}
async function load() {
  const orc = await storageGet();
  $("bridge").value = orc.bridgeUrl || "http://127.0.0.1:8787";
  $("forward").value = orc.forwardTo || "opencode";
  $("relay").value = orc.relay === "direct" ? "direct" : "relay";
  $("turns").value = Math.max(1, Number(orc.maxTurns) || 4);
  updateTurnsVisibility();
  $("agent").value = orc.agent || "";
  $("model").value = orc.model || "";
  await test();
  await loadLists();
}
function fillList(id, items) {
  const dl = $(id);
  dl.innerHTML = "";
  for (const it of items.slice(0, 200)) {
    const o = document.createElement("option");
    o.value = it.value;
    o.label = it.label || it.value;
    dl.appendChild(o);
  }
}
async function loadLists() {
  const hint = $("lists-hint");
  const bridge = $("bridge").value.trim().replace(/\/$/, "");
  try {
    const [m, a] = await Promise.all([
      fetch(`${bridge}/models`, { mode: "cors" }).then((r) => r.json()),
      fetch(`${bridge}/agents`, { mode: "cors" }).then((r) => r.json())
    ]);
    const models = (m.data || []).map((x) => ({
      value: `${x.providerID}/${x.id}`,
      label: `${x.name} (${x.providerID}/${x.id})`
    }));
    const agents = (a.data || []).map((x) => ({
      value: x.id,
      label: x.description ? `${x.name || x.id} \u2014 ${x.description.slice(0, 60)}` : x.id
    }));
    fillList("model-list", models);
    fillList("agent-list", agents);
    hint.textContent = `${models.length} models \xB7 ${agents.length} agents (type to filter, or type a custom ref)`;
  } catch {
    hint.textContent = "model/agent lists need a running bridge";
  }
}
async function test() {
  const bridge = $("bridge").value.trim().replace(/\/$/, "");
  const pill = $("status-pill");
  pill.textContent = "checking...";
  pill.className = "pill";
  try {
    const r = await fetch(`${bridge}/health`, { mode: "cors" });
    const j = await r.json();
    if (j.ok) {
      pill.textContent = `ok \xB7 bridge v${j.bridge || "?"} \xB7 oc v${j.info?.version || "?"}`;
      pill.className = "pill ok";
    } else {
      throw new Error(j.error || "bad");
    }
  } catch (e) {
    pill.textContent = "unreachable";
    pill.className = "pill bad";
  }
}
async function save() {
  await storageSet({
    bridgeUrl: $("bridge").value.trim().replace(/\/$/, ""),
    forwardTo: $("forward").value,
    relay: $("relay").value,
    maxTurns: Math.max(1, Math.min(12, Number($("turns").value) || 4)),
    agent: $("agent").value.trim() || void 0,
    model: $("model").value.trim() || void 0
  });
  window.close();
}
function updateTurnsVisibility() {
  const on = $("relay").value === "relay";
  $("turns").style.display = on ? "" : "none";
  $("turns-label").style.display = on ? "" : "none";
}
$("relay").onchange = () => {
  updateTurnsVisibility();
};
$("test").onclick = test;
$("save").onclick = save;
load();
//# sourceMappingURL=popup.js.map
