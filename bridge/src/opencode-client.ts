/**
 * Minimal OpenCode v2 HTTP client (direct fetch, no CLI subprocess).
 *
 * Verified against the live OpenAPI spec at http://<host>:<port>/openapi.json
 * (opencode v2.0.26, `server.info` / `session.create` / `session.prompt` /
 * `event.subscribe`). All paths live under `/api/*`.
 */

export interface OpenCodeSession {
  id: string;
  title?: string;
  agent?: string;
  model?: { providerID: string; id: string };
}

export interface ModelRef {
  providerID: string;
  id: string;
}

/** Parse "provider/model" (or bare "model") into a Model.Ref object. */
export function parseModelRef(input: unknown): ModelRef | undefined {
  if (typeof input !== "string") return undefined;
  const s = input.trim();
  if (!s) return undefined;
  // Allow JSON form too: {"providerID":"...","id":"..."}
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s);
      if (j && typeof j.id === "string" && typeof j.providerID === "string") {
        return { providerID: j.providerID, id: j.id };
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  const slash = s.indexOf("/");
  if (slash > 0) {
    const providerID = s.slice(0, slash).trim();
    const id = s.slice(slash + 1).trim();
    if (providerID && id) return { providerID, id };
    return undefined;
  }
  return { providerID: "opencode", id: s };
}

export type BridgeEvent = { type: string; data: any };

export class OpenCodeClient {
  constructor(
    private url: string,
    private password: string,
    private username = "opencode"
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.password) {
      h["authorization"] =
        "Basic " + Buffer.from(`${this.username}:${this.password}`).toString("base64");
    }
    return h;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: this.headers(
        body !== undefined ? { "content-type": "application/json" } : {}
      ),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`non-JSON response from ${method} ${path}: ${text.slice(0, 200)}`);
    }
  }

  /** GET /api/info */
  async health(): Promise<any> {
    const j = await this.req<{ [k: string]: any }>("GET", "/api/info");
    return j;
  }

  /** GET /api/session */
  async listSessions(): Promise<any[]> {
    const j = await this.req<{ data: any[] }>("GET", "/api/session?limit=50");
    return j.data || [];
  }

  /** POST /api/session */
  async createSession(opts: {
    title?: string;
    directory?: string;
    parentID?: string;
    agent?: string;
    model?: string | ModelRef;
  }): Promise<OpenCodeSession> {
    const body: Record<string, unknown> = {};
    if (opts.title) body.title = opts.title;
    if (opts.parentID) body.parentID = opts.parentID;
    if (opts.agent) body.agent = opts.agent;
    const ref = typeof opts.model === "string" ? parseModelRef(opts.model) : opts.model;
    if (ref) body.model = ref;
    if (opts.directory) body.location = { directory: opts.directory };
    const j = await this.req<{ data: OpenCodeSession }>("POST", "/api/session", body);
    return j.data;
  }

  /**
   * POST /api/session/:id/prompt
   * Body: { text, files?, agents?: [{name}], skills?, metadata?, resume? }
   */
  async sendPrompt(
    sessionID: string,
    text: string,
    opts: { agents?: string[]; resume?: boolean; metadata?: any } = {}
  ): Promise<any> {
    const body: Record<string, unknown> = { text };
    if (opts.agents && opts.agents.length > 0) {
      body.agents = opts.agents.map((name) => ({ name }));
    }
    if (typeof opts.resume === "boolean") body.resume = opts.resume;
    if (opts.metadata) body.metadata = opts.metadata;
    const j = await this.req<{ data: any }>(
      "POST",
      `/api/session/${encodeURIComponent(sessionID)}/prompt`,
      body
    );
    return j.data;
  }

  /** GET /api/session/:id/message */
  async listMessages(sessionID: string, limit = 50): Promise<any[]> {
    const j = await this.req<{ data: any[] }>(
      "GET",
      `/api/session/${encodeURIComponent(sessionID)}/message?limit=${limit}&order=desc`
    );
    return j.data || [];
  }

  /** GET /api/model — simplified for the extension model picker. */
  async listModels(): Promise<{ providerID: string; id: string; name: string }[]> {
    try {
      const j = await this.req<{ data: any[] }>("GET", "/api/model");
      return (j.data || []).map((m: any) => ({
        providerID: m.providerID || "opencode",
        id: m.modelID || m.id,
        name: m.name || m.modelID || m.id,
      }));
    } catch {
      return [];
    }
  }

  /** GET /api/agent — simplified for the extension agent picker. */
  async listAgents(): Promise<{ id: string; name: string; mode: string; description: string }[]> {
    try {
      const j = await this.req<{ data: any[] }>("GET", "/api/agent");
      return (j.data || [])
        .filter((a: any) => !a.hidden)
        .map((a: any) => ({
          id: a.id,
          name: a.name || a.id,
          mode: a.mode || "",
          description: a.description || "",
        }));
    } catch {
      return [];
    }
  }

  /** POST /api/session/:id/abort */
  async abort(sessionID: string): Promise<void> {
    await this.req("POST", `/api/session/${encodeURIComponent(sessionID)}/abort`, {});
  }

  /**
   * GET /api/event as an async generator of { type, data }.
   * The v2 stream sends `data: <json>` lines where the JSON envelope carries
   * the real event name in `.type` (e.g. session.text.delta). SSE `event:`
   * lines are absent, so the envelope type is authoritative.
   */
  async *streamEvents(signal?: AbortSignal): AsyncGenerator<BridgeEvent> {
    const res = await fetch(`${this.url}/api/event`, {
      headers: this.headers({ accept: "text/event-stream" }),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`event stream -> ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const handleLine = function* (line: string): Generator<BridgeEvent> {
      line = line.trim();
      if (!line || line.startsWith(":")) return;
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      try {
        const env = JSON.parse(payload);
        if (env && typeof env.type === "string") {
          yield { type: env.type, data: env };
        }
      } catch {
        // ignore malformed lines
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          yield* handleLine(line);
        }
      }
      if (buf.trim()) yield* handleLine(buf);
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  }
}
