// Proof items 1, 2 and 4 (+ which-face-moves): drive the real DimensionDistanceCommand on a 20x10x5 mm box at x=2000.
// Mechanism: programmatic face selection + seeded selection click point (selection.hits.record) + the command's own
// DimensionDistanceSpaceDialog, finished natively. Read-back through MCP plasticity_status / plasticity_body_info,
// undo through MCP plasticity_undo. Uninstrumented (no prototype patching).
import { connect, depth, mcp, save, errText, nativeFunction } from "./harness.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HERE } from "./harness.ts";

const src = readFileSync(join(HERE, "js/driving-distance.js"), "utf8");
const runtime = await connect();
const session = await mcp();
const log: any = { startNative: await depth(runtime), trials: [] };
const mm = (v: number) => v / 1000;

async function status() {
  const st = await session.raw("plasticity_status", { bodyLimit: 200 });
  return st as { revision: string; undoDepth: number; bodies: any[] };
}
async function boxState(id: number) {
  const st = await status();
  const b = st.bodies.find((x) => x.id === id);
  return { revision: st.revision, undoDepth: st.undoDepth, bodyCount: st.bodies.length, boundsMm: b?.boundsMm, sizeXmm: b ? b.boundsMm.max[0] - b.boundsMm.min[0] : null };
}
async function faces(id: number) {
  const info = (await session.raw("plasticity_body_info", { id })).body;
  const byNormal = (n: number[]) => info.faces.find((f: any) => f.normal && f.normal.every((c: number, i: number) => Math.abs(c - n[i]!) < 1e-9));
  return { xNeg: byNormal([-1, 0, 0]), xPos: byNormal([1, 0, 0]), zPos: byNormal([0, 0, 1]) };
}
async function native(args: any) {
  return await runtime.mutate<any>(nativeFunction([src] as any), ["DimensionDistanceCommand", "DimensionDistanceSpaceDialog"], [args], 30000);
}

async function trial(label: string, boxId: number, opts: { targetMm?: number; mode: "factory" | "keys" | "hang"; text?: string; moving?: "xPos" | "xNeg"; hit?: "moving" | "none" | "zPos" }) {
  const entry: any = { label, opts };
  try {
    const before = await boxState(boxId);
    const f = await faces(boxId);
    const movingKey = opts.moving ?? "xPos";
    const refKey = movingKey === "xPos" ? "xNeg" : "xPos";
    const moving = f[movingKey], ref = f[refKey];
    const hitFace = opts.hit === "zPos" ? f.zPos : moving;
    const hit = opts.hit === "none" ? null : { face: hitFace.id, point: hitFace.centerMm.map(mm), normal: hitFace.normal };
    entry.before = before;
    entry.faces = { ref: ref.id, moving: moving.id, hit: hit?.face ?? null };
    entry.native = await native({ bodyId: boxId, faces: [ref.id, moving.id], hit, mode: opts.mode, distanceM: opts.targetMm !== undefined ? mm(opts.targetMm) : undefined, text: opts.text, dialogTimeoutMs: 2000, finishTimeoutMs: 5000, hangMs: 1500 });
    entry.after = await boxState(boxId);
    entry.undoSteps = entry.after.undoDepth - before.undoDepth;
    if (opts.targetMm !== undefined) entry.pass = entry.native.end.undoDelta === 1 && entry.undoSteps === 1 && Math.abs(entry.after.sizeXmm - opts.targetMm) < 1e-3 && entry.native.end.active === null && !entry.native.end.inputLeft;
    if (entry.undoSteps > 0) {
      await session.raw("plasticity_undo", { steps: entry.undoSteps, revision: entry.after.revision });
      entry.afterUndo = await boxState(boxId);
      entry.undoRestored = Math.abs(entry.afterUndo.sizeXmm - 20) < 1e-3 && entry.afterUndo.undoDepth === before.undoDepth;
    }
  } catch (error) { entry.error = errText(error); }
  log.trials.push(entry);
  console.log(label, JSON.stringify({ pass: entry.pass, before: entry.before?.sizeXmm, after: entry.after?.sizeXmm, min: entry.after?.boundsMm?.min[0], max: entry.after?.boundsMm?.max[0], undo: [entry.before?.undoDepth, entry.after?.undoDepth, entry.afterUndo?.undoDepth], restored: entry.undoRestored, end: entry.native?.end, error: entry.error }));
}

try {
  const s0 = await status();
  log.start = { undoDepth: s0.undoDepth, bodies: s0.bodies.map((b) => b.id) };
  await session.raw("plasticity_create_box", { originMm: [2000, 0, 0], sizeMm: [20, 10, 5], revision: s0.revision });
  const s1 = await status();
  const box = s1.bodies.find((b) => !s0.bodies.some((o) => o.id === b.id));
  log.box = { id: box.id, boundsMm: box.boundsMm, undoDepth: s1.undoDepth };

  // Proof 1: 20 -> 30 mm, value through the factory field (native meters), dialog finished natively.
  await trial("p1_factory_30", box.id, { targetMm: 30, mode: "factory" });
  // Proof 1b: same through the dialog's own text input (keyboard events), decimal value.
  await trial("p1b_keys_27.5", box.id, { targetMm: 27.5, mode: "keys", text: "27.5" });
  await trial("p1c_keys_31mm_unit_suffix", box.id, { targetMm: 31, mode: "keys", text: "31 mm" });
  // Proof 2: five in a row from a clean state.
  for (const v of [30, 25, 42.5, 12.25, 37]) await trial(`p2_repeat_${v}`, box.id, { targetMm: v, mode: "factory" });
  // Which face moves: the face that carries the seeded click point.
  await trial("which_face_hit_on_xNeg_30", box.id, { targetMm: 30, mode: "factory", moving: "xNeg" });
  // Proof 4: failure paths.
  await trial("fail_no_hit", box.id, { targetMm: 30, mode: "factory", hit: "none" });
  await trial("fail_hit_on_unselected_face", box.id, { targetMm: 30, mode: "factory", hit: "zPos" });
  await trial("fail_hang_then_timeout_cancel", box.id, { targetMm: 30, mode: "hang" });
  log.final = await boxState(box.id);
  log.summary = {
    proof1: log.trials.find((t: any) => t.label === "p1_factory_30")?.pass,
    proof2: `${log.trials.filter((t: any) => t.label.startsWith("p2_") && t.pass && t.undoRestored).length}/5`,
  };
} catch (error) { log.fatal = errText(error); console.error(error); }
finally {
  log.endNative = await depth(runtime);
  save("prove-driving-distance.json", log);
  console.log("summary", JSON.stringify(log.summary), "endNative", JSON.stringify(log.endNative));
  await session.close();
  runtime.close();
  process.exit(0);
}
