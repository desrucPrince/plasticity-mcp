async function (args) {
  const ed = this; const v = Array.from(ed.viewports)[0]; const cam = v.camera; const Vec = cam.position.constructor; const c = v.orbitControls;
  const target = new Vec(...args.center);
  const s = () => { cam.updateMatrixWorld(); return { pos: cam.position.toArray().map(x => +x.toFixed(4)), target: c.target.toArray().map(x => +x.toFixed(4)), ndcTarget: target.clone().project(cam).toArray().map(x => +x.toFixed(3)), ndcPoint: new Vec(...args.point).project(cam).toArray().map(x => +x.toFixed(3)) }; };
  const out = { start: s() };
  const tries = {
    setQuaternionAndTarget: () => c.setQuaternionAndTarget(cam.quaternion.clone(), target.clone()),
    setOrbitPoint: () => c.setOrbitPoint(target.clone()),
    vSetAndCenterFocusPoint: () => v.setAndCenterFocusPoint(target.clone()),
  };
  const which = args.which;
  try { out.ret = String(tries[which]()); } catch (e) { out.err = String(e?.message ?? e); }
  c.update?.(); v.setNeedsRender();
  await new Promise(r => setTimeout(r, 600));
  out.after = s();
  return out;
}
