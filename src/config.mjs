// Resolved plugin settings. The manifest's configSchema validates input; this
// fills defaults and clamps, so the runtime never sees an undefined knob.

const clampInt = (value, min, max, fallback) =>
  Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;

export function resolveConfig(raw = {}) {
  const gate = raw.gate ?? {};
  return Object.freeze({
    gate: Object.freeze({
      perEdit: gate.perEdit !== false,
      onFinish: gate.onFinish !== false,
      maxRevisions: clampInt(gate.maxRevisions, 1, 3, 1),
    }),
    tools: raw.tools !== false,
    install: raw.install === "bundled" ? "bundled" : "auto",
    trustProjectInstalls: raw.trustProjectInstalls === true,
    engineBin: typeof raw.engineBin === "string" && raw.engineBin.trim() ? raw.engineBin.trim() : undefined,
    editTimeoutMs: clampInt(raw.editTimeoutMs, 1000, 30_000, 5000),
    stopTimeoutMs: clampInt(raw.stopTimeoutMs, 1000, 120_000, 30_000),
  });
}
