import path from "node:path";
import { engineEnv, runEngine } from "./engine.mjs";
import { describeSkew } from "./installs.mjs";

const MAX_TEXT = 60_000;
const ENGINE_MISSING =
  "The Impeccable engine is not installed on the Gateway host. Ask the operator to run `openclaw impeccable engine install`. " +
  "For this turn, follow the skill's \"Launcher unavailable\" path: read PRODUCT.md and DESIGN.md directly.";

function clip(text) {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… [truncated ${text.length - MAX_TEXT} chars]` : text;
}

function textResult(text, details) {
  return { content: [{ type: "text", text: clip(text) }], details };
}

export function resolveTarget(raw, workspaceDir) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("empty target");
  const value = raw.trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    throw new Error(`unsupported target scheme: ${value}`);
  }
  const abs = path.resolve(workspaceDir, value);
  const rel = path.relative(workspaceDir, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`target is outside the workspace: ${value}`);
  return abs;
}

export function installNote(engine) {
  const served = engine.selection?.served;
  const parts = [];
  if (served && served.scope !== "plugin") {
    parts.push(`Impeccable ${served.skillVersion ?? "?"} is served from the ${served.scope} install at ${served.skillDir}; its launcher is ${served.skillDir}/scripts/impeccable.`);
  }
  const skew = describeSkew({ served, engine: engine.install });
  if (skew) parts.push(`Version skew: ${skew}. Run \`openclaw impeccable status\` for details.`);
  return parts.join(" ");
}

export function createTools({ config, engineFor, run = runEngine }) {
  const env = (engine) => engineEnv({ engineBin: config.engineBin, install: engine.install });
  const runWith = (engine, args, opts) => run(args, { ...opts, launcher: engine.install?.launcher, env: env(engine) });

  const contextTool = (ctx) => ({
    name: "impeccable_context",
    label: "Impeccable context",
    description:
      "Load this project's Impeccable design context (PRODUCT.md, DESIGN.md, the matching surface brief, native-platform guidance) and its directives. Impeccable skill Setup step 1; call once per session before design work.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        target: { type: "string", description: "Named source file or route the task is about (workspace-relative)." },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["available"],
      properties: {
        available: { type: "boolean" },
        engineVersion: { type: "string" },
        exitCode: { type: ["integer", "null"] },
        servedFrom: { type: "string" },
        engineFrom: { type: "string" },
      },
    },
    async execute(_id, params = {}) {
      const workspaceDir = ctx.workspaceDir;
      if (!workspaceDir) return textResult("No workspace directory is available for this session.", { available: false });
      const engine = await engineFor(workspaceDir);
      if (!engine.ok) return textResult(ENGINE_MISSING, { available: false });
      const args = ["context"];
      if (params.target) args.push("--target", resolveTarget(params.target, workspaceDir));
      const r = await runWith(engine, args, { cwd: workspaceDir, timeoutMs: 30_000 });
      const text = [installNote(engine), r.stdout.trim(), r.stderr.trim() && `stderr:\n${r.stderr.trim()}`, r.error && `error: ${r.error}`]
        .filter(Boolean)
        .join("\n\n");
      return textResult(text || "(no output)", {
        available: true,
        engineVersion: engine.version,
        exitCode: r.code ?? null,
        servedFrom: engine.selection?.served?.scope,
        engineFrom: engine.install?.scope,
      });
    },
  });

  const detectTool = (ctx) => ({
    name: "impeccable_detect",
    label: "Impeccable detect",
    description:
      "Scan UI files, directories or http(s) URLs for Impeccable's design anti-patterns and quality issues (AI-slop tells, contrast, type scale, spacing, design-system drift). Returns the detector's JSON findings. With no targets and changed=true, scans the UI files git reports as changed.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        targets: {
          type: "array",
          items: { type: "string" },
          maxItems: 50,
          description: "Workspace-relative files or directories, or http(s) URLs (URL scans use a local Chrome/Edge).",
        },
        changed: { type: "boolean", description: "Scan the UI files git reports as changed. Takes no targets." },
        scope: { type: "string", description: "Only report rules in these design domains, comma-separated (e.g. type,layout)." },
        viewport: { type: "string", pattern: "^\\d{2,5}x\\d{2,5}$", description: "URL scans only, e.g. 390x844." },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["available"],
      properties: {
        available: { type: "boolean" },
        engineVersion: { type: "string" },
        exitCode: { type: ["integer", "null"] },
        findings: { type: ["integer", "null"] },
      },
    },
    async execute(_id, params = {}) {
      const workspaceDir = ctx.workspaceDir;
      if (!workspaceDir) return textResult("No workspace directory is available for this session.", { available: false });
      const targets = Array.isArray(params.targets) ? params.targets : [];
      if (params.changed && targets.length) throw new Error("`changed` takes no targets");
      const engine = await engineFor(workspaceDir);
      if (!engine.ok) return textResult(ENGINE_MISSING, { available: false });
      const args = ["detect", "--json"];
      if (params.changed) args.push("--changed");
      if (params.scope) args.push("--scope", String(params.scope));
      if (params.viewport) args.push("--viewport", String(params.viewport));
      for (const t of targets.length || params.changed ? targets : ["."]) args.push(resolveTarget(t, workspaceDir));
      const r = await runWith(engine, args, { cwd: workspaceDir, timeoutMs: 120_000 });
      // Exit 0: clean. Exit 2: findings. Anything else is a scan error.
      let findings = null;
      try {
        const parsed = JSON.parse(r.stdout);
        findings = Array.isArray(parsed) ? parsed.length : null;
      } catch {}
      const failed = r.code !== 0 && r.code !== 2;
      const text = failed
        ? `Detector failed (exit ${r.code ?? "none"}): ${(r.stderr || r.error || r.stdout).trim()}`
        : r.stdout.trim() || "[]";
      return textResult(text, { available: true, engineVersion: engine.version, exitCode: r.code ?? null, findings });
    },
  });

  return [contextTool, detectTool];
}
