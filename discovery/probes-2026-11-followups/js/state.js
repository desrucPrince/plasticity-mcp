function () {
  let bodies = 0;
  for (const [versionId] of nativeApi.geo.geometryModel) if (!nativeApi.geo.automatics.has(versionId)) bodies += 1;
  return { undo: this.history.undoStack.length, redo: this.history.redoStack.length, bodies, busy: !!this.executor.isBusy, active: this.executor.active?.command?.constructor?.name ?? null };
}
