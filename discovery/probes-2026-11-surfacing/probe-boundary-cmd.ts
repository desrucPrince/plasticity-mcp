// Item 2, native command: FindBoundaryEdgesCommand on an open L-sheet and on a cylinder-wall sheet.
// The first run (probe-boundary.json) timed out in exec(); here exec is not awaited: the command runs, the
// selection is read after it, any chained command is cancelled, and the selection is cleared.
import { connect, save, errText, nativeFunction } from "./harness.ts";
import { startMcp, call, status, undoTo } from "./mcp.ts";
import { rev, created, info } from "./fixtures.ts";

const client = await startMcp();
const runtime = await connect();
const start = await status(client);
const out: any = { startUndo: start.undoDepth, runs: {} };
const ids = async () => new Set(((await status(client)).bodies as any[]).map((b) => b.id));

const runCommand = nativeFunction`async function (args) {
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item; throw new Error('Unknown body ' + id); };
  const item = find(args.bodyId);
  const sel = this.selection.selected;
  const trace = [];
  const snap = label => trace.push({ label, at: Date.now(), undo: this.history.undoStack.length, active: this.executor.active?.command?.constructor?.name ?? null,
    edges: [...(sel.edges ?? [])].map(e => e.versionId ?? null), solids: [...(sel.solids ?? [])].length, sheets: [...(sel.sheets ?? [])].length });
  sel.removeAll(); this.selection.hits?.clear?.();
  if (args.select) sel.add(item.view);
  snap('selected');
  let failure = null, settled = false;
  const cmd = new this.commands.FindBoundaryEdgesCommand(this);
  const orig = cmd.execute.bind(cmd);
  cmd.execute = async () => { try { const r = await orig(); snap('execute-returned'); return r; } catch (e) { failure = String(e?.message ?? e); throw e; } };
  const p = this.exec(cmd).then(() => { settled = true; }, e => { failure = failure ?? String(e?.message ?? e); settled = true; });
  for (let i = 0; i < 20 && !settled; i++) { await new Promise(r => setTimeout(r, 50)); if (i === 2 || i === 19) snap('poll' + i); }
  snap('before-cancel');
  let cancelled = null;
  if (!settled && this.executor.active) { try { await this.executor.cancelActiveCommand(); cancelled = true; } catch (e) { cancelled = 'err ' + e.message; } }
  for (let i = 0; i < 40 && !settled; i++) await new Promise(r => setTimeout(r, 50));
  snap('after-cancel');
  sel.removeAll();
  snap('cleared');
  return { failure, settled, cancelled, trace };
}`;

try {
  let before = await ids();
  await call(client, "plasticity_create_polyline", { pointsMm: [[5000, 0, 0], [5020, 0, 0], [5020, 15, 0]], closed: false, intent: "probe L", revision: await rev(client) });
  const wire = (await created(client, before))[0];
  await call(client, "plasticity_extrude_curves", { ids: [wire.id], distanceMm: 10, direction: [0, 0, 1], intent: "probe L sheet", revision: await rev(client) });
  const lsheet = (await created(client, before)).find((b) => b.type === "Sheet");
  out.lsheet = { id: lsheet.id, oneFaceEdges: (await info(client, lsheet.id)).edges.filter((e) => e.faceIds.length === 1).map((e) => e.id) };
  for (const select of [true, false]) {
    try { out.runs["lsheet_select_" + select] = await runtime.mutate(runCommand, [], [{ bodyId: lsheet.id, select }], 20000); } catch (e) { out.runs["lsheet_select_" + select] = { error: errText(e) }; }
    out.runs["lsheet_select_" + select].undoAfterMcp = (await status(client)).undoDepth;
  }

  // Cylinder wall as a sheet: unjoin the side face and pick the non-planar sheet.
  before = await ids();
  await call(client, "plasticity_create_cylinder", { centerMm: [5300, 0, 0], radiusMm: 5, heightMm: 10, intent: "probe cylinder", revision: await rev(client) });
  const c2 = (await created(client, before))[0];
  const wall = (await info(client, c2.id)).faces.find((f) => !f.planar)!;
  before = await ids();
  await call(client, "plasticity_unjoin_faces", { faces: [{ bodyId: c2.id, faceId: wall.id }], intent: "probe wall sheet", revision: await rev(client) });
  const after = await created(client, before);
  const all = [c2, ...after];
  out.cylinderParts = [];
  for (const b of all) {
    const bi = await info(client, b.id);
    out.cylinderParts.push({ id: b.id, type: bi.type, faces: bi.faces.map((f) => f.surfaceType), edges: bi.edges.map((e) => ({ id: e.id, curveType: e.curveType, faces: e.faceIds.length })) });
  }
  const wallBody = out.cylinderParts.find((p: any) => p.faces.includes("Cylinder"));
  out.wallValidate = (await call(client, "plasticity_validate_bodies", { ids: [wallBody.id], revision: await rev(client) })).bodies[0];
} catch (e) {
  out.error = errText(e);
} finally {
  await undoTo(client, start.undoDepth);
  const end = await status(client);
  out.endUndo = end.undoDepth; out.endBodies = (end.bodies as any[]).map((b) => b.id);
  save("probe-boundary-cmd.json", out);
  runtime.close(); await client.close();
}
process.exit(0);
