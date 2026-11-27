import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.mjs";
import { SKILL_DIR, createEngineProbe } from "../src/engine.mjs";
import {
  createEngineSelector,
  createInstallResolver,
  describeSkew,
  discoverInstalls,
  readSkillVersion,
  selectInstall,
} from "../src/installs.mjs";

function fakeInstall(dir, { name, version = "4.12.0", enginePin = "0.1.30", frontmatter = "claude", ready = true } = {}) {
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  const fm =
    frontmatter === "codex"
      ? `---\nname: impeccable\ndescription: x\nmetadata:\n  version: ${version}\n---\n`
      : `---\nname: impeccable\ndescription: x\nversion: ${version}\n---\n`;
  fs.writeFileSync(path.join(dir, "SKILL.md"), `${fm}body\n`);
  fs.writeFileSync(path.join(dir, "scripts", "VERSION"), `${enginePin}\n`);
  fs.writeFileSync(
    path.join(dir, "scripts", "impeccable"),
    `#!/bin/sh
case "$1" in
  engine-probe) ${ready ? `echo "impeccable-engine ${enginePin}"` : "exit 127"} ;;
  hook) cat >/dev/null; printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"from ${name} skill=%s"}}' "$IMPECCABLE_SKILL_DIR" ;;
  context) echo "context from ${name}" ;;
  *) exit 64 ;;
esac
`,
    { mode: 0o755 },
  );
  return dir;
}

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impeccable-coexist-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "ws");
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  // Default OpenClaw state for this fake home, so ~/.agents/skills is in scope.
  const env = { HOME: home };
  return { root, home, workspace, env };
}

test("readSkillVersion reads Claude and Codex frontmatter styles", () => {
  const { root } = sandbox();
  fakeInstall(path.join(root, "a"), { version: "4.11.0" });
  fakeInstall(path.join(root, "b"), { version: "4.12.1", frontmatter: "codex" });
  assert.equal(readSkillVersion(path.join(root, "a", "SKILL.md")), "4.11.0");
  assert.equal(readSkillVersion(path.join(root, "b", "SKILL.md")), "4.12.1");
  assert.equal(readSkillVersion(path.join(SKILL_DIR, "SKILL.md")), "4.11.1");
});

test("discoverInstalls follows OpenClaw skill precedence and ends with the plugin copy", () => {
  const { home, workspace, env } = sandbox();
  fakeInstall(path.join(home, ".agents", "skills", "impeccable"), { name: "user" });
  fakeInstall(path.join(workspace, ".agents", "skills", "impeccable"), { name: "project" });
  fakeInstall(path.join(workspace, "skills", "impeccable"), { name: "workspace" });
  fakeInstall(path.join(home, ".openclaw", "skills", "impeccable"), { name: "managed" });
  const scopes = discoverInstalls({ workspaceDir: workspace, home, env }).map((i) => i.scope);
  assert.deepEqual(scopes, ["workspace", "project", "user", "managed", "plugin"]);
});

test("~/.agents/skills is ignored when OPENCLAW_STATE_DIR is not the default", () => {
  const { root, home, env } = sandbox();
  fakeInstall(path.join(home, ".agents", "skills", "impeccable"), { name: "user" });
  const scopes = discoverInstalls({ home, env: { ...env, OPENCLAW_STATE_DIR: path.join(root, "state") } }).map((i) => i.scope);
  assert.deepEqual(scopes, ["plugin"]);
});

test("selectInstall: a user install runs its own launcher; a project install needs trust", () => {
  const { home, workspace, env } = sandbox();
  fakeInstall(path.join(home, ".agents", "skills", "impeccable"), { name: "user" });
  let sel = selectInstall(discoverInstalls({ workspaceDir: workspace, home, env }), resolveConfig({}));
  assert.equal(sel.served.scope, "user");
  assert.equal(sel.engineInstall.scope, "user");

  fakeInstall(path.join(workspace, ".agents", "skills", "impeccable"), { name: "project" });
  const installs = discoverInstalls({ workspaceDir: workspace, home, env });
  sel = selectInstall(installs, resolveConfig({}));
  assert.equal(sel.served.scope, "project");
  assert.equal(sel.engineInstall.scope, "plugin");
  assert.match(sel.reason, /trustProjectInstalls/);

  sel = selectInstall(installs, resolveConfig({ trustProjectInstalls: true }));
  assert.equal(sel.engineInstall.scope, "project");

  sel = selectInstall(installs, resolveConfig({ install: "bundled" }));
  assert.equal(sel.engineInstall.scope, "plugin");
  assert.equal(sel.served.scope, "project", "bundled mode cannot change which copy OpenClaw serves");
});

