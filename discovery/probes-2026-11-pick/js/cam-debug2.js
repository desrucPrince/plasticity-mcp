async function (args) {
  const ed = this; const v = Array.from(ed.viewports)[0]; const cam = v.camera; const Vec = cam.position.constructor;
  const target = new Vec(...args.center);
  const s = () => ({ pos: cam.position.toArray().map(x => +x.toFixed(4)), target: v.orbitControls.target.toArray().map(x => +x.toFixed(4)), zoom: cam.zoom, lrtb: [cam.left, cam.right, cam.top, cam.bottom], ndcTarget: target.clone().project(cam).toArray().map(x => +x.toFixed(3)), ndcPoint: new Vec(...args.point).project(cam).toArray().map(x => +x.toFixed(3)), wts: (() => { try { const w = v.worldToScreen(new Vec(...args.point)); return w?.toArray?.() ?? w; } catch (e) { return String(e); } })() });
  const out = { start: s(), camKeys: Object.keys(cam).slice(0, 40), camProto: Object.getOwnPropertyNames(Object.getPrototypeOf(cam)).slice(0, 40), ctlProto: Object.getOwnPropertyNames(Object.getPrototypeOf(v.orbitControls)).slice(0, 40) };
  return out;
}
