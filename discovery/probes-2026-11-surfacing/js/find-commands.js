function (args) {
  const re = new RegExp(args.re, 'i');
  const cmds = Object.keys(this.commands ?? {}).filter(k => re.test(k));
  // Command registry ids (the keymap side): look through any registry-like map on the editor.
  const reg = [];
  for (const k of Object.keys(this)) { const v = this[k]; if (v && typeof v === 'object' && (v instanceof Map || typeof v.get === 'function') && typeof v.keys === 'function') { try { for (const id of v.keys()) if (typeof id === 'string' && re.test(id)) reg.push(k + ':' + id); } catch {} } }
  const registry = this.registry ?? this.commandRegistry ?? null;
  return { commands: cmds, registryHits: reg.slice(0, 50), editorKeys: Object.keys(this).filter(k => /regist|keymap|command/i.test(k)), registryType: registry?.constructor?.name ?? null };
}
