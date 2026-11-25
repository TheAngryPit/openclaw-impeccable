import { EDIT_TOOLS, editedPaths } from "./edits.mjs";
import { engineEnv, parseHookOutput, runEngine } from "./engine.mjs";

const TOOL_EVENT_NAME = { write: "Write", edit: "Edit", apply_patch: "Edit" };
const PENDING_MAX = 512;
const PENDING_TTL_MS = 6 * 60 * 60 * 1000;

export const REVISE_INSTRUCTION =
  "Triage the Impeccable design findings above as their instructions say (fix real problems; persist the narrowest ignore for a confident false positive and disclose it), then finish and state what you fixed, suppressed, or left standing.";

function sessionIdentity({ sessionId, sessionKey, runId } = {}) {
  return sessionId || sessionKey || runId || undefined;
}

export function createDesignGate({ config, engineFor, run = runEngine, logger, now = Date.now }) {
  const pending = new Map();

  function markPending(id, cwd) {
    pending.delete(id);
    pending.set(id, { cwd, at: now() });
    if (pending.size > PENDING_MAX) pending.delete(pending.keys().next().value);
  }

  function takePending(ids) {
    for (const id of ids) {
      const entry = id && pending.get(id);
      if (!entry) continue;
      for (const other of ids) if (other) pending.delete(other);
      return now() - entry.at > PENDING_TTL_MS ? undefined : entry;
    }
    return undefined;
  }

  // With the deep pass on, the engine defers non-immediate rules from the
  // per-edit pass to Stop (Codex contract). Without it, per-edit must report
  // the full rule set, as upstream does for Cursor, which has no deep pass.
  const perEditHarness = config.gate.onFinish ? "codex" : "cursor";

  async function hook(engine, event, cwd, timeoutMs, harness = "codex") {
    const r = await run(["hook"], {
      launcher: engine.install?.launcher,
      cwd,
      input: JSON.stringify(event),
      env: engineEnv({ engineBin: config.engineBin, install: engine.install, extra: { IMPECCABLE_HOOK_HARNESS: harness } }),
      timeoutMs,
    });
    if (r.error) logger?.debug?.(`impeccable: hook ${event.hook_event_name} skipped: ${r.error}`);
    return parseHookOutput(r.stdout);
  }

  async function toolResultMiddleware(event, ctx = {}) {
    try {
      if (!config.gate.perEdit && !config.gate.onFinish) return;
      if (event.isError || !EDIT_TOOLS.includes(event.toolName)) return;
      const cwd = event.cwd?.trim();
      if (!cwd) return;
      const paths = editedPaths(event.toolName, event.args, cwd);
      if (paths.length === 0) return;
      const session = sessionIdentity(ctx);
      if (session) {
        markPending(session, cwd);
        if (ctx.sessionKey && ctx.sessionKey !== session) markPending(ctx.sessionKey, cwd);
      }
      if (!config.gate.perEdit) return;
      const engine = await engineFor(cwd);
      if (!engine.ok) return;

      const texts = [];
      for (const filePath of paths) {
        const out = await hook(
          engine,
          {
            hook_event_name: "PostToolUse",
            ...(session ? { session_id: session } : {}),
            cwd,
            tool_name: TOOL_EVENT_NAME[event.toolName],
            tool_input: { file_path: filePath },
          },
          cwd,
          config.editTimeoutMs,
          perEditHarness,
        );
        if (out.additionalContext) texts.push(out.additionalContext);
      }
      if (texts.length === 0) return;
      const content = Array.isArray(event.result?.content) ? event.result.content : [];
      return {
        result: {
          ...event.result,
          content: [...content, { type: "text", text: texts.join("\n\n") }],
        },
      };
    } catch (error) {
      logger?.warn?.(`impeccable: per-edit pass failed open: ${error?.message ?? error}`);
      return;
    }
  }

  async function beforeAgentFinalize(event, ctx = {}) {
    try {
      if (!config.gate.onFinish) return;
      const ids = [event.sessionId, ctx.sessionId, event.sessionKey, ctx.sessionKey, event.runId, ctx.runId];
      const entry = takePending(ids);
      if (!entry) return;
      const session = sessionIdentity({ sessionId: event.sessionId ?? ctx.sessionId, sessionKey: event.sessionKey ?? ctx.sessionKey, runId: event.runId });
      const cwd = event.cwd?.trim() || ctx.workspaceDir || entry.cwd;
      const engine = await engineFor(cwd);
      if (!engine.ok) return;
      const out = await hook(
        engine,
        {
          hook_event_name: "Stop",
          ...(session ? { session_id: session } : {}),
          ...(event.turnId ? { turn_id: event.turnId } : {}),
          cwd,
          stop_hook_active: Boolean(event.stopHookActive),
        },
        cwd,
        config.stopTimeoutMs,
      );
      const findings = out.block ?? out.additionalContext;
      if (!findings) return;
      return {
        action: "revise",
        reason: findings,
        retry: {
          instruction: REVISE_INSTRUCTION,
          idempotencyKey: `impeccable:design-gate:${session ?? "run"}`,
          maxAttempts: config.gate.maxRevisions,
        },
      };
    } catch (error) {
      logger?.warn?.(`impeccable: deep pass failed open: ${error?.message ?? error}`);
      return;
    }
  }

  return { toolResultMiddleware, beforeAgentFinalize, _pending: pending };
}
