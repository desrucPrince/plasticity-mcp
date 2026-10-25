// Builds on the user's neoRC 11 half blockout (RC1BaseMeshV2: body+cabin "Solid.001", pod "Solid.003") in the
// open Plasticity document: clean split at X = 0, live mirrored instances, then added elements (fins, greebles,
// arrays), each one +X source body with linked instances for its repeats and a mirrored instance. Bodies it
// adds are named "rc11_*"; rerunning a stage deletes that stage's rc11_* bodies and their instances first.
// It never uses undo for resets, never saves, and leaves the hidden blockout_ref group alone.
// Usage: PLASTICITY_CDP_URL=http://127.0.0.1:9223 node discovery/neorc11/user-half/build-on-mesh.ts [stage ...]
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openSession } from "../../mcp-client.ts";

type Vec = [number, number, number];
type Box = { min: Vec; max: Vec };
type Body = { id: number; name: string | null; type: string; boundsMm: Box; faceCount?: number; visible?: boolean };
type Face = { id: string; surfaceType: string; planar: boolean; normal: Vec; boundsMm: Box; centerMm: Vec };
type Edge = { id: string; boundsMm: Box; lengthMm: number; curveType: string; line: boolean; faceIds: string[] };
type Step = { toolName: string; arguments?: Record<string, unknown> };

const outDir = resolve("discovery/neorc11/user-half");
const stages = process.argv.slice(2);
const s = await openSession();
const raw = (name: string, args: Record<string, unknown> = {}) => s.raw(name, args);
const call = (toolName: string, args: Record<string, unknown> = {}) => raw("plasticity_call", { toolName, arguments: args });
const batch = (steps: Step[], undoOnError = true) => raw("plasticity_batch", { steps, undoOnError });
const status = () => raw("plasticity_status");
const rev = async () => (await status()).revision as string;
const step = (toolName: string, args: Record<string, unknown> = {}): Step => ({ toolName, arguments: args });
const r = (v: number) => Math.round(v * 100) / 100;
const D = Math.PI / 180;

const logPath = resolve(outDir, "build-log.json");
const log: Record<string, { ok: boolean; ms: number; notes: string[] }> = existsSync(logPath) ? JSON.parse(await readFile(logPath, "utf8")) : {};
const contPath = resolve(outDir, "continuity.json");
const continuity: Record<string, { edges: number; maxG0mm: number; maxG1deg: number; maxRelG2: number; verdict: string }> = existsSync(contPath) ? JSON.parse(await readFile(contPath, "utf8")) : {};
async function stage(name: string, run: (notes: string[]) => Promise<void>) {
  if (stages.length && !stages.includes(name)) return;
  const t = performance.now();
  const notes: string[] = [];
  let ok = true;
  try { await run(notes); } catch (error) { ok = false; notes.push(`FAILED: ${String(error).slice(0, 1500)}`); }
  log[name] = { ok, ms: Math.round(performance.now() - t), notes };
  console.log(ok ? "OK  " : "FAIL", name, Math.round(performance.now() - t), "ms\n   " + notes.join("\n   "));
  await writeFile(logPath, JSON.stringify(log, null, 1));
  await writeFile(contPath, JSON.stringify(continuity, null, 1));
  if (!ok) { await s.close(); process.exit(1); }
}

