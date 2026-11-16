async function (args) {
  const ed = this; const v = Array.from(ed.viewports)[0]; const cam = v.camera; const c = v.orbitControls;
  const snap = () => ({ pos: cam.position.toArray(), q: cam.quaternion.toArray(), target: c.target.toArray(), camTarget: cam.target?.toArray?.(), zoom: cam.zoom });
  const out = { before: snap() };
  cam.position.fromArray(args.pos); c.target.fromArray(args.target); if (cam.target?.fromArray) cam.target.fromArray(args.target);
  cam.up.set(0, 0, 1); cam.lookAt(c.target); cam.updateMatrixWorld();
  if (!Number.isFinite(cam.zoom)) cam.zoom = args.zoom;
  cam.updateProjectionMatrix();
  out.mid = snap();
  c.update?.(); v.setNeedsRender();
  await new Promise(r => setTimeout(r, 600));
  out.after = snap();
  return out;
}
