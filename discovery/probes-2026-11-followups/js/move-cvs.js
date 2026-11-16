// args: { bodyId, cvIds: int[], delta: [m] } -> MoveControlPointCommand + MultiMoveControlPointFactory on view.high.cvs.
async function (Factory, args) {
  const ed = this;
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item.view; throw new Error('Unknown body ' + id); };
  const view = find(args.bodyId);
  const all = new Map(Array.from(view.high.cvs).map(cv => [cv.id, cv]));
  const cvs = args.cvIds.map(id => all.get(id));
  const undo0 = ed.history.undoStack.length;
  let failure = null;
  const command = new ed.commands.MoveControlPointCommand(ed);
  command.remember = false;
  command.execute = async function () {
    try { const factory = new Factory(ed).resource(this); nativeApi.setCurveControlPoints(factory, [], cvs); factory.move.fromArray(args.delta); return await factory.commit(); }
    catch (e) { failure = String(e?.message ?? e); throw e; }
  };
  try { await ed.exec(command); } catch (e) { failure = failure ?? String(e?.message ?? e); }
  return { undoDelta: ed.history.undoStack.length - undo0, failure };
}
