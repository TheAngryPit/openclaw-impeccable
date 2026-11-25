#!/usr/bin/env node
// Generate skills/impeccable from an upstream Impeccable checkout.
//
//   node scripts/sync-upstream.mjs <path-to-impeccable-checkout>
//
// This mirrors upstream's per-provider build (scripts/build.js and
// scripts/lib/transformers/factory.js) for an "openclaw" provider, without
// executing any upstream code: it only reads skill/ and writes this package's
// skills/impeccable plus UPSTREAM.json. Re-run it to update the pinned
// upstream, then review the diff.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const outDir = path.join(packageRoot, "skills", "impeccable");

// ── OpenClaw provider profile ───────────────────────────────────────────────
// Equivalent of an entry in upstream's PROVIDERS + PROVIDER_PLACEHOLDERS.
export const OPENCLAW = {
  // No upstream provider tag matches, so every harness-specific block
  // (<claude-code>, <codex>, ...) is dropped and the generic text remains.
  providerTags: ["openclaw"],
  model: "the model",
  config_file: "AGENTS.md",
  ask_instruction:
    "Ask with the `ask_user` tool when it is available, or directly in chat if it is not, and wait for the answer before continuing.",
  command_prefix: "/",
  // OpenClaw resolves {baseDir} against the skill directory, in SKILL.md and
  // in every file the skill points the model at.
  scripts_path: "{baseDir}/scripts",
};

// Upstream's tag registry (scripts/lib/utils.js PROVIDER_BLOCK_TAGS). Known
// tags that do not match are stripped; unknown tags are left untouched.
const PROVIDER_BLOCK_TAGS = new Set([
  "agents", "antigravity", "claude", "claude-code", "codex", "cursor", "devin",
  "dsh", "gemini", "github", "grok", "hermes", "kiro", "opencode", "pi", "omp",
  "qoder", "rovo-dev", "trae", "trae-cn", "vibe", "veto",
]);

// Upstream scripts/lib/skill-categories.js, used to render {{command_hint}}.
const SKILL_CATEGORIES = {
  shape: "create", critique: "evaluate", audit: "evaluate", typeset: "refine",
  layout: "refine", colorize: "refine", animate: "refine", delight: "refine",
  bolder: "refine", quieter: "refine", overdrive: "refine", distill: "simplify",
  clarify: "simplify", adapt: "simplify", polish: "harden", optimize: "harden",
  harden: "harden", onboard: "harden", init: "system", document: "system",
  extract: "system", live: "system", generate: "system",
};
const CATEGORY_ORDER = ["create", "evaluate", "refine", "simplify", "harden", "system"];
const IMPECCABLE_SUB_COMMANDS = [
  "adapt", "animate", "audit", "bolder", "clarify", "colorize", "critique",
  "delight", "distill", "document", "harden", "layout", "onboard", "optimize",
  "overdrive", "polish", "quieter", "shape", "typeset",
];
// Per-project state that must never ship inside the distributable skill.
const PER_PROJECT_SCRIPT_ARTIFACTS = new Set(["config.json"]);

const DEGRADED_PREAMBLE = `<!-- Generated from skill/agents/ at build time. Do not edit; edit the agent definition. -->
This harness has no subagent capability, so you are running this role inline. Step fully out of the work you just finished, adopt only this file's instructions for the pass, and disclose the substitution in one line of your closing message to the user, outside the output contract. Where the text below addresses a parent agent, you are both parties: produce the full output contract first, then act on it yourself.`;

// Appended to SKILL.md: how this package differs from a bare skill install.
const OPENCLAW_ADAPTER = `## OpenClaw

This skill ships in the \`impeccable\` OpenClaw plugin. \`{baseDir}\` is this skill's directory: it resolves the launcher (\`{baseDir}/scripts/impeccable\`) and every reference path.

- **Setup step 1:** call the \`impeccable_context\` tool (pass \`target\` for a named file or route). It runs the same \`impeccable context\` verb on the same engine without a shell approval. If the tool is unavailable, run \`{baseDir}/scripts/impeccable context\` with \`exec\` as written above.
- **Detector:** call \`impeccable_detect\` for anti-pattern scans of files, directories or URLs instead of shelling out to \`npx impeccable detect\`.
- **Design gate:** unless the project ran \`/impeccable hooks off\`, findings for UI files you edit are appended to the \`write\`, \`edit\` or \`apply_patch\` result, and a final deep pass can ask for one more revision before you finish. Triage them as the findings' own instructions say; see [reference/hooks.md](reference/hooks.md) for the suppression ladder.
- **Sub-agents:** where a playbook delegates a role (finish review, motion review, documenter, asset producer, manual-edit applier), use \`sessions_spawn\` when it is available and pass the role's file from [reference/degraded/](reference/degraded/) as the brief; otherwise run that file inline.
- **Engine missing:** if a verb reports that engine setup needs network access, tell the user to run \`openclaw impeccable engine install\` once on the Gateway host, then follow the Launcher unavailable path above for this turn.`;

