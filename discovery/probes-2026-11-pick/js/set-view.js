// Sets the orbit view (target, eye direction, radius, zoom) by writing both the current and the smoothing-end state of
// the viewport's OrbitControls (setQuaternionAndTarget left NaNs in target/velocity here).
async function (args) {
  const ed = this; const v = Array.from(ed.viewports)[0]; const cam = v.camera; const c = v.orbitControls; const Vec = cam.position.constructor;
  const target = new Vec(...args.target); const eye = new Vec(...args.eye).normalize();
  if (args.save) globalThis.__pickView = { target: c.target.toArray(), q: c.quaternion.toArray(), radius: c.radius, zoom: c.zoom };
  cam.position.copy(target).addScaledVector(eye, args.radius); cam.up.set(0, 0, 1); cam.lookAt(target);
  const q = args.q ? cam.quaternion.clone().fromArray(args.q) : cam.quaternion.clone();
  c.target.copy(target); c.targetEnd.copy(target); c.targetVelocity.set(0, 0, 0); c.deltaTarget.set(0, 0, 0);
  c.quaternion.copy(q); c.quaternionEnd.copy(q);
  for (const k of ['focalOffset', 'focalOffsetEnd', 'focalOffsetVelocity', '_focalOffset', '_inverseFocalOffset']) c[k]?.set?.(0, 0, 0);
  c.radius = c.radiusEnd = args.radius; c.zoom = c.zoomEnd = args.zoom;
  c.setNeedsUpdate?.(); c.update?.(); v.setNeedsRender();
  await new Promise(r => setTimeout(r, 700));
  cam.updateMatrixWorld();
  const p = args.probe ? new Vec(...args.probe).project(cam) : null;
  const rect = v.renderer.domElement.getBoundingClientRect();
  return { pos: cam.position.toArray(), target: c.target.toArray(), zoom: cam.zoom, ndc: p?.toArray() ?? null, css: p ? [rect.left + (p.x + 1) / 2 * rect.width, rect.top + (1 - p.y) / 2 * rect.height] : null, finite: cam.position.toArray().every(Number.isFinite) };
}
