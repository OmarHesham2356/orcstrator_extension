import cors from "cors";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.js";
import { OpenCodeClient } from "./opencode-client.js";

const BRIDGE_VERSION = "0.3.0";

const config = loadConfig();
const client = new OpenCodeClient(
  config.opencode.url,
  config.opencode.password,
  config.opencode.username
);

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

type ChatgptConv = {
  chatId: string;
  sessionId: string;
  ocSessionId: string;
  title?: string;
  directory: string;
  createdAt: number;
};

const convs = new Map<string, ChatgptConv>();

function shortId(chatId: string): string {
  return chatId.slice(0, 12);
}

function resolveDir(input?: string): string {
  const base = (input && input.trim()) || config.projectDir;
  try {
    const st = fs.statSync(base);
    if (st.isDirectory()) return path.resolve(base);
  } catch {}
  return path.resolve(config.projectDir);
}

async function getOrCreateConv(
  chatId: string,
  opts: { title?: string; model?: string; agent?: string; directory?: string } = {}
): Promise<{ conv: ChatgptConv; fresh: boolean }> {
  const directory = resolveDir(opts.directory);
  const existing = convs.get(chatId);
  // Same chat but a different working folder -> start a new OpenCode session
  // so files land in the right place. Returns fresh=true so the UI can say so.
  if (existing && existing.directory !== directory) {
    const oc = await client.createSession({
      title: opts.title || `ChatGPT ${shortId(chatId)}`,
      directory,
      agent: opts.agent,
      model: opts.model,
    });
    const c: ChatgptConv = {
      chatId,
      sessionId: chatId,
      ocSessionId: oc.id,
      title: opts.title || (oc as any).title,
      directory,
      createdAt: Date.now(),
    };
    convs.set(chatId, c);
    return { conv: c, fresh: true };
  }
  if (existing) return { conv: existing, fresh: false };
  const oc = await client.createSession({
    title: opts.title || `ChatGPT ${shortId(String(chatId))}`,
    directory,
    agent: opts.agent,
    model: opts.model,
  });
  const c: ChatgptConv = {
    chatId,
    sessionId: chatId,
    ocSessionId: oc.id,
    title: opts.title || (oc as any).title,
    directory,
    createdAt: Date.now(),
  };
  convs.set(chatId, c);
  return { conv: c, fresh: true };
}

app.get("/health", async (_req, res) => {
  try {
    const info = await client.health();
    res.json({ ok: true, bridge: BRIDGE_VERSION, info });
  } catch (e: any) {
    res.status(502).json({ ok: false, bridge: BRIDGE_VERSION, error: e?.message || String(e) });
  }
});

