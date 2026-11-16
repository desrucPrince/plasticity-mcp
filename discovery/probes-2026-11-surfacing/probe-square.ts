// Item 5: Square through the real command (same route as Surface Align, probe-align-3.ts).
// Case "curves": four control-point boundary curves selected as Wire bodies -> SquareCommand (router).
// Case "edgesG1": open box (top face deleted); its four top laminar edges -> Square with G1 on every edge.
// Captures the SquareFactory (update wrap) and SquareDialog (execute wrap), waits, sets continuity, finishes.
// Read-back: new Sheet type/topology; for edgesG1 join with the walls and run plasticity_analyze_surface_continuity.
// usage: node probe-square.ts curves,edgesG1,edgesG0 [command: router|edge]
import { connect, save, errText, nativeFunction } from "./harness.ts";
import { startMcp, call, status, undoTo, tryCall } from "./mcp.ts";
import { rev, created, info, faceNormal } from "./fixtures.ts";
import { readFileSync } from "node:fs";

const cancelSource = readFileSync(new URL("./js/cancel-active.js", import.meta.url), "utf8");
const cases = (process.argv[2] ?? "curves,edgesG1").split(",");
const which = process.argv[3] ?? "router";
const client = await startMcp();
const runtime = await connect();
const start = await status(client);
const out: any = { startUndo: start.undoDepth, which, cases: {} };
const ids = async () => new Set(((await status(client)).bodies as any[]).map((b) => b.id));
const baseline = new Set((start.bodies as any[]).map((b) => b.id));

