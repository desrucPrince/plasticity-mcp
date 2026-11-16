// Item 4, step 1: run the real AlignEdgeCommand with the selection [edge to move (B), reference edge (A)],
// capture the AlignEdgeFactory it builds, record its inputs and the active command/dialog, then cancel.
import { connect, save, errText, nativeFunction } from "./harness.ts";
import { startMcp, status, undoTo } from "./mcp.ts";
import { alignSheets } from "./fixtures-align.ts";

const client = await startMcp();
const runtime = await connect();
const start = await status(client);
const out: any = { startUndo: start.undoDepth };
try {
  const fx = await alignSheets(client);
  out.fixture = fx;
  out.undoAfterFixture = (await status(client)).undoDepth;
  for (const which of ["edge"]) out["run_" + which] = await runtime.mutate<any>(nativeFunction`async function (AlignEdgeFactory, AlignEdgeCommand, args) {
    const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item; throw new Error('Unknown body ' + id); };
    const edgeView = (bodyId, edgeId) => { const it = find(bodyId); return it.view.high.edges.get(it.view.high.edges.versionIds.indexOf(edgeId)); };
    const show = v => v === null || v === undefined ? String(v) : typeof v === 'object' ? (v.constructor?.name ?? 'object') + (Array.isArray(v) ? '[' + v.length + ']' : v instanceof Map ? '{' + v.size + '}' : '') : typeof v === 'function' ? 'fn' : v;
    const deep = (v, d = 0) => { if (v === null || typeof v !== 'object' || d > 2) return show(v); if (Array.isArray(v)) return v.slice(0, 6).map(x => deep(x, d + 1)); if (v instanceof Map) return [...v.entries()].slice(0, 6).map(([k, x]) => [show(k), deep(x, d + 1)]); if (v.constructor && !['Object'].includes(v.constructor.name)) return show(v); const o = {}; for (const k of Object.keys(v)) o[k] = deep(v[k], d + 1); return o; };
    const P = AlignEdgeFactory.prototype;
    const captured = [];
    const patched = ['calculate', 'update', 'commit', 'setSurface', 'setPartialIntervals', 'cycle', 'solve'];
    const saved = patched.map(k => [k, Object.getOwnPropertyDescriptor(P, k)]);
    for (const k of patched) { const base = P[k]; P[k] = function (...a) { if (!captured.includes(this)) captured.push(this); calls.push(k + '(' + a.map(x => show(x) + (x && typeof x === 'object' && !Array.isArray(x) ? '{' + Object.keys(x).slice(0, 8).join(',') + '}' : Array.isArray(x) ? deep(x) : '')).join(';') + ')'); return base.apply(this, a); }; }
    // Wrap the pairs and continuity setters (own accessors on AlignEdgeFactory / XNurbsFactory prototypes).
    const XP = Object.getPrototypeOf(P);
    for (const [proto, key] of [[P, 'pairs'], [XP, 'continuity']]) { const d = Object.getOwnPropertyDescriptor(proto, key); if (d?.set) { saved.push([key + '@' + proto.constructor.name, d, proto, key]); Object.defineProperty(proto, key, { ...d, set(v) { calls.push('set ' + key + '=' + JSON.stringify(deep(v))); if (key === 'pairs') { const fresh = new AlignEdgeFactory(this.editor); const diff = {}; for (const k of Object.keys(this)) { if (!(k in fresh) || (typeof this[k] !== 'object' && this[k] !== fresh[k])) diff[k] = show(this[k]); } calls.push('factory fields differing from fresh at set pairs: ' + JSON.stringify(diff) + ' ctor=' + this.constructor.name); const reads = []; const wrap = e => new Proxy(e, { get(t, k, r) { reads.push(String(k)); const val = Reflect.get(t, k, t); return typeof val === 'function' ? val.bind(t) : val; } }); const res = d.set.call(this, Array.isArray(v) ? v.map(wrap) : v); calls.push('edge reads in pairs setter: ' + reads.join(',')); calls.push('edge parentItem: ' + v.map(e => show(e.parentItem) + ':' + (e.parentItem ? Object.keys(e.parentItem).slice(0, 10).join('|') : '')).join(' ; ')); return res; } return d.set.call(this, v); } }); } }
    const calls = [];
    const sel = this.selection.selected;
    const trace = [];
    const snap = label => { const f = captured[0]; trace.push({ label, undo: this.history.undoStack.length, active: this.executor.active?.command?.constructor?.name ?? null,
      edges: [...(sel.edges ?? [])].map(e => e.versionId), factory: f ? { ctor: f.constructor.name, continuity: f.continuity, pairs: deep(f.pairs), targets: deep(f.targets), references: deep(f.references), info: deep(f.info), edge2continuity: deep(f.edge2continuity), boundaryCondition: f.boundaryCondition, blending: f.blending, controlType: f.controlType } : null,
      dialogs: [...document.querySelectorAll('*')].filter(el => el.constructor?.name === 'AlignEdgeDialog').length }); };
    let settled = false, failure = null;
    try {
      sel.removeAll(); this.selection.hits?.clear?.();
      sel.add(edgeView(args.b.bodyId, args.b.edgeId));
      sel.add(edgeView(args.a.bodyId, args.a.edgeId));
      snap('selected');
      const cmd = args.which === 'edge' ? new AlignEdgeCommand(this) : new this.commands.AlignCommand(this);
      const orig = cmd.execute.bind(cmd);
      cmd.execute = async () => { try { return await orig(); } catch (e) { failure = String(e?.stack ?? e?.message ?? e).slice(0, 800); throw e; } };
      this.exec(cmd).then(() => { settled = true; }, e => { failure = String(e?.message ?? e); settled = true; });
      for (let i = 0; i < 30 && !settled; i++) { await new Promise(r => setTimeout(r, 50)); if (i === 4 || i === 29) snap('poll' + i); }
      snap('before-cancel');
      if (!settled && this.executor.active) await this.executor.cancelActiveCommand();
      for (let i = 0; i < 40 && !settled; i++) await new Promise(r => setTimeout(r, 50));
      snap('after-cancel');
    } finally {
      for (const [k, d, proto, key] of saved) { if (proto) Object.defineProperty(proto, key, d); else if (d) Object.defineProperty(P, k, d); else delete P[k]; }
      sel.removeAll();
    }
    return { settled, failure, captured: captured.length, calls: calls.slice(0, 40), trace };
  }`, ["AlignEdgeFactory", "AlignEdgeCommand"], [{ which, a: { bodyId: fx.sheetA, edgeId: fx.edgeA.id }, b: { bodyId: fx.sheetB, edgeId: fx.edgeB.id } }], 30000);
  out.undoAfterRun = (await status(client)).undoDepth;
} catch (e) {
  out.error = errText(e);
} finally {
  await undoTo(client, start.undoDepth);
  const end = await status(client);
  out.endUndo = end.undoDepth; out.endBodies = (end.bodies as any[]).map((b) => b.id);
  save(process.argv[2] ?? "probe-align-1.json", out);
  runtime.close(); await client.close();
}
process.exit(0);
