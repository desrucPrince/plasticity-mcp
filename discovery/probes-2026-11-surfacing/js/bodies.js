function () {
  const out = [];
  for (const [versionId, item] of nativeApi.geo.geometryModel) {
    if (nativeApi.geo.automatics.has(versionId)) continue;
    const box = new (item.view.position.constructor)();
    let bb = null; try { const b = item.model.GetBoundingBox?.() ?? null; bb = b ? JSON.stringify(b).slice(0,200) : null; } catch (e) { bb = 'err ' + e.message; }
    out.push({ versionId, id: nativeApi.db.lookupStableId(versionId), type: item.view.constructor.name, name: item.view.userData?.name ?? null, faces: item.view.high?.faces?.versionIds?.length, edges: item.view.high?.edges?.versionIds?.length, bb });
  }
  return { out, undo: this.history.undoStack.length, title: document.title, t: Date.now() };
}