app.post("/chatgpt/new", async (req, res) => {
  const { chatId, title, model, agent, directory } = req.body || {};
  if (!chatId) return res.status(400).json({ error: "chatId required" });
  try {
    const dir = resolveDir(directory);
    const oc = await client.createSession({
      title: title || `ChatGPT ${shortId(String(chatId))}`,
      directory: dir,
      agent,
      model,
    });
    const c: ChatgptConv = {
      chatId,
      sessionId: chatId,
      ocSessionId: oc.id,
      title: title || (oc as any).title,
      directory: dir,
      createdAt: Date.now(),
    };
    convs.set(chatId, c);
    res.json({ ok: true, ocSessionId: oc.id, directory: dir });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.post("/chatgpt/prompt", async (req, res) => {
  const { chatId, text, model, agent, resume, directory } = req.body || {};
  if (!chatId || !text) return res.status(400).json({ error: "chatId and text required" });
  try {
    const { conv: c, fresh } = await getOrCreateConv(chatId, { model, agent, directory });
    const msg = await client.sendPrompt(c.ocSessionId, text, {
      agents: agent ? [agent] : undefined,
      resume,
      metadata: { chatgpt: true },
    });
    res.json({ ok: true, inboxId: msg?.id, ocSessionId: c.ocSessionId, directory: c.directory, fresh });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get("/chatgpt/messages", async (req, res) => {
  const chatId = String(req.query.chatId || "");
  if (!chatId) return res.status(400).json({ error: "chatId required" });
  const c = convs.get(chatId);
  if (!c) return res.json({ ok: true, data: [] });
  try {
    const data = await client.listMessages(c.ocSessionId, 50);
    res.json({ ok: true, ocSessionId: c.ocSessionId, data });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.post("/chatgpt/abort", async (req, res) => {
  const { chatId } = req.body || {};
  if (!chatId) return res.status(400).json({ error: "chatId required" });
  const c = convs.get(chatId);
  if (!c) return res.json({ ok: true, noop: true });
  try {
    await client.abort(c.ocSessionId);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

const sseClients = new Map<string, Set<express.Response>>();
app.get("/events/:chatId", (req, res) => {
  const chatId = req.params.chatId;
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": req.headers.origin || "*",
  });
  res.flushHeaders();
  res.write(`event: ping\ndata: {"t":${Date.now()}}\n\n`);
  const keepalive = setInterval(() => {
    try {
      res.write(`event: ping\ndata: {"t":${Date.now()}}\n\n`);
    } catch {}
  }, 15000);
  let set = sseClients.get(chatId);
  if (!set) {
    set = new Set();
    sseClients.set(chatId, set);
  }
  set.add(res);
  req.on("close", () => {
    clearInterval(keepalive);
    set?.delete(res);
    if (set && set.size === 0) sseClients.delete(chatId);
  });
});

function broadcast(chatId: string, event: string, data: any) {
  const set = sseClients.get(chatId);
  if (!set || set.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const r of set) {
    try {
      r.write(payload);
    } catch {}
  }
}

/** Extract the OpenCode session id from a v2 event envelope. */
function envelopeSessionId(env: any): string | undefined {
  if (!env || typeof env !== "object") return undefined;
  if (typeof env.sessionID === "string") return env.sessionID;
  const d = env.data;
  if (d && typeof d === "object" && typeof d.sessionID === "string") return d.sessionID;
  return undefined;
}

let eventStreamStarted = false;
async function startEventStream() {
  if (eventStreamStarted) return;
  eventStreamStarted = true;
  for (;;) {
    try {
      const stream = client.streamEvents();
      for await (const e of stream) {
        try {
          const ocSid = envelopeSessionId(e.data);
          if (!ocSid) continue;
          for (const c of convs.values()) {
            if (c.ocSessionId === ocSid) {
              broadcast(c.chatId, e.type || "event", e.data);
              break;
            }
          }
        } catch {}
      }
    } catch (err) {
      console.warn("event stream error, retrying in 2s:", (err as Error)?.message || err);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

startEventStream().catch(() => {});

app.get("/convs", (req, res) => {
  const chatId = String(req.query.chatId || "");
  if (chatId) {
    const c = convs.get(chatId);
    return res.json({ data: c ? [c] : [] });
  }
  res.json({ data: Array.from(convs.values()) });
});

// Model / agent pickers for the extension popup.
app.get("/models", async (_req, res) => {
  res.json({ data: await client.listModels() });
});

app.get("/agents", async (_req, res) => {
  res.json({ data: await client.listAgents() });
});

// Local folder browser so OpenCode sessions get the right working directory.
// The bridge runs on your machine, so these are real server-side paths.
app.get("/browse", (req, res) => {
  const home = os.homedir();
  let dir = String(req.query.dir || "") || config.projectDir;
  try {
    if (!path.isAbsolute(dir)) dir = path.resolve(config.projectDir, dir);
    const st = fs.statSync(dir);
    if (!st.isDirectory()) throw new Error("not a directory");
  } catch {
    dir = config.projectDir;
  }
  dir = path.resolve(dir);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e: any) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
  const entries = names
    .filter((n) => !n.startsWith("."))
    .map((n) => {
      let isDir = false;
      try {
        isDir = fs.statSync(path.join(dir, n)).isDirectory();
      } catch {}
      return { name: n, path: path.join(dir, n), isDir };
    })
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  res.json({
    dir,
    parent: path.dirname(dir),
    home,
    defaultDir: path.resolve(config.projectDir),
    entries: entries.slice(0, 300),
  });
});

app.listen(config.port, config.host, () => {
  console.log(`Orcstrator bridge v${BRIDGE_VERSION} listening at http://${config.host}:${config.port}`);
  console.log(`OpenCode server: ${config.opencode.url}`);
});
