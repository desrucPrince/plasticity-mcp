// The late-commit question through the operations layer (re-review of 61b054e, Part 1 item 1): setDrivingDistance
// with a 1 ms finish wait, injected like the tests do, so the tool cancels its command right after finish(). Records
// the tool's error, whether it marked the runtime uncertain, and the Undo depth and body right away and 2 s later.
// A control run uses the default timeouts. Run from this directory with env.sh sourced: node probe-late-commit-ops.ts
import { connect, save } from "./harness.ts";
import { call, startMcp, status, undoTo } from "./mcp.ts";
import { PlasticityOperations, PICK_COMMAND_TIMEOUTS } from "../../src/plasticity/operations.ts";

const runtime = await connect();
const client = await startMcp();
const start = await status(client);
const out: Record<string, unknown> = { start: { undo: start.undoDepth, bodies: start.bodies.length }, trials: [] as unknown[] };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const before = await status(client);
  await call(client, "plasticity_create_box", { originMm: [2400, 0, 0], sizeMm: [20, 10, 5], revision: before.revision });
  const withBox = await status(client);
  const box = withBox.bodies.find((body: any) => !before.bodies.some((old: any) => old.id === body.id));
  const trials: Array<{ label: string; timeouts: any; drive?: string }> = [
    { label: "finishMs_1", timeouts: { dialogMs: 3000, finishMs: 1, cancelMs: 3000 } },
    { label: "finishMs_1_again", timeouts: { dialogMs: 3000, finishMs: 1, cancelMs: 3000 } },
    { label: "finishMs_3", timeouts: { dialogMs: 3000, finishMs: 3, cancelMs: 3000 } },
    { label: "control_default", timeouts: PICK_COMMAND_TIMEOUTS },
    // The tool polls every 10 ms and a box commit lands about 9 ms after finish(), so a 1-3 ms finish wait still sees
    // the commit. These runPickCommand trials call finish() 5 ms into a drive step that never returns: the tool sees
    // the drive still running at its first poll and cancels its command about 5 ms after finish().
    { label: "runPick_finish_at_5ms_then_hang", timeouts: { dialogMs: 3000, finishMs: 1, cancelMs: 3000 }, drive: "params.distance = driveArgs.distanceM; setTimeout(() => dialog.finish(), 5); await new Promise(() => {});" },
    { label: "runPick_finish_at_5ms_then_hang_again", timeouts: { dialogMs: 3000, finishMs: 1, cancelMs: 3000 }, drive: "params.distance = driveArgs.distanceM; setTimeout(() => dialog.finish(), 5); await new Promise(() => {});" },
  ];
  for (const trial of trials) {
    const checkpoint = await status(client);
    const info = (await call(client, "plasticity_body_info", { id: box.id })).body;
    const px = info.faces.find((face: any) => face.normal[0] > 0.999);
    const nx = info.faces.find((face: any) => face.normal[0] < -0.999);
    const operations = new PlasticityOperations(runtime);
    const started = Date.now();
    let result: any = null, error: string | null = null;
    try {
      if (trial.drive) {
        result = await (operations as any).runPickCommand({
          command: "DimensionDistanceCommand", dialog: "DimensionDistanceSpaceDialog",
          select: [{ kind: "face", bodyId: box.id, id: nx.id }, { kind: "face", bodyId: box.id, id: px.id }],
          hits: [{ item: { kind: "face", bodyId: box.id, id: px.id }, pointM: px.centerMm.map((v: number) => v / 1000), normalM: px.normal, onFace: true }],
          drive: "const params = dialog.params; " + trial.drive, driveArgs: { distanceM: 0.03 },
          rejectedMessage: "no effect", label: "Driving distance (late-commit probe)", timeouts: trial.timeouts,
        });
      } else {
        const { state: _state, ...rest } = await operations.setDrivingDistance({ bodyId: box.id, movingFaceId: px.id, referenceFaceId: nx.id, distanceMm: 30 }, checkpoint.revision, trial.timeouts);
        result = rest;
      }
    } catch (thrown) { error = (thrown as Error).message; }
    const elapsedMs = Date.now() - started;
    const uncertain = runtime.isUncertain();
    const now = await status(client);
    await sleep(2000);
    const later = await status(client);
    const record = {
      label: trial.label, timeouts: trial.timeouts, elapsedMs, error, result, uncertain,
      undoDeltaNow: now.undoDepth - checkpoint.undoDepth, undoDelta2sLater: later.undoDepth - checkpoint.undoDepth,
      maxXMmLater: later.bodies.find((body: any) => body.id === box.id)?.boundsMm?.max?.[0],
    };
    (out.trials as unknown[]).push(record);
    console.error(JSON.stringify(record));
    if (uncertain) await runtime.reconcile();
    await undoTo(client, checkpoint.undoDepth);
  }
} catch (error) { out.failure = (error as Error).message; console.error("ERROR", (error as Error).message); }
finally {
  await undoTo(client, start.undoDepth);
  const end = await status(client);
  out.end = { undo: end.undoDepth, bodies: end.bodies.length };
  console.error("restored", out.start, out.end);
  save("probe-late-commit-ops.json", out);
  await client.close(); runtime.close(); process.exit(0);
}