// ── transforms (ports of upstream scripts/lib/utils.js) ────────────────────

export function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  const frontmatter = {};
  let currentList = null;
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && currentList) {
      frontmatter[currentList].push(unquote(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    if (raw === "") {
      frontmatter[key] = [];
      currentList = key;
    } else {
      frontmatter[key] = unquote(raw);
      currentList = null;
    }
  }
  return { frontmatter, body: match[2] };
}

function unquote(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1).replace(/\\"/g, '"');
  }
  if (v === "true") return true;
  if (v === "false") return false;
  return v;
}

export function compileProviderBlocks(content, activeTags = []) {
  const active = new Set(activeTags);
  const pattern = /(^|\r?\n)[ \t]*<([a-z][a-z0-9-]*)>[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*<\/\2>[ \t]*(?=\r?\n|$)/g;
  let compiled = false;
  const out = content.replace(pattern, (match, prefix, tag, body) => {
    if (!PROVIDER_BLOCK_TAGS.has(tag)) return match;
    compiled = true;
    return active.has(tag) ? `${prefix}${body}` : prefix;
  });
  return compiled ? out.replace(/(?:\r?\n){3,}/g, "\n\n") : out;
}

export function stripRuleMarkers(content) {
  return content.replace(/[ \t]*<!--\s*rule:[a-z0-9-]+\s*-->/g, "");
}

export function replacePlaceholders(content, profile = OPENCLAW) {
  const commandList = IMPECCABLE_SUB_COMMANDS.map((n) => `${profile.command_prefix}impeccable ${n}`).join(", ");
  return content
    .replace(/\{\{model\}\}/g, profile.model)
    .replace(/\{\{config_file\}\}/g, profile.config_file)
    .replace(/\{\{ask_instruction\}\}/g, profile.ask_instruction)
    .replace(/\{\{command_prefix\}\}/g, profile.command_prefix)
    .replace(/\{\{available_commands\}\}/g, commandList)
    .replace(/\{\{scripts_path\}\}/g, profile.scripts_path);
}

export function renderMarkdown(content, { referencePath } = {}) {
  let out = compileProviderBlocks(content, OPENCLAW.providerTags);
  out = replacePlaceholders(out);
  out = stripRuleMarkers(out);
  if (referencePath) out = out.replace(/\{\{reference_path\}\}/g, referencePath);
  return out;
}

export function commandHint(commandMetadata) {
  const commands = Object.keys(commandMetadata);
  const missing = commands.filter((c) => !SKILL_CATEGORIES[c] && c !== "craft" && c !== "impeccable");
  if (missing.length) {
    console.warn(`warning: no category for upstream command(s): ${missing.join(", ")}; they are left out of argument-hint`);
  }
  return CATEGORY_ORDER.map((cat) => commands.filter((c) => SKILL_CATEGORIES[c] === cat).join("|"))
    .filter(Boolean)
    .join(" · ");
}

function yamlScalar(value) {
  const s = String(value);
  return /^[\w./-][\w ./()-]*$/.test(s) && !/:\s|#/.test(s) ? s : JSON.stringify(s);
}

function writeFile(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode) fs.chmodSync(file, mode);
}

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────

