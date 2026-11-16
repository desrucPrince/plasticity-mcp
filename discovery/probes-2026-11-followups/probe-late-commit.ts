// Live question (re-review of 61b054e, Part 1 item 1): does a Dimension commit land after the command is cancelled
// AFTER dialog.finish() was called? Raw trials drive DimensionDistanceCommand by hand: finish(), then cancel our
// command (identity-checked) after a chosen delay, then watch the Undo stack, the exec() promise and the active
// command for observeMs with timestamps. Node re-reads the document after a further pause. Each trial uses one
// 20 x 10 x 5 box at x >= 2400 mm; every landed commit is undone before the next trial.
// Run from this directory with env.sh sourced: node probe-late-commit.ts
import { connect, nativeFunction, save } from "./harness.ts";
import { call, startMcp, status, undoTo } from "./mcp.ts";

const runtime = await connect();
const client = await startMcp();
const start = await status(client);
const out: Record<string, unknown> = { start: { undo: start.undoDepth, bodies: start.bodies.length }, trials: [] as unknown[] };

// waitMs: "sync" cancels in the same tick as finish(); "microtask" after one awaited microtask; a number sleeps.
const TRIAL = nativeFunction`async function (Command, Dialog, Vector3, args) {
  const editor = this, executor = this.executor, selection = this.selection;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const name = c => c?.constructor?.name ?? null;
  if (executor.isBusy || executor.active) throw new Error('busy: ' + name(executor.active?.command));
  let item = null;
  for (const [versionId, candidate] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(versionId) === args.bodyId) item = candidate;
  const view = item.view;
  const faceView = id => view.high.faces.get(view.high.faces.versionIds.indexOf(id));
  const reference = faceView(args.referenceFaceId), moving = faceView(args.movingFaceId);
  let point = null;
  const faces = item.model.GetFaces();
  for (let index = 0; index < faces.Size(); index += 1) if (faces.Get(index).Id() === moving.entityId) point = faces.Get(index).GetAnyPointOn().position;
  selection.selected.removeAll(); selection.hits.clear();
  selection.selected.add(reference); selection.selected.add(moving);
  selection.hits.record(moving, new Vector3(point.x, point.y, point.z), new Vector3(...args.normal));
  const undoBefore = this.history.undoStack.length;
  const t0 = performance.now();
  const at = () => Math.round((performance.now() - t0) * 10) / 10;
  const events = [];
  let settled = false, execError = null, execErrorName = null, command = new Command(editor);
  command.remember = false;
  const original = command.execute.bind(command);
  command.execute = async function () {
    try { return await original(); }
    catch (error) { execError = String(error?.message ?? error); execErrorName = error?.constructor?.name ?? null; throw error; }
    finally { selection.selected.removeAll(); }
  };
  editor.exec(command).then(() => { settled = true; events.push(['exec-resolved', at()]); }, error => { settled = true; events.push(['exec-rejected', at(), String(error?.message ?? error)]); });
  let dialog = null;
  while (!dialog && at() < 3000) {
    editor.helpers.scene.traverse(object => { if (!dialog && object instanceof Dialog && object.params) dialog = object; });
    if (!dialog) await sleep(5);
  }
  if (!dialog) throw new Error('no dialog');
  dialog.params.distance = args.distanceM;
  const finishAt = at();
  dialog.finish();
  events.push(['finish-called', finishAt]);
  if (args.waitMs === 'microtask') await Promise.resolve();
  else if (typeof args.waitMs === 'number') await sleep(args.waitMs);
  const cancel = { at: at(), settledBefore: settled, undoBefore: this.history.undoStack.length - undoBefore, ourActiveBefore: executor.active?.command === command, activeBefore: name(executor.active?.command), threw: null, called: false };
  try { if (executor.active?.command === command) { cancel.called = true; executor.cancelActiveCommand(); } } catch (error) { cancel.threw = String(error?.message ?? error); }
  events.push(['cancel-returned', at()]);
  let lastUndo = this.history.undoStack.length, lastActive = name(executor.active?.command), lastSettled = settled;
  while (at() - cancel.at < args.observeMs) {
    const undo = this.history.undoStack.length, active = name(executor.active?.command);
    if (undo !== lastUndo) { events.push(['undo', at(), undo - undoBefore]); lastUndo = undo; }
    if (active !== lastActive) { events.push(['active', at(), active]); lastActive = active; }
    if (settled !== lastSettled) lastSettled = settled;
    await sleep(2);
  }
  selection.selected.removeAll(); selection.hits.clear();
  return {
    waitMs: args.waitMs, finishAt, cancel, events, execError, execErrorName, settled,
    undoDelta: this.history.undoStack.length - undoBefore, ourActive: executor.active?.command === command, activeAtEnd: name(executor.active?.command),
    dialogStillInScene: (() => { let found = false; editor.helpers.scene.traverse(object => { if (object === dialog) found = true; }); return found; })(),
  };
}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const before = await status(client);
  await call(client, "plasticity_create_box", { originMm: [2400, 0, 0], sizeMm: [20, 10, 5], revision: before.revision });
  const withBox = await status(client);
  const box = withBox.bodies.find((body: any) => !before.bodies.some((old: any) => old.id === body.id));
  out.boxDepth = withBox.undoDepth;
  const waits: Array<string | number> = ["sync", "microtask", 0, 1, 2, 5, 10, 20, 50, 200];
  for (const waitMs of waits) {
    const checkpoint = await status(client);
    const info = (await call(client, "plasticity_body_info", { id: box.id })).body;
    const px = info.faces.find((face: any) => face.normal[0] > 0.999);
    const nx = info.faces.find((face: any) => face.normal[0] < -0.999);
    let trial: any;
    try {
      trial = await runtime.mutate<any>(TRIAL, ["DimensionDistanceCommand", "DimensionDistanceSpaceDialog", "Vector3"], [{
        bodyId: box.id, movingFaceId: px.id, referenceFaceId: nx.id, normal: px.normal, distanceM: 0.03, waitMs, observeMs: 3000,
      }], 30_000);
    } catch (error) { trial = { failure: (error as Error).message.slice(0, 2000) }; }
    await sleep(2000);
    const later = await status(client);
    const bodyLater = later.bodies.find((body: any) => body.id === box.id);
    trial.node = { undoDelta2sLater: later.undoDepth - checkpoint.undoDepth, maxXMm: bodyLater?.boundsMm?.max?.[0], landed: Math.abs((bodyLater?.boundsMm?.max?.[0] ?? 0) - 2430) < 1e-6 };
    (out.trials as unknown[]).push(trial);
    console.error(JSON.stringify({ waitMs, cancel: trial.cancel, events: trial.events, execError: trial.execError, node: trial.node }));
    if (later.undoDepth > checkpoint.undoDepth) await undoTo(client, checkpoint.undoDepth);
  }
} catch (error) { out.failure = (error as Error).message; console.error("ERROR", (error as Error).message); }
finally {
  await undoTo(client, start.undoDepth);
  const end = await status(client);
  out.end = { undo: end.undoDepth, bodies: end.bodies.length };
  console.error("restored", out.start, out.end);
  save("probe-late-commit.json", out);
  await client.close(); runtime.close(); process.exit(0);
}
