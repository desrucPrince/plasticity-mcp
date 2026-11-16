async function (args) {
  const ed = this; const v = Array.from(ed.viewports)[0]; const c = v.orbitControls;
  const show = x => x === null || x === undefined ? String(x) : x?.toArray ? x.toArray() : typeof x === 'object' ? x.constructor?.name + (x.constructor === Object ? JSON.stringify(Object.fromEntries(Object.entries(x).slice(0, 12).map(([k, y]) => [k, y?.toArray ? y.toArray() : typeof y === 'object' ? y?.constructor?.name : y]))) : '') : typeof x === 'function' ? 'fn' : x;
  return { lens: { setQuaternionAndTarget: c.setQuaternionAndTarget.length, focus: c.focus.length, setOrbitPoint: c.setOrbitPoint.length }, fields: Object.fromEntries(Object.keys(c).map(k => [k, show(c[k])])) };
}
