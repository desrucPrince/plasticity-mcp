function (AlignEdgeFactory, AlignAndRebuildFactory, SquareFactory, AlignVertexFactory, AlignEdgeDialog, SquareDialog, AlignVertexDialog) {
  // Confirm no probe patch remains on the prototypes, and remove leftover probe globals.
  const own = (C, keys) => keys.filter(k => Object.prototype.hasOwnProperty.call(C.prototype, k));
  const patches = {
    AlignEdgeFactory: own(AlignEdgeFactory, ['update', 'commit', 'calculate', 'cycle', 'solve']),
    AlignAndRebuildFactory: own(AlignAndRebuildFactory, ['update', 'commit']),
    SquareFactory: own(SquareFactory, ['update', 'commit']),
    AlignVertexFactory: own(AlignVertexFactory, ['update', 'commit']),
    AlignEdgeDialog: own(AlignEdgeDialog, ['execute']), SquareDialog: own(SquareDialog, ['execute']), AlignVertexDialog: own(AlignVertexDialog, ['execute']),
    pairsSetterIsNative: String(Object.getOwnPropertyDescriptor(AlignEdgeFactory.prototype, 'pairs')?.set ?? '').includes('calls.push') === false,
  };
  const names = ['__alignLog', '__squareLog', '__probeEdgeInfo', '__probeReads', '__probeFactoryState', '__probeSquareState', '__probeShadingMemento', '__probeCamera'];
  const present = names.filter(n => n in globalThis);
  for (const n of present) delete globalThis[n];
  return { patches, globalsRemoved: present, remaining: names.filter(n => n in globalThis), active: this.executor.active?.command?.constructor?.name ?? null, undo: this.history.undoStack.length };
}