test("describeSkew flags a served skill whose engine pin differs from the engine in use", () => {
  const served = { scope: "project", skillVersion: "4.12.0", enginePin: "0.1.30" };
  assert.match(describeSkew({ served, engineInstall: { scope: "plugin", enginePin: "0.1.27" } }), /pins engine 0\.1\.30.*engine 0\.1\.27/);
  assert.equal(describeSkew({ served, engineInstall: served }), undefined);
});

test("engine selector falls back to the bundled launcher when the served copy's engine is missing", async () => {
  const { home, workspace, env } = sandbox();
  fakeInstall(path.join(home, ".agents", "skills", "impeccable"), { name: "user", ready: false });
  const config = resolveConfig({});
  const probe = createEngineProbe({
    run: async (_args, opts) =>
      opts.launcher.startsWith(SKILL_DIR)
        ? { ok: true, code: 0, stdout: "impeccable-engine 0.1.27", stderr: "" }
        : { ok: false, code: 127, stdout: "", stderr: "missing" },
  });
  const engineFor = createEngineSelector({ config, probe, resolveFor: createInstallResolver({ config, home, env }) });
  const r = await engineFor(workspace);
  assert.equal(r.ok, true);
  assert.equal(r.install.scope, "plugin");
  assert.equal(r.selection.served.scope, "user");
});

test("plugin wiring: the gate and tools run the served user install's launcher", async () => {
  const { home, workspace } = sandbox();
  const userSkill = fakeInstall(path.join(home, ".agents", "skills", "impeccable"), { name: "user" });
  const saved = { HOME: process.env.HOME, OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR };
  process.env.HOME = home;
  delete process.env.OPENCLAW_STATE_DIR;
  try {
    const { default: plugin } = await import("../index.mjs");
    const reg = { tools: [], middleware: [], hooks: [] };
    plugin.register({
      pluginConfig: {},
      logger: {},
      registerTool: (factory, opts) => reg.tools.push({ factory, opts }),
      registerAgentToolResultMiddleware: (fn) => reg.middleware.push(fn),
      on: (_n, fn) => reg.hooks.push(fn),
      registerCli: () => {},
    });
    const out = await reg.middleware[0](
      { toolCallId: "1", toolName: "write", args: { path: "a.css" }, cwd: workspace, result: { content: [] } },
      { sessionId: "S" },
    );
    assert.equal(out.result.content[0].text, `from user skill=${userSkill}`);

    const ctxTool = reg.tools.find((t) => t.opts.name === "impeccable_context").factory({ workspaceDir: workspace });
    const res = await ctxTool.execute("c", {});
    assert.match(res.content[0].text, /served from the user install/);
    assert.match(res.content[0].text, /context from user/);
    assert.equal(res.details.servedFrom, "user");
    assert.equal(res.details.engineFrom, "user");
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});

test("plugin wiring: an untrusted project launcher is never executed", async () => {
  const { home, workspace } = sandbox();
  const marker = path.join(workspace, "PROJECT_LAUNCHER_RAN");
  const projectSkill = fakeInstall(path.join(workspace, ".agents", "skills", "impeccable"), { name: "project" });
  fs.writeFileSync(path.join(projectSkill, "scripts", "impeccable"), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
  const config = resolveConfig({});
  const calls = [];
  const probe = createEngineProbe({
    run: async (_args, opts) => {
      calls.push(opts.launcher);
      return { ok: true, code: 0, stdout: "impeccable-engine 0.1.27", stderr: "" };
    },
  });
  const engineFor = createEngineSelector({ config, probe, resolveFor: createInstallResolver({ config, home, env: { HOME: home } }) });
  const r = await engineFor(workspace);
  assert.equal(r.install.scope, "plugin");
  assert.equal(r.selection.served.scope, "project");
  assert.ok(calls.every((l) => l.startsWith(SKILL_DIR)));
  assert.equal(fs.existsSync(marker), false);
});

test("install: bundled runs the plugin's launcher even when a trusted user install is served", () => {
  const { home, workspace, env } = sandbox();
  fakeInstall(path.join(home, ".agents", "skills", "impeccable"), { name: "user" });
  const installs = discoverInstalls({ workspaceDir: workspace, home, env });
  const sel = selectInstall(installs, resolveConfig({ install: "bundled" }));
  assert.equal(sel.served.scope, "user");
  assert.equal(sel.engineInstall.scope, "plugin");
  assert.equal(selectInstall(installs, resolveConfig({})).engineInstall.scope, "user");
});
