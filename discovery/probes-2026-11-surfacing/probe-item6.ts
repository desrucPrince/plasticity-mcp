// Item 6 (lower priority). (a) Curve Array: validate the shipped plasticity_curve_pattern (CurveArrayFactory).
// (b) Vertex Align: run AlignVertexCommand with two curve end vertices selected, capture AlignVertexFactory
// (update wrap) and AlignVertexDialog (execute wrap), set G1, finish; read back the moved curve.
import { connect, save, errText, nativeFunction } from "./harness.ts";
import { startMcp, call, status, undoTo } from "./mcp.ts";
import { rev, created } from "./fixtures.ts";
import { readFileSync } from "node:fs";

const cancelSource = readFileSync(new URL("./js/cancel-active.js", import.meta.url), "utf8");
const client = await startMcp();
const runtime = await connect();
const start = await status(client);
const out: any = { startUndo: start.undoDepth };
const ids = async () => new Set(((await status(client)).bodies as any[]).map((b) => b.id));

try {
  // (a) Curve Array: a 4 mm cube patterned 5 times along a curved spine.
  let before = await ids();
  await call(client, "plasticity_create_control_point_curve", { pointsMm: [[6300, 0, 0], [6320, 0, 0], [6340, 20, 0], [6360, 20, 0]], intent: "probe spine", revision: await rev(client) });
  const spine = (await created(client, before))[0];
  before = await ids();
  await call(client, "plasticity_create_box", { originMm: [6298, -2, -2], sizeMm: [4, 4, 4], intent: "probe item", revision: await rev(client) });
  const cube = (await created(client, before))[0];
  const d0 = (await status(client)).undoDepth;
  before = await ids();
  out.curveArray = await call(client, "plasticity_curve_pattern", { ids: [cube.id], spineId: spine.id, count: 5, intent: "probe curve array", revision: await rev(client) });
  const made = await created(client, before);
  out.curveArrayReadBack = { undoDelta: (await status(client)).undoDepth - d0, newBodies: made.map((b) => ({ id: b.id, type: b.type, centerMm: b.boundsMm.min.map((v: number, i: number) => (v + b.boundsMm.max[i]) / 2) })) };
  await undoTo(client, start.undoDepth);

  // (b) Vertex Align: curve A end (6440,5,0); curve B starts 1 mm away at a different heading.
  before = await ids();
  await call(client, "plasticity_create_control_point_curve", { pointsMm: [[6400, 0, 0], [6413, 0, 0], [6427, 2, 0], [6440, 5, 0]], intent: "probe curve A", revision: await rev(client) });
  const ca = (await created(client, before))[0];
  before = await ids();
  await call(client, "plasticity_create_control_point_curve", { pointsMm: [[6441, 5, 0], [6450, 15, 0], [6460, 25, 0], [6470, 30, 0]], intent: "probe curve B", revision: await rev(client) });
  const cb = (await created(client, before))[0];
  const fixtureDepth = (await status(client)).undoDepth;
  out.vertexFixture = { ca: ca.id, cb: cb.id, fixtureDepth };
  out.vertexAlign = await runtime.mutate(nativeFunction`async function (AlignVertexFactory, AlignVertexDialog, AlignVertexCommand, ContinuityType, args) {
    const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item; throw new Error('Unknown body ' + id); };
    const show = v => v === null || v === undefined ? String(v) : typeof v === 'object' ? (v.constructor?.name ?? 'object') + (Array.isArray(v) ? '[' + v.length + ']' : '') : typeof v === 'function' ? 'fn' : v;
    const editor = this, sel = this.selection.selected, log = [];
    const mark = (ev, extra) => log.push({ ev, undo: editor.history.undoStack.length, active: editor.executor.active?.command?.constructor?.name ?? null, ...(extra ?? {}) });
    // Curve end vertices: look for vertex collections on the Wire view.
    const wa = find(args.ca).view, wb = find(args.cb).view;
    const vkeys = Object.keys(wa).filter(k => /vert|point|cv|segment/i.test(k));
    const highKeys = wa.high ? Object.keys(wa.high) : null;
    mark('wire keys', { vkeys, highKeys, ctor: wa.constructor.name, ownKeys: Object.keys(wa).slice(0, 40) });
    const verts = w => { const g = w.vertices ?? w.high?.vertices ?? w.points; if (!g) return []; if (typeof g.get === 'function' && g.versionIds) return g.versionIds.map((_, i) => g.get(i)); try { return [...g]; } catch { return []; } };
    const va = verts(wa), vb = verts(wb);
    mark('vertices', { a: va.map(v => show(v) + ':' + (v.versionId ?? v.index ?? '')), b: vb.map(v => show(v) + ':' + (v.versionId ?? v.index ?? '')) });
    if (!va.length || !vb.length) return { log, note: 'no curve vertices found on the Wire views' };
    const P = AlignVertexFactory.prototype, DP = AlignVertexDialog.prototype;
    const saved = [[P, 'update', Object.getOwnPropertyDescriptor(P, 'update')], [DP, 'execute', Object.getOwnPropertyDescriptor(DP, 'execute')]];
    let factory = null, dialog = null, settled = false, execError = null;
    const bu = P.update, be = DP.execute;
    P.update = function (...a) { if (!factory) factory = this; return bu.apply(this, a); };
    DP.execute = function (...a) { if (!dialog) dialog = this; return be.apply(this, a); };
    try {
      sel.removeAll();
      sel.add(vb[0]); sel.add(va[va.length - 1]);
      mark('selected', { counts: Object.fromEntries(['vertices', 'curves', 'edges', 'controlPoints', 'cvs'].map(k => [k, (() => { try { return [...(sel[k] ?? [])].length; } catch { return 'n/a'; } })()])) });
      const cmd = new AlignVertexCommand(this); cmd.remember = false;
      const orig = cmd.execute.bind(cmd);
      cmd.execute = async () => { try { return await orig(); } catch (e) { execError = (e?.constructor?.name ?? '') + ':' + String(e?.message ?? e).slice(0, 300); throw e; } finally { sel.removeAll(); } };
      this.exec(cmd).then(() => { settled = true; }, e => { execError = execError ?? String(e?.message ?? e); settled = true; });
      const deadline = Date.now() + 3000;
      while ((!factory || !dialog) && !settled && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
      await new Promise(r => setTimeout(r, 600));
      mark('captured', { factory: show(factory), dialog: show(dialog), params: show(dialog?.params), execError, settled });
      if (!factory && dialog?.params?.commit) factory = dialog.params;
      if (!factory || !dialog) { if (!settled && this.executor.active) await this.executor.cancelActiveCommand(); return { log, execError, settled }; }
      mark('factory state', { continuity: factory.continuity, movings: show(factory.movings), targets: show(factory.targets) });
      factory.continuity = ContinuityType.G1;
      try { await factory.update(); mark('updated'); } catch (e) { mark('update error', { e: String(e?.message ?? e).slice(0, 300) }); }
      dialog.finish(); mark('finish called');
      const d2 = Date.now() + 15000;
      while (!settled && Date.now() < d2) await new Promise(r => setTimeout(r, 25));
      if (!settled && this.executor.active) { mark('finish timeout'); await this.executor.cancelActiveCommand(); }
      mark('end', { settled, execError });
      return { log, execError, settled };
    } finally {
      for (const [proto, k, d] of saved) { if (d) Object.defineProperty(proto, k, d); else delete proto[k]; }
      sel.removeAll();
    }
  }`, ["AlignVertexFactory", "AlignVertexDialog", "AlignVertexCommand", "ContinuityType"], [{ ca: ca.id, cb: cb.id }], 40000);
  const st = await status(client);
  out.vertexAfter = { undo: st.undoDepth, bodies: (st.bodies as any[]).filter((b) => [ca.id, cb.id].includes(b.id)).map((b) => ({ id: b.id, boundsMm: b.boundsMm })) };
} catch (e) {
  out.error = errText(e);
} finally {
  try { out.finalCancel = await runtime.read(cancelSource, [], 20000); } catch (e) { out.finalCancelError = errText(e); }
  await undoTo(client, start.undoDepth);
  const end = await status(client);
  out.endUndo = end.undoDepth; out.endBodies = (end.bodies as any[]).map((b) => b.id);
  save("probe-item6.json", out);
  runtime.close(); await client.close();
}
process.exit(0);
