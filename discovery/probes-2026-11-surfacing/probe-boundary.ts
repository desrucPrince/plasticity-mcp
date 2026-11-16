// Item 2: free (boundary/laminar) edges and closure. Fixtures: open L-sheet, closed box, sheet with a hole,
// cylinder-wall sheet (seam check). Three readers per body: the kernel (EdgeCollection.Laminar / IsClosed,
// Edge.IsLaminar), the shipped plasticity_validate_bodies, and the native FindBoundaryEdgesCommand.
import { connect, save, errText, nativeFunction } from "./harness.ts";
import { startMcp, call, status, undoTo } from "./mcp.ts";
import { rev, created, info, faceNormal } from "./fixtures.ts";

const client = await startMcp();
const runtime = await connect();
const start = await status(client);
const out: any = { startUndo: start.undoDepth, bodies: {} };
const ids = async () => new Set(((await status(client)).bodies as any[]).map((b) => b.id));

const kernelRead = nativeFunction`function (args) {
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item; throw new Error('Unknown body ' + id); };
  const item = find(args.bodyId);
  const coll = item.model.GetEdges();
  const all = coll.GetEdges();
  const lam = coll.Laminar();
  const lamEdges = lam.GetEdges();
  const toVersion = e => { const i = item.view.high.edges.get ? null : null; for (let k = 0; k < item.view.high.edges.versionIds.length; k++) if (Number(item.view.high.edges.get(k).entityId) === Number(e.Id())) return item.view.high.edges.versionIds[k]; return null; };
  return { type: item.view.constructor.name, edgeCount: coll.Size(), laminarCount: lam.Size(), laminarIds: lamEdges.map(toVersion),
    perEdgeIsLaminar: all.filter(e => e.IsLaminar()).map(toVersion), collIsLaminar: coll.IsLaminar(), collIsClosed: coll.IsClosed(),
    nonLaminar: coll.NonLaminar().Size(), check: Array.from(item.model.Check(), Number) };
}`;

const nativeCommand = nativeFunction`async function (args) {
  // Select the body, run FindBoundaryEdgesCommand, read the resulting selection, then clear it.
  const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item; throw new Error('Unknown body ' + id); };
  const item = find(args.bodyId);
  const sel = this.selection.selected;
  const undo0 = this.history.undoStack.length;
  sel.removeAll();
  sel.add(item.view);
  const undo1 = this.history.undoStack.length;
  let failure = null;
  const cmd = new this.commands.FindBoundaryEdgesCommand(this);
  const orig = cmd.execute.bind(cmd);
  cmd.execute = async () => { try { return await orig(); } catch (e) { failure = String(e?.message ?? e); throw e; } };
  await this.exec(cmd);
  const edges = [...(sel.edges ?? [])].map(e => ({ versionId: e.versionId ?? null, parent: e.parentItem ? nativeApi.db.lookupStableId(e.parentItem.versionId ?? e.parentItem.simpleName) : null }));
  const solids = [...(sel.solids ?? [])].length, shells = [...(sel.sheets ?? sel.shells ?? [])].length;
  const undo2 = this.history.undoStack.length;
  const active = this.executor.active?.command?.constructor?.name ?? null;
  sel.removeAll();
  return { failure, selectedEdges: edges, selectedEdgeIds: edges.map(e => e.versionId), solids, shells, undo: [undo0, undo1, undo2, this.history.undoStack.length], activeAfter: active };
}`;

async function record(name: string, bodyId: number) {
  const entry: any = { bodyId };
  const b = await info(client, bodyId);
  entry.type = b.type; entry.faces = b.faces.length; entry.edges = b.edges.length;
  entry.readModelOneFaceEdges = b.edges.filter((e) => e.faceIds.length === 1).map((e) => e.id);
  try { entry.kernel = await runtime.readNative(kernelRead, [], [{ bodyId }], 30000); } catch (e) { entry.kernelError = errText(e); }
  try { entry.validate = (await call(client, "plasticity_validate_bodies", { ids: [bodyId], revision: await rev(client) })).bodies[0]; } catch (e) { entry.validateError = errText(e); }
  try { entry.command = await runtime.mutate(nativeCommand, [], [{ bodyId }], 30000); } catch (e) { entry.commandError = errText(e); }
  entry.undoAfter = (await status(client)).undoDepth;
  out.bodies[name] = entry;
}

