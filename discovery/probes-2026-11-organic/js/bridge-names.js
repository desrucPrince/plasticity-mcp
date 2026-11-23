function (pk_default, args) {
  const k = pk_default.a ?? {};
  const out = { kernel: Object.keys(k).filter(n => /Bridge|Blend|Sew|Knit|Join|Unjoin|Merge|Split/i.test(n)) };
  const op = k.Operation; const names = new Set(); let p = op.prototype; while (p && p !== Object.prototype) { for (const n of Object.getOwnPropertyNames(p)) names.add(n); p = Object.getPrototypeOf(p); }
  out.op = [...names].filter(n => !n.endsWith('_async')).sort();
  out.cmds = Object.keys(this.commands ?? {}).filter(n => /Bridge|Join|Unjoin|Merge|Split|Sew|Imprint|Vertex|Patch|Fill/i.test(n));
  return out;
}