const runSquare = nativeFunction`async function (SquareFactory, SquareDialog, SquareEdgeCommand, ContinuityType, args) {
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item; throw new Error('Unknown body ' + id); };
  const edgeView = (bodyId, edgeId) => { const it = find(bodyId); return it.view.high.edges.get(it.view.high.edges.versionIds.indexOf(edgeId)); };
  const show = v => v === null || v === undefined ? String(v) : typeof v === 'object' ? (v.constructor?.name ?? 'object') + (Array.isArray(v) ? '[' + v.length + ']' : '') : typeof v === 'function' ? 'fn' : v;
  if (this.executor.active) throw new Error('busy: ' + this.executor.active.command?.constructor?.name);
  const editor = this, sel = this.selection.selected, log = []; globalThis.__squareLog = log;
  const mark = (ev, extra) => log.push({ ev, undo: editor.history.undoStack.length, active: editor.executor.active?.command?.constructor?.name ?? null, ...(extra ?? {}) });
  const P = SquareFactory.prototype, DP = SquareDialog.prototype;
  const saved = ['update', 'commit'].map(k => [P, k, Object.getOwnPropertyDescriptor(P, k)]).concat([[DP, 'execute', Object.getOwnPropertyDescriptor(DP, 'execute')]]);
  let factory = null, dialog = null, settled = false, execError = null;
  const bu = P.update, bc = P.commit, be = DP.execute;
  P.update = function (...a) { if (!factory) factory = this; return bu.apply(this, a); };
  P.commit = function (...a) { mark('factory.commit called'); return Promise.resolve(bc.apply(this, a)).then(r => { mark('factory.commit resolved', { r: show(r) }); return r; }, e => { mark('factory.commit rejected', { e: String(e?.message ?? e).slice(0, 400) }); throw e; }); };
  DP.execute = function (...a) { if (!dialog) dialog = this; return be.apply(this, a); };
  const state = f => ({ continuity: f.continuity, wires: (() => { try { return (f.wires ?? []).length; } catch (e) { return 'err'; } })(), edges: (() => { try { return (f.edges ?? []).length; } catch (e) { return 'err'; } })(), boundaries: (() => { try { return show(f.boundaries); } catch (e) { return 'err'; } })(),
    edge2continuity: [...f.edge2continuity.entries()].map(([k, v]) => [show(k) + ':' + (k?.versionId ?? k), v]), segment2continuity: [...f.segment2continuity.entries()].map(([k, v]) => [show(k), v]), quadSided: f.quadSided, uDegree: f.uDegree, vDegree: f.vDegree, controlType: f.controlType });
  try {
    sel.removeAll(); this.selection.hits?.clear?.();
    for (const s of args.select) sel.add(s.edgeId ? edgeView(s.bodyId, s.edgeId) : find(s.bodyId).view);
    mark('selected', { edges: [...(sel.edges ?? [])].length, curves: [...(sel.curves ?? [])].length, sheets: [...(sel.sheets ?? [])].length });
    const cmd = args.which === 'edge' ? new SquareEdgeCommand(this) : new this.commands.SquareCommand(this);
    cmd.remember = false;
    const orig = cmd.execute.bind(cmd);
    cmd.execute = async () => { try { const r = await orig(); mark('execute returned', { ret: show(r) }); return r; } catch (e) { execError = (e?.constructor?.name ?? '') + ':' + String(e?.message ?? e).slice(0, 400); throw e; } finally { sel.removeAll(); } };
    this.exec(cmd).then(() => { settled = true; }, e => { execError = execError ?? String(e?.message ?? e); settled = true; });
    const deadline = Date.now() + 4000;
    while ((!factory || !dialog) && !settled && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    await new Promise(r => setTimeout(r, args.settleMs ?? 600));
    mark('captured', { factory: show(factory), dialog: show(dialog), params: show(dialog?.params), paramsChain: (() => { const o = []; let p = dialog?.params ? Object.getPrototypeOf(dialog.params) : null; while (p && p !== Object.prototype && o.length < 4) { o.push(p.constructor?.name); p = Object.getPrototypeOf(p); } return o; })(), paramsIsFactory: dialog?.params === factory, execError, settled });
    if (!factory && dialog?.params && typeof dialog.params.commit === 'function') factory = dialog.params;
    if (!factory || !dialog) { if (!settled && this.executor.active) await this.executor.cancelActiveCommand(); return { log, execError, settled }; }
    mark('before config', { state: state(factory) });
    if (args.continuity) {
      const CT = ContinuityType[args.continuity];
      if (args.perEdge) { for (const [k] of [...factory.edge2continuity]) factory.setContinuityForEdge(typeof k === 'object' ? k : edgeView(args.select[0].bodyId, k), CT); }
      else factory.continuity = CT;
    }
    try { await factory.update(); mark('updated', { state: state(factory) }); } catch (e) { mark('update error', { error: String(e?.message ?? e).slice(0, 400) }); }
    dialog.finish();
    mark('finish called');
    const d2 = Date.now() + 20000;
    while (!settled && Date.now() < d2) await new Promise(r => setTimeout(r, 25));
    if (!settled) { mark('finish timeout'); if (this.executor.active) await this.executor.cancelActiveCommand(); }
    mark('end', { settled, execError });
    return { log, execError, settled };
  } finally {
    for (const [proto, k, d] of saved) { if (d) Object.defineProperty(proto, k, d); else delete proto[k]; }
    sel.removeAll(); this.selection.hits?.clear?.();
  }
}`;

async function newBodies() {
  const st = await status(client);
  return (st.bodies as any[]).filter((b) => !baseline.has(b.id)).map((b) => ({ id: b.id, type: b.type, name: b.name, faceCount: b.faceCount, edgeCount: b.edgeCount, boundsMm: b.boundsMm }));
}

