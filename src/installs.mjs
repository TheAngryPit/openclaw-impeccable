// Coexisting with regular Impeccable installations.
//
// Upstream's installer writes `.agents/skills/impeccable` by default (plus
// `.claude/…`), at project or user scope. OpenClaw loads `<workspace>/skills`,
// `<workspace>/.agents/skills`, `~/.agents/skills` and `<state>/skills` ahead of
// plugin skills, so such an install shadows this plugin's copy of the skill.
//
// Each Impeccable copy pins its own engine version (scripts/VERSION +
// engine-checksums.txt). To keep the skill text and the engine coherent, the
// gate and tools run the launcher of the copy OpenClaw actually serves. One
// exception: a launcher inside a project is repository code, so it is only
// executed automatically when the operator sets `trustProjectInstalls`; until
// then the plugin's bundled launcher runs instead (same rule as upstream's
// Hermes plugin, which only runs project launchers in trusted projects).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LAUNCHER as BUNDLED_LAUNCHER, SKILL_DIR as BUNDLED_SKILL_DIR } from "./engine.mjs";

const LAUNCHER_NAME = process.platform === "win32" ? "impeccable.cmd" : "impeccable";

// Harness folders upstream installs into at user scope that OpenClaw does not
// load. Reported by `status` only; their engine cache (~/.impeccable) is shared anyway.
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

/** Skill version from frontmatter: top-level `version` (Claude) or `metadata.version` (Codex/.agents). */
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
  const launcher = path.join(skillDir, "scripts", LAUNCHER_NAME);
  return {
    scope,
    skillDir,
    skillVersion: readSkillVersion(skillMd),
    enginePin: readText(path.join(skillDir, "scripts", "VERSION"))?.trim() || undefined,
    launcher: fs.existsSync(launcher) ? launcher : undefined,
    ...extra,
  };
}

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
  candidates.push({
    ...describe(BUNDLED_SKILL_DIR, "plugin", { trusted: true }),
    launcher: BUNDLED_LAUNCHER,
  });
  return candidates.filter(Boolean).filter((c, i, all) => all.findIndex((o) => o.skillDir === c.skillDir) === i);
}

/** Installs for other harnesses that OpenClaw does not load (status only). */
export function discoverOtherHarnessInstalls({ home = os.homedir() } = {}) {
  return OTHER_HARNESS_DIRS.map((dir) => describe(path.join(home, dir, "skills", "impeccable"), `user:${dir}`)).filter(Boolean);
}

/**
 * Pick the copy the model sees (`served`) and the launcher the plugin runs
 * (`engine`). `mode: "bundled"` pins everything to this plugin's copy.
 */
export function selectInstall(installs, { mode = "auto", trustProjectInstalls = false } = {}) {
  const plugin = installs.find((i) => i.scope === "plugin");
  const served = installs[0] ?? plugin;
  if (mode === "bundled") return { served, engine: plugin, reason: "install=bundled" };
  const runnable = (i) => i.launcher && (i.trusted || trustProjectInstalls);
  if (runnable(served)) {
    return { served, engine: served, reason: served === plugin ? "plugin copy is served" : `${served.scope} install is served` };
  }
  return {
    served,
    engine: plugin,
    reason: served.launcher
      ? `${served.scope} launcher not run automatically (set trustProjectInstalls to allow)`
      : `${served.scope} install has no launcher`,
  };
}

/** Human-readable skew between the served skill and the engine the plugin runs. */
export function describeSkew({ served, engine }) {
  if (!served || !engine || served === engine) return undefined;
  if (served.enginePin && engine.enginePin && served.enginePin !== engine.enginePin) {
    return `the served skill (${served.scope}, Impeccable ${served.skillVersion ?? "?"}) pins engine ${served.enginePin}, but the gate and tools run engine ${engine.enginePin} from the ${engine.scope} copy`;
  }
  return undefined;
}

/** Per-workspace cache so hot paths do not stat the filesystem on every edit. */
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

export const BUNDLED_INSTALL = Object.freeze({
  scope: "plugin",
  skillDir: BUNDLED_SKILL_DIR,
  launcher: BUNDLED_LAUNCHER,
  trusted: true,
});

/**
 * engineFor(workspaceDir) → { ok, install, version, selection, reason }:
 * the served copy's launcher when it may run and its engine resolves,
 * otherwise the bundled launcher. Never downloads (probe mode).
 */
export function createEngineSelector({ config, probe, resolveFor = createInstallResolver({ config }) }) {
  return async function engineFor(workspaceDir, { force = false } = {}) {
    const selection = resolveFor(workspaceDir);
    const primary = selection.engine?.launcher ? selection.engine : BUNDLED_INSTALL;
    let install = primary;
    let engine = await probe({ install, force });
    if (!engine.ok && primary.launcher !== BUNDLED_INSTALL.launcher) {
      const fallback = await probe({ install: BUNDLED_INSTALL, force });
      if (fallback.ok) {
        install = BUNDLED_INSTALL;
        engine = fallback;
      }
    }
    return { ok: engine.ok, version: engine.version, reason: engine.reason, install, selection };
  };
}
