async function (args) {
  const g = globalThis; const ed = this;
  let bodies = 0; for (const [v] of nativeApi.geo.geometryModel) if (!nativeApi.geo.automatics.has(v)) bodies++;
  return { undo: ed.history.undoStack.length, redo: ed.history.redoStack.length, bodies, busy: !!ed.executor.isBusy,
    instrumented: !!g.__pickOrig, log: (g.__pickLog ?? []).slice(args.from ?? 0), objs: Object.fromEntries(Object.entries(g.__pickObjs ?? {}).map(([k, v]) => [k, v.length])),
    executorKeys: Object.keys(ed.executor), activeCmd: ed.executor.active?.constructor?.name ?? null };
}
