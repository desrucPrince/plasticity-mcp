async function (args) {
  const ed = this; const vps = ed.viewports;
  const v = vps[0] ?? Array.from(vps)[0];
  const show = x => x === null || x === undefined ? String(x) : typeof x === 'object' ? x.constructor?.name : typeof x === 'function' ? 'fn' : x;
  const cam = v.camera;
  const Vec = cam.position.constructor;
  const p = new Vec(...args.point).project(cam);
  const el = v.renderer?.domElement ?? v.domElement;
  const rect = el?.getBoundingClientRect?.();
  return { n: vps.length ?? vps.size, keys: Object.keys(v).slice(0, 80).map(k => k + ':' + show(v[k])), proto: Object.getOwnPropertyNames(Object.getPrototypeOf(v)).slice(0, 80), cam: cam.constructor.name, ndc: p.toArray(), rect: rect && rect.toJSON(), css: rect && [rect.left + (p.x + 1) / 2 * rect.width, rect.top + (1 - p.y) / 2 * rect.height] };
}