const bodies = async (): Promise<Body[]> => (await status()).bodies;
const fmt = (b: Body) => `${b.name}#${b.id} [${b.boundsMm.min.map(Math.round)}]..[${b.boundsMm.max.map(Math.round)}]`;
async function byName(name: string): Promise<Body> {
  const found = (await bodies()).filter((b) => b.name === name);
  if (found.length !== 1) throw new Error(`expected one body named ${name}, found ${found.length}`);
  return found[0]!;
}
const info = async (id: number) => (await raw("plasticity_body_info", { id })).body as { faces: Face[]; edges: Edge[]; faceCount: number; boundsMm: Box };
async function rename(id: number, name: string) { await call("plasticity_rename", { id, name, revision: await rev() }); }
async function hide(ids: number[]) { if (ids.length) await call("plasticity_set_visibility", { bodyIds: ids, visible: false, revision: await rev() }); }
const instances = async () => ((await call("plasticity_list_instances")).instances ?? []) as Array<{ id: number; sourceBodyIds: number[]; scale: Vec; translationMm: Vec }>;
async function measure(label: string, id: number, edgeIds: string[]) {
  if (!edgeIds.length) return;
  const res = await call("plasticity_analyze_surface_continuity", { edges: edgeIds.slice(0, 400).map((edgeId) => ({ bodyId: id, edgeId })), revision: await rev() });
  const tangent = (res.analyses ?? []).filter((a: any) => a.maximumNormalAngleDeviationDeg < 1);
  if (!tangent.length) return;
  const max = (k: string) => Math.max(...tangent.map((a: any) => Number(a[k]) || 0));
  const g2 = max("maximumRelativeCurvatureDeviation");
  continuity[label] = { edges: tangent.length, maxG0mm: r(max("maximumPositionDeviationMm")), maxG1deg: Math.round(max("maximumNormalAngleDeviationDeg") * 1e4) / 1e4, maxRelG2: Math.round(g2 * 1000) / 1000, verdict: g2 <= 0.05 ? "G2" : "G1 only" };
}
// Fillet, then measure continuity on the edges the fillet created. Returns false (and notes why) on failure.
async function fillet(id: number, edgeIds: string[], radiusMm: number, shape: "g2" | "round", label: string, notes: string[]) {
  if (!edgeIds.length) { notes.push(`${label}: no edges found`); return false; }
  const before = new Set((await info(id)).edges.map((e) => e.id));
  try { await raw("plasticity_fillet", { id, edgeIds, radiusMm, shape, revision: await rev() }); }
  catch (error) { notes.push(`${label}: fillet r${radiusMm} ${shape} on ${edgeIds.length} edges FAILED (${String(error).slice(0, 220)})`); return false; }
  notes.push(`${label}: ${edgeIds.length} edges r${radiusMm} ${shape}`);
  if (shape === "g2") await measure(label, id, (await info(id)).edges.filter((e) => !before.has(e.id)).map((e) => e.id));
  return true;
}
// Delete rc11_* bodies whose names start with prefix, and every instance of them.
async function clear(prefix: string) {
  const mine = (await bodies()).filter((b) => (b.name ?? "").startsWith(prefix));
  if (!mine.length) return 0;
  const ids = new Set(mine.map((b) => b.id));
  const inst = (await instances()).filter((i) => i.sourceBodyIds.some((x) => ids.has(x))).map((i) => i.id);
  if (inst.length) await call("plasticity_delete_instances", { ids: inst, revision: await rev() });
  await raw("plasticity_delete", { ids: [...ids], revision: await rev() });
  return mine.length;
}
// One linked instance per placement (translation, optional rotation about pivot/axis) plus a mirrored instance
// across X = 0 for the source and for each placement.
async function place(sourceId: number, placements: Array<{ t: Vec; rotate?: { pivot: Vec; axis: Vec; deg: number } }>, mirror = true) {
  let n = 0;
  const all = [{ t: [0, 0, 0] as Vec, source: true }, ...placements.map((p) => ({ ...p, source: false }))];
  for (const p of all) {
    if (!p.source) {
      const before = new Set((await instances()).map((i) => i.id));
      await call("plasticity_create_instance", { bodyId: sourceId, translationMm: p.t, revision: await rev() });
      const id = (await instances()).find((i) => !before.has(i.id))!.id;
      if ("rotate" in p && p.rotate) await call("plasticity_rotate_instances", { ids: [id], pivotMm: p.rotate.pivot, axis: p.rotate.axis, degrees: p.rotate.deg, revision: await rev() });
      n++;
    }
    if (mirror) {
      const before = new Set((await instances()).map((i) => i.id));
      await call("plasticity_create_mirrored_instance", { bodyId: sourceId, axis: "x", planeOffsetMm: 0, revision: await rev() });
      const id = (await instances()).find((i) => !before.has(i.id))!.id;
      // Mirror of a placement: rotate (mirrored axis) then translate by the X-flipped delta.
      if ("rotate" in p && p.rotate) {
        const { pivot, axis, deg } = p.rotate;
        await call("plasticity_rotate_instances", { ids: [id], pivotMm: [-pivot[0], pivot[1], pivot[2]], axis: [axis[0], -axis[1], -axis[2]], degrees: deg, revision: await rev() });
      }
      if (p.t.some((v) => v !== 0)) await call("plasticity_move_instances", { ids: [id], deltaMm: [-p.t[0], p.t[1], p.t[2]], revision: await rev() });
      n++;
    }
  }
  return n;
}
function chain(steps: Step[]): Step[] {
  return steps.map((x, i) => JSON.parse(JSON.stringify(x).replaceAll('"$PREV.', `"$${i - 1}.`)));
}

