import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import plugin from "../index.mjs";
import { createEngineProbe, runEngine, engineEnv } from "../src/engine.mjs";

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "impeccable-it-home-"));
delete process.env.OPENCLAW_STATE_DIR;

const FAKE_ENGINE = `#!/bin/sh
case "$1" in
  engine-probe) echo "impeccable-engine 9.9.9-fake"; exit 0 ;;
  hook)
    input=$(cat)
    case "$input" in
      *'"Stop"'*) printf '{"decision":"block","reason":"fake deep pass: %s"}' "$IMPECCABLE_HOOK_HARNESS" ;;
      *) printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"fake finding (%s)"}}' "$IMPECCABLE_PROVIDER_ID" ;;
    esac ;;
  context) echo "PRODUCT.md: loaded (target=$3)" ;;
  detect) echo '[{"antipattern":"gradient-text","file":"x.css","line":1}]'; exit 2 ;;
  *) echo "unknown verb $1" >&2; exit 64 ;;
esac
`;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "impeccable-oc-"));
  const bin = path.join(dir, "impeccable-fake");
  fs.writeFileSync(bin, FAKE_ENGINE, { mode: 0o755 });
  const workspace = path.join(dir, "ws");
  fs.mkdirSync(workspace);
  return { dir, bin, workspace };
}

function fakeApi(config) {
  const reg = { tools: [], middleware: [], hooks: [], cli: [] };
  return {
    reg,
    api: {
      pluginConfig: config,
      logger: { debug() {}, warn() {} },
      registerTool: (factory, opts) => reg.tools.push({ factory, opts }),
      registerAgentToolResultMiddleware: (fn, opts) => reg.middleware.push({ fn, opts }),
      on: (name, fn, opts) => reg.hooks.push({ name, fn, opts }),
      registerCli: (fn, opts) => reg.cli.push({ fn, opts }),
    },
  };
}

test("launcher probe resolves engineBin without downloading", async () => {
  const { bin } = setup();
  const probe = createEngineProbe({ engineBin: bin });
  assert.deepEqual(
    { ...(await probe()), at: 0 },
    { ok: true, version: "9.9.9-fake", at: 0 },
  );
});

test("probe reports missing engine when nothing resolves (no network used)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "impeccable-home-"));
  const r = await runEngine(["engine-probe"], {
    env: { ...engineEnv({ base: { PATH: "/usr/bin:/bin", HOME: home } }), IMPECCABLE_HOME: home, IMPECCABLE_LAUNCHER_PROBE: "1" },
    timeoutMs: 10_000,
  });
  assert.equal(r.code, 127);
  assert.equal(fs.existsSync(path.join(home, "bin")), false, "probe mode must not create the download cache");
});

test("registered plugin: middleware, finalize, tools and CLI work end to end", async () => {
  const { bin, workspace } = setup();
  const { api, reg } = fakeApi({ engineBin: bin });
  plugin.register(api);

  assert.deepEqual(reg.tools.map((t) => t.opts.name).sort(), ["impeccable_context", "impeccable_detect"]);
  assert.deepEqual(reg.middleware[0].opts, { matcher: ["write", "edit", "apply_patch"] });
  assert.equal(reg.hooks[0].name, "before_agent_finalize");
  assert.equal(reg.hooks[0].opts.timeoutMs, 35000);
  assert.equal(reg.cli[0].opts.descriptors[0].name, "impeccable");

  const edited = await reg.middleware[0].fn(
    { toolCallId: "1", toolName: "edit", args: { path: "a.css" }, cwd: workspace, result: { content: [] } },
    { sessionId: "S", runtime: "openclaw" },
  );
  assert.equal(edited.result.content[0].text, "fake finding (openclaw)");

  const decision = await reg.hooks[0].fn({ sessionId: "S", cwd: workspace, stopHookActive: false }, {});
  assert.equal(decision.action, "revise");
  assert.equal(decision.reason, "fake deep pass: codex");

  const byName = Object.fromEntries(reg.tools.map((t) => [t.opts.name, t.factory({ workspaceDir: workspace })]));
  const ctx = await byName.impeccable_context.execute("c", { target: "src/page.tsx" });
  assert.match(ctx.content[0].text, new RegExp(`target=${workspace}/src/page.tsx`));
  assert.equal(ctx.details.available, true);

  const det = await byName.impeccable_detect.execute("d", { targets: ["."] });
  assert.equal(det.details.exitCode, 2);
  assert.equal(det.details.findings, 1);
  assert.match(det.content[0].text, /gradient-text/);

  await assert.rejects(byName.impeccable_detect.execute("d", { targets: ["../../etc"] }), /outside the workspace/);
});

test("gate and tools can be switched off", () => {
  const { api, reg } = fakeApi({ tools: false, gate: { perEdit: false, onFinish: false } });
  plugin.register(api);
  assert.equal(reg.tools.length, 0);
  assert.equal(reg.middleware.length, 0);
  assert.equal(reg.hooks.length, 0);
  assert.equal(reg.cli.length, 1);
});
