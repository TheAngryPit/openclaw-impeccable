import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SKILL_DIR = path.join(packageRoot, "skills", "impeccable");
const IS_WINDOWS = process.platform === "win32";
export const LAUNCHER = path.join(SKILL_DIR, "scripts", IS_WINDOWS ? "impeccable.cmd" : "impeccable");
export const PINNED_ENGINE_VERSION = readPinnedVersion();
const MAX_OUTPUT_BYTES = 1024 * 1024;
const NEGATIVE_PROBE_TTL_MS = 60_000;

function readPinnedVersion() {
  try {
    return fs.readFileSync(path.join(SKILL_DIR, "scripts", "VERSION"), "utf8").trim();
  } catch {
    return "";
  }
}

export function engineEnv({ engineBin, install, extra = {}, base = process.env } = {}) {
  const env = {
    ...base,
    IMPECCABLE_PROVIDER_ID: "openclaw",
    IMPECCABLE_SKILL_DIR: install?.skillDir ?? SKILL_DIR,
    ...extra,
  };
  delete env.IMPECCABLE_LAUNCHER_PROBE;
  delete env.IMPECCABLE_SELF; // the launcher exports its own path
  if (engineBin) env.IMPECCABLE_BIN = engineBin;
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  return env;
}

export function runEngine(args, { cwd, input, env, timeoutMs = 30_000, signal, launcher = LAUNCHER } = {}) {
  return new Promise((resolve) => {
    const command = IS_WINDOWS ? process.env.ComSpec || "cmd.exe" : "sh";
    const argv = IS_WINDOWS
      ? // `cmd /s /c` strips exactly one outer pair of quotes, so wrap the whole line.
        ["/d", "/s", "/c", `"${[launcher, ...args].map(quoteCmdArg).join(" ")}"`]
      : [launcher, ...args];
    let child;
    try {
      child = spawn(command, argv, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: IS_WINDOWS,
        signal,
      });
    } catch (error) {
      resolve({ ok: false, code: null, stdout: "", stderr: "", error: String(error?.message ?? error) });
      return;
    }
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (outBytes >= MAX_OUTPUT_BYTES) return void (truncated = true);
      out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr.on("data", (chunk) => {
      if (errBytes >= MAX_OUTPUT_BYTES) return;
      err.push(chunk);
      errBytes += chunk.length;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout: "", stderr: "", error: String(error?.message ?? error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (timedOut) {
        resolve({ ok: false, code, stdout, stderr, error: `timed out after ${timeoutMs} ms` });
        return;
      }
      resolve({ ok: code === 0, code, stdout, stderr, truncated });
    });
    child.stdin.on("error", () => {}); // the engine may exit before reading stdin
    child.stdin.end(input ?? "");
  });
}

function quoteCmdArg(arg) {
  return /[\s"&|<>^]/.test(arg) ? `"${String(arg).replace(/"/g, '""')}"` : arg;
}

export function createEngineProbe({ engineBin, run = runEngine, now = Date.now } = {}) {
  const cached = new Map();
  const inflight = new Map();
  async function probe({ force = false, install } = {}) {
    const launcher = install?.launcher ?? LAUNCHER;
    const hit = cached.get(launcher);
    if (!force && hit && (hit.ok || now() - hit.at < NEGATIVE_PROBE_TTL_MS)) return hit;
    if (!inflight.has(launcher)) {
      inflight.set(
        launcher,
        run(["engine-probe"], {
          launcher,
          cwd: install?.skillDir ?? SKILL_DIR,
          // Without IMPECCABLE_LAUNCHER_PROBE the launcher downloads the pinned engine when none is found.
          env: { ...engineEnv({ engineBin, install }), IMPECCABLE_LAUNCHER_PROBE: "1" },
          timeoutMs: 5_000,
        })
          .then((r) => {
            const m = /^impeccable-engine\s+(\S+)/m.exec(r.stdout ?? "");
            const value = m
              ? { ok: true, version: m[1], at: now() }
              : { ok: false, at: now(), reason: (r.stderr || r.error || "engine not installed").trim() };
            cached.set(launcher, value);
            return value;
          })
          .finally(() => inflight.delete(launcher)),
      );
    }
    return inflight.get(launcher);
  }
  probe.invalidate = () => cached.clear();
  return probe;
}

export function parseHookOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const additionalContext =
    typeof parsed.hookSpecificOutput?.additionalContext === "string"
      ? parsed.hookSpecificOutput.additionalContext
      : typeof parsed.additionalContext === "string"
        ? parsed.additionalContext
        : typeof parsed.additional_context === "string"
          ? parsed.additional_context
          : undefined;
  const block = parsed.decision === "block" && typeof parsed.reason === "string" ? parsed.reason : undefined;
  return { additionalContext: additionalContext?.trim() || undefined, block: block?.trim() || undefined };
}
