// Turns the joined neoRC 11 back into an editable half with a live mirror: +X is the edit side.
// 1. Bodies that straddle X = 0 (except the rotationally built gyro parts) are cut at X = 0 with an oversized box;
//    the +X half is kept and its centre face is checked to lie on X = 0.
// 2. -X bodies that have a mirrored +X twin are deleted (only those; anything unique stays).
// 3. Every +X source gets a mirrored linked instance. Sources go in group "EDIT SIDE", instances in
//    "MIRROR (don't edit)". Gyro parts stay whole in "GYRO (centreline)".
// Note: body bounds can be loose (the split hull reads X -54); the side test here uses them, so mirror-missed.ts
// afterwards picks up any source whose exact faces lie at X >= 0 but was skipped (it caught the hull and roof sheet).
// Usage: PLASTICITY_CDP_URL=http://127.0.0.1:9223 node discovery/neorc11/user-half/split-mirror.ts
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openSession } from "../../mcp-client.ts";

const s = await openSession();
const raw = (n: string, a: Record<string, unknown> = {}) => s.raw(n, a);
const call = (t: string, a: Record<string, unknown> = {}) => raw("plasticity_call", { toolName: t, arguments: a });
const rev = async () => (await raw("plasticity_status", { bodyLimit: 1 })).revision as string;
async function bodies(): Promise<any[]> {
  const first = await raw("plasticity_status", { bodyLimit: 200 }); const all = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  return all;
}
const instances = async () => ((await call("plasticity_list_instances")).instances ?? []) as Array<{ id: number; sourceBodyIds: number[]; scale: number[] }>;
const notes: string[] = [];
const say = (...x: unknown[]) => { const t = x.map(String).join(" "); notes.push(t); console.log(t); };
const tol = 1;
const isGyro = (b: any) => (b.name ?? "").startsWith("rc11_Gyro");
const side = (b: any) => b.boundsMm.min[0] < -tol && b.boundsMm.max[0] > tol ? "both" : b.boundsMm.min[0] >= -tol ? "+X" : "-X";
const twin = (a: any, pool: any[]) => pool.find((b) => b.type === a.type
  && Math.abs(b.boundsMm.max[0] + a.boundsMm.min[0]) < tol && Math.abs(b.boundsMm.min[0] + a.boundsMm.max[0]) < tol
  && [1, 2].every((i) => Math.abs(b.boundsMm.min[i] - a.boundsMm.min[i]) < tol && Math.abs(b.boundsMm.max[i] - a.boundsMm.max[i]) < tol));

