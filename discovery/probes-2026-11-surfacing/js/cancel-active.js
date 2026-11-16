async function () {
  const before = { active: this.executor.active?.command?.constructor?.name ?? null, busy: this.executor.isBusy, undo: this.history.undoStack.length };
  if (this.executor.active) await this.executor.cancelActiveCommand();
  for (let i = 0; i < 40 && this.executor.active; i++) await new Promise(r => setTimeout(r, 50));
  this.selection.selected.removeAll(); this.selection.hits?.clear?.();
  return { before, after: { active: this.executor.active?.command?.constructor?.name ?? null, busy: this.executor.isBusy, undo: this.history.undoStack.length } };
}
