import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "../src/config.mjs";
import { REVISE_INSTRUCTION, createDesignGate } from "../src/gate.mjs";

const ready = async () => ({ ok: true, version: "0.1.27" });
const missing = async () => ({ ok: false });

function fakeRun(responses) {
  const calls = [];
  const run = async (args, opts) => {
    const event = JSON.parse(opts.input);
    calls.push({ args, event, env: opts.env, timeoutMs: opts.timeoutMs });
    const stdout = responses(event) ?? "";
    return { ok: true, code: 0, stdout, stderr: "" };
  };
  return { run, calls };
}

const toolEvent = (over = {}) => ({
  toolCallId: "t1",
  toolName: "write",
  args: { path: "src/App.tsx" },
  cwd: "/proj",
  result: { content: [{ type: "text", text: "wrote 10 lines" }] },
  ...over,
});

test("per-edit: findings are appended to the tool result the model reads", async () => {
  const { run, calls } = fakeRun((e) =>
    e.hook_event_name === "PostToolUse"
      ? JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "[impeccable] gradient-text at App.tsx:4" } })
      : "",
  );
  const gate = createDesignGate({ config: resolveConfig({}), engineFor: ready, run });
  const out = await gate.toolResultMiddleware(toolEvent(), { sessionId: "s1", runtime: "openclaw" });
  assert.equal(out.result.content.length, 2);
  assert.equal(out.result.content[0].text, "wrote 10 lines");
  assert.match(out.result.content[1].text, /gradient-text/);
  assert.deepEqual(calls[0].args, ["hook"]);
  assert.deepEqual(calls[0].event, {
    hook_event_name: "PostToolUse",
    session_id: "s1",
    cwd: "/proj",
    tool_name: "Write",
    tool_input: { file_path: "/proj/src/App.tsx" },
  });
  assert.equal(calls[0].env.IMPECCABLE_HOOK_HARNESS, "codex");
  assert.equal(calls[0].env.IMPECCABLE_PROVIDER_ID, "openclaw");
  assert.equal(calls[0].timeoutMs, 5000);
});

test("per-edit: silent engine, errors, non-edit tools and missing engine leave the result alone", async () => {
  const { run, calls } = fakeRun(() => "");
  const gate = createDesignGate({ config: resolveConfig({}), engineFor: ready, run });
  assert.equal(await gate.toolResultMiddleware(toolEvent(), { sessionId: "s" }), undefined);
  assert.equal(await gate.toolResultMiddleware(toolEvent({ isError: true }), {}), undefined);
  assert.equal(await gate.toolResultMiddleware(toolEvent({ toolName: "exec", args: { command: "ls" } }), {}), undefined);
  assert.equal(calls.length, 1);

  const offline = createDesignGate({ config: resolveConfig({}), engineFor: missing, run });
  assert.equal(await offline.toolResultMiddleware(toolEvent(), { sessionId: "s" }), undefined);
  assert.equal(calls.length, 1);
});