try {
  if ((await instances()).length) throw new Error("document already has linked instances; refusing to run twice");
  const vis = (await bodies()).filter((b) => b.visible !== false && b.type !== "Wire");
  const gyro = vis.filter(isGyro);

  // ---- 1. split straddlers at X = 0
  const straddle = vis.filter((b) => !isGyro(b) && side(b) === "both");
  say(`straddling bodies to split: ${straddle.map((b) => `${b.name}#${b.id}`).join(", ")}`);
  for (const group of [straddle.filter((b) => b.type === "Solid"), straddle.filter((b) => b.type === "Sheet")]) {
    if (!group.length) continue;
    const box = await raw("plasticity_batch", { undoOnError: true, steps: [{ toolName: "plasticity_create_box", arguments: { originMm: [-12000, -12000, -1000], sizeMm: [12000, 24000, 9000], name: "rc11_split_cutter" } }] });
    const cutter = box.steps[0].added[0] as number;
    try {
      await raw("plasticity_boolean", { targetIds: group.map((b) => b.id), toolIds: [cutter], operation: "difference", revision: await rev() });
    } catch (error) {
      say(`group boolean refused (${String(error).slice(0, 120)}); cutting one at a time`);
      for (const b of group) {
        const one = await raw("plasticity_batch", { undoOnError: true, steps: [{ toolName: "plasticity_create_box", arguments: { originMm: [-12000, -12000, -1000], sizeMm: [12000, 24000, 9000], name: "rc11_split_cutter" } }] });
        await raw("plasticity_boolean", { targetIds: [b.id], toolIds: [one.steps[0].added[0]], operation: "difference", revision: await rev() })
          .catch(async (e: unknown) => { say(`  ${b.name}#${b.id} refused: ${String(e).slice(0, 120)}`); await raw("plasticity_delete", { ids: [one.steps[0].added[0]], revision: await rev() }); });
      }
      if ((await bodies()).some((x) => x.id === cutter)) await raw("plasticity_delete", { ids: [cutter], revision: await rev() });
    }
  }
  // verify the split halves
  const now = await bodies();
  for (const b of straddle) {
    const h = now.find((x) => x.id === b.id);
    if (!h) { say(`  ${b.name}#${b.id}: gone after split`); continue; }
    const faces = (await raw("plasticity_body_info", { id: h.id })).body.faces as any[];
    const centre = faces.filter((f) => f.planar && Math.abs(f.boundsMm.min[0]) < 1e-3 && Math.abs(f.boundsMm.max[0]) < 1e-3);
    const minX = Math.min(...faces.map((f) => f.boundsMm.min[0]));
    say(`  ${h.name}#${h.id}: face min X ${minX.toExponential(2)}, centre faces on X=0: ${centre.length}${h.type === "Sheet" ? " (sheet: boundary edge on X=0)" : ""}`);
  }

  // ---- 2. delete -X bodies that have a +X twin (gyro parts excluded)
  const after = (await bodies()).filter((b) => b.visible !== false && b.type !== "Wire" && !isGyro(b));
  const pos = after.filter((b) => side(b) === "+X"), neg = after.filter((b) => side(b) === "-X");
  const left = new Set(neg.map((b) => b.id));
  const drop: number[] = [];
  for (const a of pos) { const t = twin(a, neg.filter((b) => left.has(b.id))); if (t) { left.delete(t.id); drop.push(t.id); } }
  // The -X rear tie-down sits 100 mm higher than its +X twin (an earlier placement slip); +X has the equivalent.
  for (const b of neg.filter((x) => left.has(x.id) && (x.name ?? "").startsWith("rc11_p_tiedown"))) { left.delete(b.id); drop.push(b.id); }
  const keptNeg = neg.filter((b) => left.has(b.id));
  if (keptNeg.length) say(`-X bodies kept (no +X twin): ${keptNeg.map((b) => `${b.name}#${b.id}`).join(", ")}`);
  if (drop.length) await raw("plasticity_delete", { ids: drop, revision: await rev() });
  say(`deleted ${drop.length} -X twins`);

  // ---- 3. mirrored instances for every +X source, in batches
  const sources = (await bodies()).filter((b) => b.visible !== false && b.type !== "Wire" && !isGyro(b) && side(b) === "+X");
  const before = new Set((await instances()).map((i) => i.id));
  for (let k = 0; k < sources.length; k += 40) {
    await raw("plasticity_batch", { steps: sources.slice(k, k + 40).map((b) => ({ toolName: "plasticity_create_mirrored_instance", arguments: { bodyId: b.id, axis: "x", planeOffsetMm: 0 } })) });
  }
  const made = (await instances()).filter((i) => !before.has(i.id));
  say(`mirrored instances: ${made.length} for ${sources.length} sources`);
  await call("plasticity_create_group", { bodyIds: sources.map((b) => b.id), name: "EDIT SIDE", revision: await rev() });
  await call("plasticity_create_group", { instanceIds: made.map((i) => i.id), name: "MIRROR (don't edit)", revision: await rev() });
  const gyroNow = (await bodies()).filter(isGyro);
  if (gyroNow.length) await call("plasticity_create_group", { bodyIds: gyroNow.map((b) => b.id), name: "GYRO (centreline)", revision: await rev() });
  say(`groups: EDIT SIDE (${sources.length} bodies), MIRROR (don't edit) (${made.length} instances), GYRO (centreline) (${gyroNow.length} bodies)`);

  // ---- 4. validate the sources
  const solids = sources.filter((b) => b.type === "Solid").map((b) => b.id);
  const v = await call("plasticity_validate_bodies", { ids: [...solids, ...gyroNow.filter((b) => b.type === "Solid").map((b) => b.id)], revision: await rev() });
  const rows = v.bodies ?? [];
  say(`validate: ${rows.filter((x: any) => x.closed && x.nativeValid).length}/${rows.length} valid${rows.some((x: any) => !x.closed || !x.nativeValid) ? `; invalid: ${rows.filter((x: any) => !x.closed || !x.nativeValid).map((x: any) => `${x.name}#${x.id}`).join(", ")}` : ""}`);
} finally {
  await writeFile(resolve("discovery/neorc11/user-half/split-mirror-log.json"), JSON.stringify(notes, null, 1));
  await s.close();
}
