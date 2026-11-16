// Item 4, step 3: Surface Align through the real AlignEdgeCommand (no selection hit needed).
// Selection [edge to move, reference edge] -> exec AlignEdgeCommand (not awaited) -> capture its AlignAndRebuildFactory
// (prototype wrap of update) and its AlignEdgeDialog (prototype wrap of execute) -> set continuity -> factory.update()
// -> dialog.finish() -> wait for settle. Read-back: join A+B, then plasticity_analyze_surface_continuity.
// usage: node probe-align-3.ts G1,G2 [outName]
import { connect, save, errText, nativeFunction } from "./harness.ts";
import { startMcp, call, status, undoTo, tryCall } from "./mcp.ts";
import { rev, info } from "./fixtures.ts";
import { alignSheets } from "./fixtures-align.ts";

import { readFileSync } from "node:fs";
const cancelSource = readFileSync(new URL("./js/cancel-active.js", import.meta.url), "utf8");
const wanted = (process.argv[2] ?? "G1,G2").split(",");
const mode = process.env.ALIGN_MODE ?? "perEdge";
const client = await startMcp();
const runtime = await connect();
const start = await status(client);
const out: any = { startUndo: start.undoDepth, trials: {} };

const runAlign = nativeFunction`async function (AlignEdgeFactory, AlignEdgeDialog, AlignEdgeCommand, ContinuityType, args) {
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item; throw new Error('Unknown body ' + id); };
  const edgeView = (bodyId, edgeId) => { const it = find(bodyId); return it.view.high.edges.get(it.view.high.edges.versionIds.indexOf(edgeId)); };
  const show = v => v === null || v === undefined ? String(v) : typeof v === 'object' ? (v.constructor?.name ?? 'object') : typeof v === 'function' ? 'fn' : v;
  if (this.executor.active) throw new Error('busy: ' + this.executor.active.command?.constructor?.name);
  const editor = this, sel = this.selection.selected, log = []; globalThis.__alignLog = log;
  const mark = (ev, extra) => log.push({ ev, undo: editor.history.undoStack.length, active: editor.executor.active?.command?.constructor?.name ?? null, ...(extra ?? {}) });
  const FP = Object.getPrototypeOf(AlignEdgeFactory.prototype); // XNurbsFactory: update lives on GeometryFactory, wrap at AlignEdgeFactory level
  const P = AlignEdgeFactory.prototype, DP = AlignEdgeDialog.prototype;
  const savedP = Object.getOwnPropertyDescriptor(P, 'update'), savedD = Object.getOwnPropertyDescriptor(DP, 'execute');
  let factory = null, dialog = null, settled = false, execError = null;
  const baseUpdate = P.update, baseExec = DP.execute;
  P.update = function (...a) { if (!factory) factory = this; return baseUpdate.apply(this, a); };
  const savedC = Object.getOwnPropertyDescriptor(P, 'commit'); const baseCommit = P.commit;
  P.commit = function (...a) { mark('factory.commit called'); return Promise.resolve(baseCommit.apply(this, a)).then(r => { mark('factory.commit resolved', { r: show(r) }); return r; }, e => { mark('factory.commit rejected', { e: String(e?.message ?? e).slice(0, 400) }); throw e; }); };
  DP.execute = function (...a) { if (!dialog) dialog = this; return baseExec.apply(this, a); };
  try {
    sel.removeAll(); this.selection.hits?.clear?.();
    sel.add(edgeView(args.b.bodyId, args.b.edgeId));
    sel.add(edgeView(args.a.bodyId, args.a.edgeId));
    mark('selected', { edges: [...sel.edges].map(e => e.versionId) });
    const cmd = new AlignEdgeCommand(this);
    cmd.remember = false;
    const orig = cmd.execute.bind(cmd);
    cmd.execute = async () => { try { const r = await orig(); mark('execute returned', { ret: show(r) }); return r; } catch (e) { execError = (e?.constructor?.name ?? typeof e) + ':' + (e?.name ?? '') + ':' + String(e?.message ?? e) + ':' + String(e?.stack ?? '').slice(0, 600); throw e; } finally { sel.removeAll(); } };
    this.exec(cmd).then(() => { settled = true; }, e => { execError = execError ?? String(e?.message ?? e); settled = true; });
    const deadline = Date.now() + 3000;
    while ((!factory || !dialog) && !settled && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    mark('captured', { factory: show(factory), dialog: show(dialog), dialogKeys: dialog ? Object.keys(dialog).slice(0, 30) : null, paramsKeys: dialog?.params ? Object.keys(dialog.params).slice(0, 40) : null, paramsIsFactory: dialog?.params === factory });
    if (!factory || !dialog) { if (!settled && this.executor.active) await this.executor.cancelActiveCommand(); return { log, execError, settled }; }
    // execute() keeps setting up (gizmo, quasimode) after the dialog opens; finishing before that ends with
    // AlreadyFinishedError and no commit (probe-align-3-dbg.json). Let it settle first.
    await new Promise(r => setTimeout(r, args.settleMs ?? 500));
    mark('after settle wait');
    const pairs = factory.pairs ?? [];
    const ref = pairs.find(e => e.versionId === args.a.edgeId), mov = pairs.find(e => e.versionId === args.b.edgeId);
    const before = { continuity: factory.continuity, edge2continuity: [...factory.edge2continuity.entries()].map(([k, v]) => [show(k) + ':' + (k?.versionId ?? k?.entityId ?? k), v]), pairs: pairs.map(e => e.versionId), targets: (factory.targets ?? []).map(e => e.versionId) };
    const CT = ContinuityType[args.continuity];
    if (args.mode === 'global') factory.continuity = CT;
    else factory.setContinuityForEdge(args.mode === 'perEdgeMoving' ? mov : ref, CT);
    const afterSet = { continuity: factory.continuity, edge2continuity: [...factory.edge2continuity.entries()].map(([k, v]) => [show(k) + ':' + (k?.versionId ?? k?.entityId ?? k), v]) };
    mark('continuity set', { before, afterSet, refFound: !!ref, movFound: !!mov });
    try { await factory.update(); mark('updated'); } catch (e) { mark('update error', { error: String(e?.message ?? e) }); }
    dialog.finish();
    mark('finish called');
    const d2 = Date.now() + 15000;
    while (!settled && Date.now() < d2) await new Promise(r => setTimeout(r, 25));
    if (!settled) { mark('finish timeout'); if (this.executor.active) await this.executor.cancelActiveCommand(); }
    mark('end', { settled, execError });
    return { log, execError, settled };
  } finally {
    if (savedP) Object.defineProperty(P, 'update', savedP); else delete P.update;
    if (savedC) Object.defineProperty(P, 'commit', savedC); else delete P.commit;
    if (savedD) Object.defineProperty(DP, 'execute', savedD); else delete DP.execute;
    sel.removeAll(); this.selection.hits?.clear?.();
  }
}`;

