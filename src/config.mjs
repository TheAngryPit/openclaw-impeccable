export function resolveConfig(raw = {}) {
  const gate = raw.gate ?? {};
  return Object.freeze({
    gate: Object.freeze({
      perEdit: gate.perEdit ?? true,
      onFinish: gate.onFinish ?? true,
      maxRevisions: gate.maxRevisions ?? 1,
    }),
    tools: raw.tools ?? true,
    install: raw.install ?? "auto",
    trustProjectInstalls: raw.trustProjectInstalls ?? false,
    engineBin: raw.engineBin || undefined,
    editTimeoutMs: raw.editTimeoutMs ?? 5000,
    stopTimeoutMs: raw.stopTimeoutMs ?? 30_000,
  });
}
