// Live check of the own-command cancel: runs the real runPickCommand source with a drive step that sets the
// distance but never calls finish(). The tool must cancel ITS command (identity check executor.active.command ===
// command) in the same call: outcome cancelled, runtime certain, Undo depth and editor unchanged.
import { connect, nativeFunction, save } from "./harness.ts";
import { call, startMcp, status, undoTo } from "./mcp.ts";
import { PlasticityOperations } from "../../src/plasticity/operations.ts";

const runtime = await connect();
const client = await startMcp();
const start = await status(client);
const out: Record<string, unknown> = { start: { undo: start.undoDepth, bodies: start.bodies.length } };
const editorState = nativeFunction`function () {
  let selected = 0;
  for (const value of Object.values(this.selection.selected)) if ((value instanceof Set || value instanceof Map) && typeof value.size === 'number') selected += value.size;
  return { undo: this.history.undoStack.length, active: this.executor.active ? (this.executor.active.command?.constructor?.name ?? 'unknown') : null, selected, hits: this.selection.hits.hits?.size ?? null };
}`;
try {
  const before = await status(client);
  await call(client, "plasticity_create_box", { originMm: [2400, 0, 0], sizeMm: [20, 10, 5], revision: before.revision });
  const st = await status(client);
  const box = st.bodies.find((body: any) => !before.bodies.some((old: any) => old.id === body.id));
  const info = (await call(client, "plasticity_body_info", { id: box.id })).body;
  const px = info.faces.find((face: any) => face.normal[0] > 0.999);
  const nx = info.faces.find((face: any) => face.normal[0] < -0.999);
  const operations = new PlasticityOperations(runtime);
  out.editorBefore = await runtime.read(editorState);
  let message = "";
  const started = Date.now();
  try {
    await (operations as any).runPickCommand({
      command: "DimensionDistanceCommand", dialog: "DimensionDistanceSpaceDialog",
      select: [{ kind: "face", bodyId: box.id, id: nx.id }, { kind: "face", bodyId: box.id, id: px.id }],
      hits: [{ item: { kind: "face", bodyId: box.id, id: px.id }, pointM: px.centerMm.map((v: number) => v / 1000), normalM: px.normal, onFace: true }],
      drive: "dialog.params.distance = driveArgs.distanceM; await dialog.params.update?.(); return null;",
      driveArgs: { distanceM: 0.03 },
      rejectedMessage: "no effect", label: "Driving distance (cancel probe)",
      timeouts: { dialogMs: 3000, finishMs: 800, cancelMs: 3000 },
    });
    message = "UNEXPECTED: committed";
  } catch (error) { message = (error as Error).message; }
  out.elapsedMs = Date.now() - started;
  out.message = message;
  out.runtimeUncertain = runtime.isUncertain();
  out.editorAfter = await runtime.read(editorState);
  const after = await status(client);
  out.undo = [st.undoDepth, after.undoDepth];
  out.boundsAfter = after.bodies.find((body: any) => body.id === box.id)?.boundsMm;
  console.log(JSON.stringify(out, null, 1));
} catch (error) { out.failure = (error as Error).message; console.error("ERROR", (error as Error).message); }
finally {
  if (!runtime.isUncertain()) await undoTo(client, start.undoDepth);
  const end = await status(client);
  out.end = { undo: end.undoDepth, bodies: end.bodies.length };
  console.error("restored", out.start, out.end);
  save("probe-cancel.json", out);
  await client.close(); runtime.close(); process.exit(0);
}
