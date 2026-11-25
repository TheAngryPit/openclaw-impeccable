import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SKILL_DIR as BUNDLED_SKILL_DIR, launcherIn } from "./engine.mjs";

const OTHER_HARNESS_DIRS = [
  ".claude", ".codex", ".cursor", ".gemini", ".github", ".kiro", ".opencode", ".qoder",
  ".trae", ".rovodev", ".vibe", ".grok", ".devin", ".hermes", ".pi/agent", ".omp/agent", ".gemini/config",
];

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

export function readSkillVersion(skillMd) {
  const text = readText(skillMd);
  const fm = text && /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (!fm) return undefined;
  const top = /^version:\s*["']?([^"'\s]+)/m.exec(fm)?.[1];
  if (top) return top;
  return /^metadata:\s*\n(?:[ \t]+.*\n)*?[ \t]+version:\s*["']?([^"'\s]+)/m.exec(`${fm}\n`)?.[1];
}

function describe(skillDir, scope, extra = {}) {
  const skillMd = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillMd)) return undefined;
  const launcher = launcherIn(skillDir);
  return {
    scope,
    skillDir,
    skillVersion: readSkillVersion(skillMd),
    enginePin: readText(path.join(skillDir, "scripts", "VERSION"))?.trim() || undefined,
    launcher: fs.existsSync(launcher) ? launcher : undefined,
    ...extra,
  };
}

export const BUNDLED_INSTALL = Object.freeze(describe(BUNDLED_SKILL_DIR, "plugin", { trusted: true }));

export const mayRunLauncher = (install, { trustProjectInstalls }) =>
  Boolean(install.launcher && (install.trusted || trustProjectInstalls));

export function defaultStateDir(env = process.env, home = os.homedir()) {
  return env.OPENCLAW_STATE_DIR ? path.resolve(env.OPENCLAW_STATE_DIR) : path.join(home, ".openclaw");
}

/**
 * Impeccable copies OpenClaw can serve for a workspace, highest precedence
 * first (OpenClaw's skill loading order), ending with this plugin's copy.
 */
export function discoverInstalls({ workspaceDir, home = os.homedir(), env = process.env } = {}) {
  const stateDir = defaultStateDir(env, home);
  const isDefaultState = stateDir === path.join(home, ".openclaw");
  const candidates = [];
  if (workspaceDir) {
    candidates.push(describe(path.join(workspaceDir, "skills", "impeccable"), "workspace", { trusted: false }));
    candidates.push(describe(path.join(workspaceDir, ".agents", "skills", "impeccable"), "project", { trusted: false }));
  }
  if (isDefaultState) {
    candidates.push(describe(path.join(home, ".agents", "skills", "impeccable"), "user", { trusted: true }));
  }
  candidates.push(describe(path.join(stateDir, "skills", "impeccable"), "managed", { trusted: true }));
  candidates.push(BUNDLED_INSTALL);
  return candidates.filter(Boolean).filter((c, i, all) => all.findIndex((o) => o.skillDir === c.skillDir) === i);
}

export function discoverOtherHarnessInstalls({ home = os.homedir() } = {}) {
  return OTHER_HARNESS_DIRS.map((dir) => describe(path.join(home, dir, "skills", "impeccable"), `user:${dir}`)).filter(Boolean);
}

export function selectInstall(installs, { install = "auto", trustProjectInstalls = false } = {}) {
  const served = installs[0];
  if (install === "bundled") return { served, engineInstall: BUNDLED_INSTALL, reason: "install=bundled" };
  if (mayRunLauncher(served, { trustProjectInstalls })) {
    return { served, engineInstall: served, reason: served === BUNDLED_INSTALL ? "plugin copy is served" : `${served.scope} install is served` };
  }
  return {
    served,
    engineInstall: BUNDLED_INSTALL,
    reason: served.launcher
      ? `${served.scope} launcher not run automatically (set trustProjectInstalls to allow)`
      : `${served.scope} install has no launcher`,
  };
}

export function describeSkew({ served, engineInstall }) {
  if (!served || !engineInstall || served === engineInstall) return undefined;
  if (served.enginePin && engineInstall.enginePin && served.enginePin !== engineInstall.enginePin) {
    return `the served skill (${served.scope}, Impeccable ${served.skillVersion ?? "?"}) pins engine ${served.enginePin}, but the gate and tools run engine ${engineInstall.enginePin} from the ${engineInstall.scope} copy`;
  }
  return undefined;
}

export function createInstallResolver({ config, env = process.env, home = os.homedir(), ttlMs = 30_000, now = Date.now }) {
  const cache = new Map();
  return function resolveFor(workspaceDir) {
    const key = workspaceDir ?? "";
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = selectInstall(discoverInstalls({ workspaceDir, home, env }), config);
    cache.set(key, { at: now(), value });
    if (cache.size > 256) cache.delete(cache.keys().next().value);
    return value;
  };
}

export function createEngineSelector({ config, probe, resolveFor = createInstallResolver({ config }) }) {
  return async function engineFor(workspaceDir, { force = false } = {}) {
    const selection = resolveFor(workspaceDir);
    let install = selection.engineInstall;
    let engine = await probe({ install, force });
    if (!engine.ok && install !== BUNDLED_INSTALL) {
      const fallback = await probe({ install: BUNDLED_INSTALL, force });
      if (fallback.ok) {
        install = BUNDLED_INSTALL;
        engine = fallback;
      }
    }
    return { ok: engine.ok, version: engine.version, install, selection };
  };
}
