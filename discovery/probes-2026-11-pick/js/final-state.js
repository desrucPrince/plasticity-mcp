async function (args) {
  const ed = this; const g = globalThis;
  let bodies = 0; for (const [v] of nativeApi.geo.geometryModel) if (!nativeApi.geo.automatics.has(v)) bodies++;
  return { undo: ed.history.undoStack.length, redo: ed.history.redoStack.length, bodies, isBusy: !!ed.executor.isBusy, active: ed.executor.active?.command?.constructor?.name ?? null,
    spaceInput: !!document.querySelector('input.z-space-input-focused'), selected: ed.selection.selected.faces.size + ed.selection.selected.solids.size + ed.selection.selected.curves.size, hits: ed.selection.hits.hits.size,
    probeGlobals: Object.keys(g).filter(k => k.startsWith('__pick')), selectionMode: Array.from(ed.selection.mode), cameraFinite: Array.from(ed.viewports)[0].camera.position.toArray().every(Number.isFinite) };
}
