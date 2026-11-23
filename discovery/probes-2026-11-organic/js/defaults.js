async function (Factory, Continuity, args) {
  const out = { continuity: Object.entries(Continuity).filter(([k, v]) => typeof v === 'number').slice(0, 30) };
  const editor = this;
  const f = new Factory(editor);
  out.defaultContinuity = f.continuity;
  out.defaultTolerance = f.tolerance;
  try { out.topology = f.topology; out.smooth = f.internalSmoothness; } catch (e) {}
  return out;
}