// ---- 1. clean split of the user's body at X = 0, then live mirrored instances of body and pod.
await stage("split", async (notes) => {
  const st = await status();
  const body = st.bodies.find((b: Body) => b.name === "Solid.001");
  const pod = st.bodies.find((b: Body) => b.name === "Solid.003");
  if (!body || !pod) throw new Error("user half bodies Solid.001 / Solid.003 not found");
  if (body.boundsMm.min[0] < -1e-6) {
    const facesBefore = (await info(body.id)).faces.length;
    await batch(chain([
      step("plasticity_create_box", { originMm: [-9000, -12000, -1000], sizeMm: [9000, 24000, 9000], name: "rc11_cutter" }),
      step("plasticity_boolean", { targetIds: [body.id], toolIds: ["$PREV.addedSolids[0]"], operation: "difference" }),
    ]));
    notes.push(`cut body at X=0 (faces ${facesBefore} -> ${(await info(body.id)).faces.length})`);
  }
  const b = await info(body.id);
  const centre = b.faces.filter((f) => Math.abs(f.boundsMm.min[0]) < 1e-3 && Math.abs(f.boundsMm.max[0]) < 1e-3);
  const neg = b.faces.filter((f) => f.boundsMm.min[0] < -1e-6);
  notes.push(`centre faces on X=0: ${centre.length} (${centre.map((f) => `${f.surfaceType} x ${f.boundsMm.min[0].toExponential(2)}..${f.boundsMm.max[0].toExponential(2)}`).join("; ")}); faces reaching X<0: ${neg.length}; face bounds minX ${Math.min(...b.faces.map((f) => f.boundsMm.min[0]))}`);
  if (centre.length > 1) {
    // Coplanar pieces left from the original model: merge them into one planar face if Plasticity allows.
    try {
      await call("plasticity_dissolve_faces", { faces: centre.map((f) => ({ bodyId: body.id, faceId: f.id })), revision: await rev() });
      const after = (await info(body.id)).faces.filter((f) => Math.abs(f.boundsMm.min[0]) < 1e-3 && Math.abs(f.boundsMm.max[0]) < 1e-3);
      notes.push(`merged centre faces -> ${after.length}`);
    } catch (error) { notes.push(`centre faces not merged: ${String(error).slice(0, 200)}`); }
  }
  const valid = await call("plasticity_validate_bodies", { ids: [body.id, pod.id], revision: await rev() });
  notes.push(`validate: ${JSON.stringify(valid.results ?? valid.bodies ?? valid).slice(0, 600)}`);
  const have = await instances();
  for (const id of [body.id, pod.id]) {
    if (!have.some((i) => i.scale[0] < 0 && i.sourceBodyIds.includes(id))) await call("plasticity_create_mirrored_instance", { bodyId: id, axis: "x", planeOffsetMm: 0, revision: await rev() });
  }
  notes.push(`instances: ${(await instances()).map((i) => `${i.id}<-${i.sourceBodyIds} scale ${i.scale}`).join("; ")}`);
});

await stage("link-test", async (notes) => {
  const pod = await byName("Solid.003");
  const before = (await status()).undoDepth;
  await raw("plasticity_move", { ids: [pod.id], deltaMm: [0, 0, 400], revision: await rev() });
  const moved = await byName("Solid.003");
  const shot = await raw("plasticity_screenshot", { path: resolve(outDir, `link-test-moved-${Date.now()}.png`) }).catch((e: unknown) => `screenshot failed: ${String(e).slice(0, 120)}`);
  const st = await status();
  if (st.undoDepth !== before + 1) throw new Error(`undo depth ${st.undoDepth}, expected ${before + 1}; not undoing`);
  await raw("plasticity_undo", { revision: st.revision });
  const back = await byName("Solid.003");
  notes.push(`pod z ${pod.boundsMm.min[2]} -> moved ${moved.boundsMm.min[2]} -> undone ${back.boundsMm.min[2]}; ${typeof shot === "string" ? shot : "screenshot saved"}`);
  const linked = (await instances()).some((i) => i.sourceBodyIds.includes(pod.id) && i.scale[0] < 0);
  notes.push(`mirrored pod instance linked to source: ${linked}`);
});

await s.close();