try {
  // 1. Open L-sheet: polyline with two segments extruded 10 mm.
  let before = await ids();
  await call(client, "plasticity_create_polyline", { pointsMm: [[5000, 0, 0], [5020, 0, 0], [5020, 15, 0]], closed: false, intent: "probe L", revision: await rev(client) });
  const wire = (await created(client, before))[0];
  await call(client, "plasticity_extrude_curves", { ids: [wire.id], distanceMm: 10, direction: [0, 0, 1], intent: "probe L sheet", revision: await rev(client) });
  const lsheet = (await created(client, before)).find((b) => b.type === "Sheet");
  out.depthAfterSheet = (await status(client)).undoDepth;
  await record("openLSheet", lsheet.id);

  // 2. Closed box.
  before = await ids();
  await call(client, "plasticity_create_box", { originMm: [5100, 0, 0], sizeMm: [30, 30, 10], intent: "probe box", revision: await rev(client) });
  const box = (await created(client, before))[0];
  await record("closedBox", box.id);

  // 3. Box with a through hole, then its top face unjoined as a sheet with a hole.
  before = await ids();
  await call(client, "plasticity_create_box", { originMm: [5200, 0, 0], sizeMm: [30, 30, 10], intent: "probe holed box", revision: await rev(client) });
  const hb = (await created(client, before))[0];
  await call(client, "plasticity_create_cylinder", { centerMm: [5215, 15, -5], radiusMm: 5, heightMm: 20, intent: "probe hole tool", revision: await rev(client) });
  const cyl = (await created(client, new Set([...before, hb.id])))[0];
  await call(client, "plasticity_boolean", { targetIds: [hb.id], toolIds: [cyl.id], operation: "difference", intent: "probe hole", revision: await rev(client) });
  const top = (await info(client, hb.id)).faces.find(faceNormal([0, 0, 1]))!;
  before = await ids();
  await call(client, "plasticity_unjoin_faces", { faces: [{ bodyId: hb.id, faceId: top.id }], intent: "probe holed sheet", revision: await rev(client) });
  const holed = (await created(client, before)).find((b) => b.type === "Sheet");
  await record("sheetWithHole", holed.id);
  await record("holedBoxRemainder", hb.id);

  // 4. Cylinder wall sheet (periodic face, seam check).
  before = await ids();
  await call(client, "plasticity_create_cylinder", { centerMm: [5300, 0, 0], radiusMm: 5, heightMm: 10, intent: "probe cylinder", revision: await rev(client) });
  const c2 = (await created(client, before))[0];
  const wall = (await info(client, c2.id)).faces.find((f) => !f.planar)!;
  before = await ids();
  await call(client, "plasticity_unjoin_faces", { faces: [{ bodyId: c2.id, faceId: wall.id }], intent: "probe wall sheet", revision: await rev(client) });
  const wallSheet = (await created(client, before)).find((b) => b.type === "Sheet");
  await record("cylinderWallSheet", wallSheet.id);
  await record("cylinderRemainder", c2.id);
} catch (e) {
  out.error = errText(e);
} finally {
  try { await runtime.mutate(`function () { this.selection.selected.removeAll(); }`, [], [], 10000); } catch {}
  await undoTo(client, start.undoDepth);
  const end = await status(client);
  out.endUndo = end.undoDepth; out.endBodies = (end.bodies as any[]).map((b) => b.id);
  save("probe-boundary.json", out);
  runtime.close(); await client.close();
}
process.exit(0);
