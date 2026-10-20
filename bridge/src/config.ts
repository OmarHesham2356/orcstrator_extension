import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Config {
  port: number;
  host: string;
  opencode: {
    url: string;
    username: string;
    password: string;
  };
  projectDir: string;
  forwardTo: "opencode" | "chatgpt";
}

function loadJson(file: string): any | null {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.warn("config parse failed", file, e);
  }
  return null;
}

export function loadConfig(): Config {
  const cfgPath = process.env.ORC_CONFIG || path.join(os.homedir(), ".config", "orcstrator", "config.json");
  const local = loadJson(path.join(process.cwd(), "config.json"));
  const global = loadJson(cfgPath);
  const merged = Object.assign(
    {
      port: Number(process.env.ORC_PORT) || 8787,
      host: process.env.ORC_HOST || "127.0.0.1",
      opencode: {
        url: process.env.OPENCODE_URL || "http://127.0.0.1:49374",
        username: process.env.OPENCODE_USERNAME || "opencode",
        // Client-side credential for `opencode serve` instances that were
        // started with OPENCODE_SERVER_PASSWORD. The background service
        // (`opencode serve --service`, default port 49374) usually has no
        // password, so empty string is the correct default.
        password: process.env.OPENCODE_PASSWORD || "",
      },
      projectDir: process.env.ORC_PROJECT_DIR || process.cwd(),
      forwardTo: (process.env.ORC_FORWARD_TO as any) || "opencode",
    },
    global || {},
    local || {}
  );
  // Allow nested `opencode` overrides from files without wiping defaults.
  merged.opencode = Object.assign(
    {
      url: process.env.OPENCODE_URL || "http://127.0.0.1:49374",
      username: process.env.OPENCODE_USERNAME || "opencode",
      password: process.env.OPENCODE_PASSWORD || "",
    },
    (global && (global as any).opencode) || {},
    (local && (local as any).opencode) || {}
  );
  // Convenience: when no password is configured, pick up the background
  // service credential that `opencode serve --service` writes to
  // $XDG_STATE_HOME/opencode/service.json (or ~/.local/state/opencode/).
  if (!merged.opencode.password) {
    const fromService = readServicePassword(merged.opencode.url);
    if (fromService) merged.opencode.password = fromService;
  }
  return merged as Config;
}

/** Best-effort read of the `opencode serve --service` credential file. */
function readServicePassword(serverUrl: string): string {
  try {
    const stateHome =
      process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
    const file = path.join(stateHome, "opencode", "service.json");
    if (!fs.existsSync(file)) return "";
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (j && typeof j.password === "string" && (!j.url || j.url === serverUrl)) {
      return j.password;
    }
  } catch {}
  return "";
}