try {
  const fx = await alignSheets(client);
  const fixtureDepth = (await status(client)).undoDepth;
  out.fixture = { sheetA: fx.sheetA, sheetB: fx.sheetB, edgeA: fx.edgeA.id, edgeB: fx.edgeB.id, fixtureDepth, edgeBcenterBefore: fx.edgeB.centerMm, edgeAcenter: fx.edgeA.centerMm };
  for (const continuity of wanted) {
    const trial: any = {};
    try {
      trial.run = await runtime.mutate(runAlign, ["AlignEdgeFactory", "AlignEdgeDialog", "AlignEdgeCommand", "ContinuityType"], [process.env.SWAP === "1" ? { a: { bodyId: fx.sheetB, edgeId: fx.edgeB.id }, b: { bodyId: fx.sheetA, edgeId: fx.edgeA.id }, continuity, mode } : { a: { bodyId: fx.sheetA, edgeId: fx.edgeA.id }, b: { bodyId: fx.sheetB, edgeId: fx.edgeB.id }, continuity, mode }], 40000);
      const st = await status(client);
      trial.undoAfter = st.undoDepth;
      trial.bodies = (st.bodies as any[]).filter((b) => ![1, 3, 4, 5].includes(b.id)).map((b) => ({ id: b.id, type: b.type, faceCount: b.faceCount, edgeCount: b.edgeCount, boundsMm: b.boundsMm }));
      const Bi = await info(client, fx.sheetB).catch((e) => ({ error: errText(e) }) as any);
      trial.sheetB = Bi.error ? Bi : { surface: Bi.faces.map((f: any) => f.surfaceType), vertical: Bi.edges.filter((e: any) => e.tangent && Math.abs(Math.abs(e.tangent[2]) - 1) < 1e-6).map((e: any) => ({ id: e.id, centerMm: e.centerMm })) };
      const Av = await info(client, fx.sheetA).catch(() => null);
      trial.sheetAvertical = Av ? Av.edges.filter((e: any) => e.tangent && Math.abs(Math.abs(e.tangent[2]) - 1) < 1e-6).map((e: any) => ({ id: e.id, centerMm: e.centerMm })) : null;
      trial.swap = process.env.SWAP === "1";
      const Ai = await info(client, fx.sheetA).catch((e) => ({ error: errText(e) }) as any);
      trial.sheetAunchanged = Ai.error ? Ai : Ai.edges.some((e: any) => e.centerMm && Math.abs(e.centerMm[0] - 5030) < 1e-6 && Math.abs(e.centerMm[1] - 5) < 1e-6);
      const join = await tryCall(client, "plasticity_join_sheets", { ids: [fx.sheetA, fx.sheetB], intent: "probe join after align", revision: await rev(client) });
      trial.join = join.ok ? "ok" : join.error;
      if (join.ok) {
        const joined = ((await status(client)).bodies as any[]).find((b) => b.type === "Sheet" && b.faceCount === 2);
        const J = await info(client, joined.id);
        const shared = J.edges.filter((e) => e.faceIds.length === 2);
        trial.continuity = (await call(client, "plasticity_analyze_surface_continuity", { edges: shared.map((e) => ({ bodyId: joined.id, edgeId: e.id })), revision: await rev(client) })).analyses;
      }
    } catch (e) { trial.error = errText(e); }
    try { trial.logAfterError = trial.run ? undefined : await runtime.read(`function () { return globalThis.__alignLog ?? null; }`, [], 5000); } catch (e) { trial.logReadError = errText(e); }
    try { trial.cancel = await runtime.read(cancelSource, [], 20000); } catch (e) { trial.cancelError = errText(e); }
    try { await undoTo(client, fixtureDepth); } catch (e) { trial.undoError = errText(e); }
    trial.depthAfterUndo = (await status(client)).undoDepth;
    out.trials[continuity] = trial;
  }
} catch (e) {
  out.error = errText(e);
} finally {
  try { out.finalCancel = await runtime.read(cancelSource, [], 20000); } catch (e) { out.finalCancelError = errText(e); }
  try { await undoTo(client, start.undoDepth); } catch (e) { out.finalUndoError = errText(e); }
  const end = await status(client);
  out.endUndo = end.undoDepth; out.endBodies = (end.bodies as any[]).map((b) => b.id);
  save(process.argv[3] ?? "probe-align-3.json", out);
  runtime.close(); await client.close();
}
process.exit(0);
