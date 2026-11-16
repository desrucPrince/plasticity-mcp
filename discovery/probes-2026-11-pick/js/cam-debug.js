async function (args) {
  const ed = this; const v = Array.from(ed.viewports)[0]; const cam = v.camera;
  const s = () => ({ pos: cam.position.toArray().map(x => +x.toFixed(4)), target: v.orbitControls?.target?.toArray?.().map(x => +x.toFixed(4)), zoom: cam.zoom, type: cam.isOrthographicCamera ? 'ortho' : cam.isPerspectiveCamera ? 'persp' : cam.constructor.name, frame: v.lastFrameNumber });
  const out = { before: s(), navLen: v.navigateToSelection.length, wts: String(v.worldToScreen.length) };
  const find = id => { for (const [vid, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(vid) === id) return item.view; };
  ed.selection.selected.removeAll(); ed.selection.selected.add(find(args.id));
  const r = v.navigateToSelection();
  out.ret = r?.constructor?.name;
  await new Promise(r => setTimeout(r, 1500));
  out.after = s();
  cam.updateMatrixWorld?.(); cam.updateProjectionMatrix?.();
  const Vec = cam.position.constructor; const p = new Vec(...args.point).project(cam); out.ndc = p.toArray();
  try { const w = v.worldToScreen(new Vec(...args.point)); out.wts = w?.toArray?.() ?? w; } catch (e) { out.wtsErr = String(e); }
  ed.selection.selected.removeAll();
  return out;
}