test("per-edit: a throwing engine fails open", async () => {
  const gate = createDesignGate({
    config: resolveConfig({}),
    engineFor: ready,
    run: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(await gate.toolResultMiddleware(toolEvent(), { sessionId: "s" }), undefined);
});

test("apply_patch sends one event per written file", async () => {
  const { run, calls } = fakeRun(() => "");
  const gate = createDesignGate({ config: resolveConfig({}), engineFor: ready, run });
  await gate.toolResultMiddleware(
    toolEvent({ toolName: "apply_patch", args: { input: "*** Add File: a.css\n*** Update File: b.html\n*** Delete File: c.css\n" } }),
    { sessionId: "s" },
  );
  assert.deepEqual(
    calls.map((c) => c.event.tool_input.file_path),
    ["/proj/a.css", "/proj/b.html"],
  );
});

const blockingStop = () =>
  fakeRun((e) =>
    e.hook_event_name === "Stop" ? JSON.stringify({ decision: "block", reason: "2 design findings: low-contrast, nested-cards" }) : "",
  );

test("finish: a run without edits never starts the engine", async () => {
  const { run, calls } = blockingStop();
  const gate = createDesignGate({ config: resolveConfig({}), engineFor: ready, run });
  assert.equal(await gate.beforeAgentFinalize({ sessionId: "s1", stopHookActive: false }, {}), undefined);
  assert.equal(calls.length, 0);
});

test("finish: findings after an edit request a bounded revision with the Stop event the engine expects", async () => {
  const { run, calls } = blockingStop();
  const gate = createDesignGate({ config: resolveConfig({ gate: { maxRevisions: 2 } }), engineFor: ready, run });
  await gate.toolResultMiddleware(toolEvent(), { sessionId: "s1" });
  const decision = await gate.beforeAgentFinalize(
    { sessionId: "s1", turnId: "t9", cwd: "/proj", stopHookActive: false },
    { workspaceDir: "/proj" },
  );
  assert.equal(decision.action, "revise");
  assert.match(decision.reason, /low-contrast/);
  assert.deepEqual(decision.retry, {
    instruction: REVISE_INSTRUCTION,
    idempotencyKey: "impeccable:design-gate:s1",
    maxAttempts: 2,
  });
  const stop = calls.find((c) => c.event.hook_event_name === "Stop");
  assert.deepEqual(stop.event, { hook_event_name: "Stop", session_id: "s1", turn_id: "t9", cwd: "/proj", stop_hook_active: false });
  assert.equal(stop.timeoutMs, 30000);
});

test("finish: finishing again without new edits does not re-run the deep pass", async () => {
  const { run, calls } = blockingStop();
  const gate = createDesignGate({ config: resolveConfig({}), engineFor: ready, run });
  await gate.toolResultMiddleware(toolEvent(), { sessionId: "s1" });
  await gate.beforeAgentFinalize({ sessionId: "s1", cwd: "/proj", stopHookActive: false }, {});
  assert.equal(await gate.beforeAgentFinalize({ sessionId: "s1", stopHookActive: true }, {}), undefined);
  assert.equal(calls.filter((c) => c.event.hook_event_name === "Stop").length, 1);
});

test("finish: a clean deep pass lets the run finish", async () => {
  const { run } = fakeRun(() => "");
  const gate = createDesignGate({ config: resolveConfig({}), engineFor: ready, run });
  await gate.toolResultMiddleware(toolEvent(), { sessionId: "s2" });
  assert.equal(await gate.beforeAgentFinalize({ sessionId: "s2", cwd: "/proj" }, {}), undefined);
});

test("finish: onFinish=false never runs the deep pass", async () => {
  const { run, calls } = blockingStop();
  const gate = createDesignGate({ config: resolveConfig({ gate: { onFinish: false } }), engineFor: ready, run });
  await gate.toolResultMiddleware(toolEvent(), { sessionId: "s3" });
  assert.equal(await gate.beforeAgentFinalize({ sessionId: "s3", cwd: "/proj" }, {}), undefined);
  assert.equal(calls.filter((c) => c.event.hook_event_name === "Stop").length, 0);
});

test("finish: session matched by sessionKey when ids differ between hooks", async () => {
  const { run } = fakeRun((e) => (e.hook_event_name === "Stop" ? JSON.stringify({ decision: "block", reason: "x" }) : ""));
  const gate = createDesignGate({ config: resolveConfig({}), engineFor: ready, run });
  await gate.toolResultMiddleware(toolEvent(), { sessionKey: "agent:main:main" });
  const d = await gate.beforeAgentFinalize({ sessionId: "other", sessionKey: "agent:main:main", cwd: "/proj" }, {});
  assert.equal(d?.action, "revise");
});

test("per-edit off still arms the deep pass", async () => {
  const { run, calls } = fakeRun((e) => (e.hook_event_name === "Stop" ? JSON.stringify({ decision: "block", reason: "x" }) : ""));
  const gate = createDesignGate({ config: resolveConfig({ gate: { perEdit: false } }), engineFor: ready, run });
  assert.equal(await gate.toolResultMiddleware(toolEvent(), { sessionId: "s4" }), undefined);
  assert.equal(calls.length, 0);
  assert.equal((await gate.beforeAgentFinalize({ sessionId: "s4", cwd: "/proj" }, {}))?.action, "revise");
});

test("native OpenClaw: cwd derived from absolute args.path when event.cwd is absent", async () => {
  const { run, calls } = fakeRun((e) =>
    e.hook_event_name === "PostToolUse"
      ? JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "[impeccable] low-contrast at App.tsx:1" } })
      : "",
  );
  const gate = createDesignGate({ config: resolveConfig({}), engineFor: ready, run });
  // No event.cwd; absolute args.path; native OpenClaw shape
  const out = await gate.toolResultMiddleware(
    { toolCallId: "t9", toolName: "write", args: { path: "/proj/src/App.tsx" }, result: { content: [] } },
    { sessionId: "native1" },
  );
  assert.ok(out, "result was modified");
  assert.match(out.result.content[0].text, /low-contrast/);
  assert.equal(calls[0].event.cwd, "/proj/src");
});

test("native OpenClaw: session marked via args.path cwd so deep pass fires", async () => {
  const { run } = fakeRun((e) =>
    e.hook_event_name === "Stop" ? JSON.stringify({ decision: "block", reason: "x" }) : "",
  );
  const gate = createDesignGate({ config: resolveConfig({}), engineFor: ready, run });
  // toolResultMiddleware with no event.cwd must still markEdited
  await gate.toolResultMiddleware(
    { toolCallId: "ta", toolName: "write", args: { path: "/proj/src/App.tsx" }, result: { content: [] } },
    { sessionId: "native2" },
  );
  const d = await gate.beforeAgentFinalize({ sessionId: "native2", stopHookActive: false }, {});
  assert.equal(d?.action, "revise");
});

test("native OpenClaw: relative args.path without cwd fails open (returns undefined)", async () => {
  const { run, calls } = fakeRun(() => "");
  const gate = createDesignGate({ config: resolveConfig({}), engineFor: ready, run });
  const out = await gate.toolResultMiddleware(
    { toolCallId: "tb", toolName: "write", args: { path: "src/App.tsx" }, result: { content: [] } },
    { sessionId: "native3" },
  );
  assert.equal(out, undefined);
  assert.equal(calls.length, 0);
});

test("per-edit harness: codex (tiered, deep pass on) unless onFinish is off, then cursor (full rule set)", async () => {
  const { run, calls } = fakeRun(() => "");
  const on = createDesignGate({ config: resolveConfig({}), engineFor: ready, run });
  await on.toolResultMiddleware(toolEvent(), { sessionId: "h1" });
  assert.equal(calls.at(-1).env.IMPECCABLE_HOOK_HARNESS, "codex");

  const off = createDesignGate({ config: resolveConfig({ gate: { onFinish: false } }), engineFor: ready, run });
  await off.toolResultMiddleware(toolEvent(), { sessionId: "h2" });
  assert.equal(calls.at(-1).env.IMPECCABLE_HOOK_HARNESS, "cursor");
});

test("per-edit: Cursor-shaped engine output is appended too", async () => {
  const { run } = fakeRun(() => JSON.stringify({ additional_context: "[impeccable] side-tab at L1" }));
  const gate = createDesignGate({ config: resolveConfig({ gate: { onFinish: false } }), engineFor: ready, run });
  const out = await gate.toolResultMiddleware(toolEvent(), { sessionId: "h3" });
  assert.match(out.result.content[1].text, /side-tab/);
});
