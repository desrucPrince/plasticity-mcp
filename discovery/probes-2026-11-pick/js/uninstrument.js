async function (args) {
  const g = globalThis; const n = g.__pickOrig?.length ?? 0;
  for (const [proto, key, d] of (g.__pickOrig ?? []).reverse()) Object.defineProperty(proto, key, d);
  delete g.__pickOrig; delete g.__pick2; const log = g.__pickLog; delete g.__pickLog; delete g.__pickObjs;
  return { restored: n, logLen: log?.length };
}
