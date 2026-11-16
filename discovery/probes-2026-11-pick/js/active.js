(() => { const g = globalThis; const ed = g.__pickRun?.command?.editor ?? g.__pickEd; const ex = ed.executor; const a = ex.active;
  const show = v => v?.constructor?.name ?? String(v);
  return { active: a && Object.fromEntries(Object.entries(a).map(([k, v]) => [k, show(v)])), csm: Object.fromEntries(Object.entries(ex.commandForSelection).map(([k, v]) => [k, show(v)])), csmProto: Object.getOwnPropertyNames(Object.getPrototypeOf(ex.commandForSelection)), exProto: Object.getOwnPropertyNames(Object.getPrototypeOf(ex)), sel: { faces: ed.selection.selected.faces.size } }; })()
