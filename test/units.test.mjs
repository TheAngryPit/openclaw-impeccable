import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.mjs";
import { editedPaths, parseApplyPatchPaths } from "../src/edits.mjs";
import { engineEnv, parseHookOutput } from "../src/engine.mjs";
import { resolveTarget } from "../src/tools.mjs";
import { assertNoUpstreamMarkup, commandHint, compileProviderBlocks, replacePlaceholders, stripRuleMarkers } from "../scripts/sync-upstream.mjs";

test("apply_patch paths: add, update, move target; deletes skipped", () => {
  const input = [
    "*** Begin Patch",
    "*** Add File: src/new.css",
    "+a",
    "*** Update File: src/old.tsx",
    "*** Move to: src/moved.tsx",
    "@@",
    "-x",
    "+y",
    "*** Update File: index.html",
    "@@",
    "*** Delete File: gone.css",
    "*** End Patch",
  ].join("\n");
  assert.deepEqual(parseApplyPatchPaths(input), ["src/new.css", "src/moved.tsx", "index.html"]);
});

test("editedPaths resolves write/edit/apply_patch against cwd and de-duplicates", () => {
  assert.deepEqual(editedPaths("write", { path: "a/b.css" }, "/w"), ["/w/a/b.css"]);
  assert.deepEqual(editedPaths("edit", { path: "/abs/x.tsx" }, "/w"), ["/abs/x.tsx"]);
  assert.deepEqual(editedPaths("edit", { path: "~/x.css" }, "/w"), [path.join(os.homedir(), "x.css")]);
  assert.deepEqual(editedPaths("edit", { path: "./~/x.css" }, "/w"), ["/w/~/x.css"]);
  assert.deepEqual(
    editedPaths("apply_patch", { input: "*** Update File: a.css\n*** Update File: a.css\n" }, "/w"),
    ["/w/a.css"],
  );
  assert.deepEqual(editedPaths("exec", { command: "x" }, "/w"), []);
  assert.deepEqual(editedPaths("write", {}, "/w"), []);
});

test("parseHookOutput reads Codex PostToolUse and Stop shapes", () => {
  assert.deepEqual(
    parseHookOutput(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: " found " } })),
    { additionalContext: "found", block: undefined },
  );
  assert.deepEqual(parseHookOutput(JSON.stringify({ decision: "block", reason: "fix it" })), {
    additionalContext: undefined,
    block: "fix it",
  });
  assert.deepEqual(parseHookOutput(""), {});
  assert.deepEqual(parseHookOutput("not json"), {});
});

test("engineEnv pins provider id, drops probe flag, applies engineBin", () => {
  const env = engineEnv({ engineBin: "/opt/imp", base: { IMPECCABLE_LAUNCHER_PROBE: "1", PATH: "/bin" } });
  assert.equal(env.IMPECCABLE_PROVIDER_ID, "openclaw");
  assert.equal(env.IMPECCABLE_BIN, "/opt/imp");
  assert.equal(env.IMPECCABLE_LAUNCHER_PROBE, undefined);
  assert.equal(env.PATH, "/bin");
});

test("resolveConfig fills defaults and keeps operator values", () => {
  const c = resolveConfig({});
  assert.deepEqual({ ...c.gate }, { perEdit: true, onFinish: true, maxRevisions: 1 });
  assert.equal(c.tools, true);
  assert.equal(c.editTimeoutMs, 5000);
  assert.equal(resolveConfig({ gate: { maxRevisions: 3 } }).gate.maxRevisions, 3);
  assert.equal(resolveConfig({ gate: { onFinish: false } }).gate.onFinish, false);
  assert.equal(resolveConfig({ engineBin: "" }).engineBin, undefined);
});

test("resolveTarget keeps paths inside the workspace and allows http(s) only", () => {
  assert.equal(resolveTarget("src/a.css", "/w"), "/w/src/a.css");
  assert.equal(resolveTarget("https://example.test/", "/w"), "https://example.test/");
  assert.throws(() => resolveTarget("../etc/passwd", "/w"), /outside the workspace/);
  assert.throws(() => resolveTarget("/etc/passwd", "/w"), /outside the workspace/);
  assert.throws(() => resolveTarget("file:///etc/passwd", "/w"), /unsupported/);
});

test("sync transforms: provider blocks, rule markers, placeholders", () => {
  const src = "A\n<codex>\nCodex only\n</codex>\n<claude-code>\nClaude only\n</claude-code>\n<custom>\nkept\n</custom>\nB";
  // Same output as upstream's compileProviderBlocks: a dropped block keeps its leading newline.
  assert.equal(compileProviderBlocks(src, ["openclaw"]), "A\n\n<custom>\nkept\n</custom>\nB");
  assert.equal(compileProviderBlocks("<codex>\nx\n</codex>", ["codex"]), "x");
  assert.equal(stripRuleMarkers("Do it. <!-- rule:skill-x -->"), "Do it.");
  const out = replacePlaceholders("Run {{scripts_path}}/impeccable via {{command_prefix}}impeccable. {{ask_instruction}}");
  assert.match(out, /^Run \{baseDir\}\/scripts\/impeccable via \/impeccable\. Ask with the `ask_user` tool/);
  assert.equal(
    commandHint({ shape: {}, audit: {}, critique: {}, polish: {}, init: {} }),
    "shape · audit|critique · polish · init",
  );
});

test("sync rejects a harness block it does not know, and accepts known markup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "impeccable-sync-"));
  fs.writeFileSync(path.join(dir, "ok.md"), "Intro\n<picture>\n<img src=a>\n</picture>\nEnd\n");
  assert.doesNotThrow(() => assertNoUpstreamMarkup(dir));
  fs.writeFileSync(path.join(dir, "new-harness.md"), "Intro\n<zed>\nZed-only steps\n</zed>\nEnd\n");
  assert.throws(() => assertNoUpstreamMarkup(dir), /new-harness\.md: <zed> block survived/);
  fs.writeFileSync(path.join(dir, "new-harness.md"), "Run {{scripts_path}}/impeccable\n");
  assert.throws(() => assertNoUpstreamMarkup(dir), /unresolved \{\{placeholder\}\}/);
});