for (const c of cases) {
  const entry: any = {};
  const caseStart = (await status(client)).undoDepth;
  try {
    let select: any[] = [], continuity: string | undefined, perEdge = false, walls: number | undefined;
    if (c === "curves") {
      const curves = [
        [[6000, 0, 0], [6013, 0, 5], [6027, 0, 5], [6040, 0, 0]],
        [[6040, 0, 0], [6040, 13, -4], [6040, 27, -4], [6040, 40, 0]],
        [[6040, 40, 0], [6027, 40, 6], [6013, 40, 6], [6000, 40, 0]],
        [[6000, 40, 0], [6000, 27, 3], [6000, 13, 3], [6000, 0, 0]],
      ];
      for (const pts of curves) {
        const before = await ids();
        await call(client, "plasticity_create_control_point_curve", { pointsMm: pts, intent: "probe square boundary", revision: await rev(client) });
        select.push({ bodyId: (await created(client, before))[0].id });
      }
    } else {
      const before = await ids();
      await call(client, "plasticity_create_box", { originMm: [6100, 0, 0], sizeMm: [40, 40, 20], intent: "probe open box", revision: await rev(client) });
      const box = (await created(client, before))[0];
      const top = (await info(client, box.id)).faces.find(faceNormal([0, 0, 1]))!;
      await call(client, "plasticity_delete_faces", { faces: [{ bodyId: box.id, faceId: top.id }], intent: "probe open top", revision: await rev(client) });
      const B = await info(client, box.id);
      entry.openBox = { id: box.id, type: B.type, laminar: B.edges.filter((e) => e.faceIds.length === 1).map((e) => e.id) };
      select = B.edges.filter((e) => e.faceIds.length === 1).map((e) => ({ bodyId: box.id, edgeId: e.id }));
      continuity = c === "edgesG1" ? "G1" : c === "edgesG2" ? "G2" : "G0";
      perEdge = process.env.PER_EDGE === "1";
      walls = box.id;
    }
    entry.depthBefore = (await status(client)).undoDepth;
    entry.bodiesBefore = (await newBodies()).map((b) => b.id);
    entry.run = await runtime.mutate(runSquare, ["SquareFactory", "SquareDialog", "SquareEdgeCommand", "ContinuityType"], [{ select, which, continuity, perEdge }], 45000);
    entry.depthAfter = (await status(client)).undoDepth;
    const after = await newBodies();
    entry.created = after.filter((b) => !entry.bodiesBefore.includes(b.id));
    for (const b of entry.created) if (b.type === "Sheet") { const bi = await info(client, b.id); b.faces = bi.faces.map((f) => f.surfaceType); b.edges = bi.edges.map((e) => ({ id: e.id, curveType: e.curveType, lengthMm: e.lengthMm })); }
    const sq = entry.created.find((b: any) => b.type === "Sheet");
    if (walls && sq) {
      const j = await tryCall(client, "plasticity_join_sheets", { ids: [walls, sq.id], intent: "probe join square", revision: await rev(client) });
      entry.join = j.ok ? "ok" : j.error;
      if (j.ok) {
        const joined = (await newBodies()).find((b) => b.type === "Sheet" || b.type === "Solid");
        const J = await info(client, joined!.id);
        const sqFaces = J.faces.filter((f) => !f.planar).map((f) => f.id);
        const shared = J.edges.filter((e) => e.faceIds.length === 2 && e.faceIds.some((id) => sqFaces.includes(id)));
        entry.joinedType = J.type;
        entry.continuity = (await call(client, "plasticity_analyze_surface_continuity", { edges: shared.map((e) => ({ bodyId: joined!.id, edgeId: e.id })), revision: await rev(client) })).analyses
          .map((a: any) => ({ edge: a.edge.edgeId, gapMm: a.maximumPositionDeviationMm, angleDeg: a.maximumNormalAngleDeviationDeg, relG2: a.maximumRelativeCurvatureDeviation, achieved: a.achievedContinuity }));
      }
    }
  } catch (e) {
    entry.error = errText(e);
    try { entry.log = await runtime.read(`function () { return globalThis.__squareLog ?? null; }`, [], 5000); } catch {}
  }
  try { entry.cancel = await runtime.read(cancelSource, [], 20000); } catch (e) { entry.cancelError = errText(e); }
  try { await undoTo(client, caseStart); } catch (e) { entry.undoError = errText(e); }
  out.cases[c] = entry;
}
try { out.finalCancel = await runtime.read(cancelSource, [], 20000); } catch (e) { out.finalCancelError = errText(e); }
try { await undoTo(client, start.undoDepth); } catch (e) { out.finalUndoError = errText(e); }
const end = await status(client);
out.endUndo = end.undoDepth; out.endBodies = (end.bodies as any[]).map((b) => b.id);
save(process.argv[4] ?? `probe-square-${which}.json`, out);
runtime.close(); await client.close();
process.exit(0);