export function build(upstreamRoot, target = outDir) {
  const skillSrc = path.join(upstreamRoot, "skill");
  const srcMd = path.join(skillSrc, "SKILL.src.md");
  if (!fs.existsSync(srcMd)) throw new Error(`not an Impeccable checkout (missing ${srcMd})`);

  fs.rmSync(target, { recursive: true, force: true });
  const { frontmatter, body } = parseFrontmatter(fs.readFileSync(srcMd, "utf8"));
  const metadata = JSON.parse(fs.readFileSync(path.join(skillSrc, "scripts", "command-metadata.json"), "utf8"));
  const packageJson = JSON.parse(fs.readFileSync(path.join(upstreamRoot, "package.json"), "utf8"));

  const argumentHint = String(frontmatter["argument-hint"] ?? "").replace("{{command_hint}}", commandHint(metadata));
  const head = [
    "---",
    `name: ${frontmatter.name ?? "impeccable"}`,
    `description: ${yamlScalar(frontmatter.description)}`,
    `argument-hint: ${yamlScalar(argumentHint)}`,
    "user-invocable: true",
    `license: ${yamlScalar(frontmatter.license ?? "Apache 2.0")}`,
    `homepage: https://impeccable.style`,
    `version: ${yamlScalar(packageJson.version)}`,
    "---",
  ].join("\n");
  const skillBody = renderMarkdown(body).trimEnd();
  writeFile(path.join(target, "SKILL.md"), `${head}\n\n${skillBody}\n\n${OPENCLAW_ADAPTER}\n`);

  let refs = 0;
  for (const file of fs.readdirSync(path.join(skillSrc, "reference")).filter((f) => f.endsWith(".md")).sort()) {
    const content = fs.readFileSync(path.join(skillSrc, "reference", file), "utf8");
    writeFile(path.join(target, "reference", file), renderMarkdown(content));
    refs++;
  }

  let degraded = 0;
  const agentsDir = path.join(skillSrc, "agents");
  for (const file of fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md")).sort() : []) {
    const { frontmatter: fm, body: agentBody } = parseFrontmatter(fs.readFileSync(path.join(agentsDir, file), "utf8"));
    const role = String(fm.name ?? path.basename(file, ".md")).replace(/^impeccable-/, "");
    const rendered = renderMarkdown(agentBody, { referencePath: ".." }).replace(/^\s+/, "");
    writeFile(path.join(target, "reference", "degraded", `${role}.md`), `${DEGRADED_PREAMBLE}\n\n${rendered}`);
    degraded++;
  }

  let scripts = 0;
  const scriptsDir = path.join(skillSrc, "scripts");
  for (const full of walkFiles(scriptsDir)) {
    const rel = path.relative(scriptsDir, full).split(path.sep).join("/");
    if (rel.startsWith("bin/") || PER_PROJECT_SCRIPT_ARTIFACTS.has(path.basename(rel))) continue;
    let content = fs.readFileSync(full);
    if (rel.endsWith(".cmd")) content = Buffer.from(content.toString("utf8").replace(/\r?\n/g, "\r\n"));
    writeFile(path.join(target, "scripts", rel), content, fs.statSync(full).mode & 0o777);
    scripts++;
  }
  fs.chmodSync(path.join(target, "scripts", "impeccable"), 0o755);

  let commit = "unknown";
  try {
    commit = execFileSync("git", ["-C", upstreamRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {}
  const engineVersion = fs.readFileSync(path.join(scriptsDir, "VERSION"), "utf8").trim();
  const upstream = {
    repository: "https://github.com/pbakaus/impeccable",
    commit,
    skillVersion: packageJson.version,
    engineVersion,
    license: "Apache-2.0",
    generatedBy: "scripts/sync-upstream.mjs",
  };
  writeFile(path.join(packageRoot, "UPSTREAM.json"), `${JSON.stringify(upstream, null, 2)}\n`);

  const leftovers = walkFiles(target)
    .filter((f) => f.endsWith(".md"))
    .filter((f) => /\{\{[a-z_]+\}\}/.test(fs.readFileSync(f, "utf8")));
  if (leftovers.length) {
    throw new Error(`unresolved {{placeholders}} in: ${leftovers.map((f) => path.relative(target, f)).join(", ")}`);
  }
  return { refs, degraded, scripts, upstream };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root) {
    console.error("usage: node scripts/sync-upstream.mjs <path-to-impeccable-checkout>");
    process.exit(2);
  }
  const r = build(path.resolve(root));
  console.log(
    `✓ OpenClaw: impeccable ${r.upstream.skillVersion} (engine ${r.upstream.engineVersion}, ${r.upstream.commit.slice(0, 12)}): ` +
      `${r.refs} references, ${r.degraded} degraded roles, ${r.scripts} script files`,
  );
}
