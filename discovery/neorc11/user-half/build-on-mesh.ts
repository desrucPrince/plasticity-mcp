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
const status = () => raw("plasticity_status", { bodyLimit: 200 });
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
  const twoFaced = new Set((await info(id)).edges.filter((e) => e.faceIds.length === 2).map((e) => e.id));
  edgeIds = edgeIds.filter((e) => twoFaced.has(e));
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
// One linked instance per translation of the source, plus a mirrored instance across X = 0 for the source and
// for each translation (a mirrored instance moved by the X-flipped delta). Rotations belong in the source.
async function place(sourceId: number, translations: Vec[], mirror = true) {
  let n = 0;
  const newest = async (make: () => Promise<unknown>) => {
    const before = new Set((await instances()).map((i) => i.id));
    await make();
    return (await instances()).find((i) => !before.has(i.id))!.id;
  };
  for (const t of translations) {
    await newest(async () => call("plasticity_create_instance", { bodyId: sourceId, translationMm: t, revision: await rev() }));
    n++;
  }
  if (mirror) for (const t of [[0, 0, 0] as Vec, ...translations]) {
    const id = await newest(async () => call("plasticity_create_mirrored_instance", { bodyId: sourceId, axis: "x", planeOffsetMm: 0, revision: await rev() }));
    if (t.some((v) => v !== 0)) await call("plasticity_move_instances", { ids: [id], deltaMm: [-t[0], t[1], t[2]], revision: await rev() });
    n++;
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


// Stages that change the user's own bodies run once; FORCE=1 reruns them.
const once = (name: string) => !log[name]?.ok || process.env.FORCE === "1";
const DECK = 3100; // user mesh: deck and pod tops are both flat at Z 3100

// ---- 2. refine the +X sources where the user's mesh allows: G2 cabin-to-deck blend; visor glass band.
// (Their deck and pod tops are coplanar at Z 3100, so the spec's 250 mm hood-to-fender valley has no step to
// blend; their pod keeps its own 45° top chamfer and end shapes.)
await stage("refine", async (notes) => {
  const body = await byName("Solid.001");
  if (once("refine-fillet")) {
    const seam = (await info(body.id)).edges.filter((e) => Math.abs(e.boundsMm.min[2] - DECK) < 0.5 && Math.abs(e.boundsMm.max[2] - DECK) < 0.5
      && e.boundsMm.max[0] <= 2310 && e.boundsMm.min[1] >= -3400 && e.boundsMm.max[1] <= 4720).map((e) => e.id);
    notes.push(`cabin/deck seam edges: ${seam.length}`);
    for (const radius of [300, 220, 150]) if (await fillet(body.id, seam, radius, "g2", "cabin-to-deck", notes)) { log["refine-fillet"] = { ok: true, ms: 0, notes: [`r${radius}`] }; break; }
  }
  // Visor: the cabin surface in a 140 mm band at the waist (Z 3700..3840), front and sides, copied to a sheet.
  await clear("rc11_Visor");
  const band = await batch(chain([
    step("plasticity_duplicate_bodies", { ids: [body.id] }),
    step("plasticity_create_box", { originMm: [0, -2000, 3700], sizeMm: [2500, 7000, 140], name: "rc11_visor_band" }),
    step("plasticity_boolean", { targetIds: ["$0.added[0]"], toolIds: ["$1.addedSolids[0]"], operation: "intersection" }),
  ]));
  const bandId = band.steps[0].added[0] as number;
  const onBox = (f: Face) => ([[2, 3700], [2, 3840], [1, -2000], [0, 0]] as Array<[number, number]>).some(([axis, v]) => Math.abs(f.boundsMm.min[axis] - v) < 0.5 && Math.abs(f.boundsMm.max[axis] - v) < 0.5);
  const outer = (await info(bandId)).faces.filter((f) => !onBox(f));
  if (!outer.length) throw new Error("visor: band has no cabin faces");
  const before = new Set((await bodies()).map((b) => b.id));
  await call("plasticity_extract_faces", { faces: outer.map((f) => ({ bodyId: bandId, faceId: f.id })), revision: await rev() });
  let sheets = (await bodies()).filter((b) => !before.has(b.id)).map((b) => b.id);
  if (sheets.length > 1) {
    await call("plasticity_join_sheets", { ids: sheets, revision: await rev() });
    const now = new Set((await bodies()).map((b) => b.id));
    sheets = sheets.filter((id) => now.has(id));
  }
  await raw("plasticity_delete", { ids: [bandId], revision: await rev() });
  const visor = (await bodies()).filter((b) => sheets.includes(b.id));
  for (const [i, v] of visor.entries()) await rename(v.id, i ? `rc11_Visor_${i}` : "rc11_Visor");
  await call("plasticity_set_appearance_material", { ids: visor.map((v) => v.id), name: "Visor glass", colorHex: "#14202b", roughness: 0.05, metalness: 0.3, opacity: 0.6, revision: await rev() });
  let n = 0;
  for (const v of visor) n += await place(v.id, []);
  notes.push(`visor sheets: ${visor.map(fmt).join("; ")} (${outer.length} faces), mirrored instances ${n}`);
});

// ---- 3. shallow cuts into the sources: hood and deck panel-line grooves (body), louvre recess (pod side).
await stage("cuts", async (notes) => {
  if (!once("cuts")) { notes.push("already cut"); return; }
  const body = await byName("Solid.001"), pod = await byName("Solid.003");
  const g = 14, d = 8;
  const grooves: Array<[Vec, Vec]> = [
    [[-10, 5450 - g / 2, DECK - d], [2650, g, 40]], // hood seam ahead of the windscreen
    [[-10, -3520 - g / 2, DECK - d], [2650, g, 40]], // deck seam behind the cabin
    [[2450 - g / 2, 4760, DECK - d], [g, 1500, 40]], // hood panel side line
  ];
  for (const [o, sz] of grooves) await batch(chain([
    step("plasticity_create_box", { originMm: o, sizeMm: sz, name: "rc11_groove_cutter" }),
    step("plasticity_boolean", { targetIds: [body.id], toolIds: ["$PREV.addedSolids[0]"], operation: "difference" }),
  ]));
  notes.push(`grooves: ${grooves.length} (14 wide, 8 deep)`);
  await batch(chain([
    step("plasticity_create_box", { originMm: [3627, 900, 2330], sizeMm: [100, 3400, 370], name: "rc11_recess_cutter" }),
    step("plasticity_boolean", { targetIds: [pod.id], toolIds: ["$PREV.addedSolids[0]"], operation: "difference" }),
  ]));
  notes.push("pod louvre recess: Y 900..4300, Z 2330..2700, 30 deep");
});

// ---- 4. side fins: planform in a plane canted 25° down from the pod's flat outer face (X 3657; root at Z 2450,
// the middle of that face, instead of the spec's 2120, which would land on their lower fillet), extruded 55 mm
// to each side (110 thick), leading and trailing edges rounded G2 almost to a full round, tip edges G2.
// (A loft between closed 110 mm sections failed in Parasolid, error 21555, for every curvature option.)
// The root blend into the pod happens at the final join.
const FIN = { x: 3657, z: 2450, cant: 25, rootLe: -1200, rootTe: -5200, span: 1360, tipLe: -5040, tipTe: -6240, t: 110 };
await stage("fins", async (notes) => {
  await clear("rc11_fin");
  const dir: Vec = [Math.cos(FIN.cant * D), 0, -Math.sin(FIN.cant * D)];
  const nrm: Vec = [Math.sin(FIN.cant * D), 0, Math.cos(FIN.cant * D)];
  const at = (sp: number, y: number): Vec => [r(FIN.x + sp * dir[0]), y, r(FIN.z + sp * dir[2])];
  const out = await batch(chain([
    step("plasticity_create_polyline", { pointsMm: [at(-150, FIN.rootLe), at(FIN.span, FIN.tipLe), at(FIN.span, FIN.tipTe), at(-150, FIN.rootTe)], closed: true }),
    step("plasticity_extrude_profile", { id: "$PREV.added[0]", distanceMm: FIN.t / 2, options: { reverseDistanceMm: FIN.t / 2 } }),
  ]));
  await rename(out.steps[0].added[0], "rc11_fin_planform");
  await hide([out.steps[0].added[0]]);
  const fin = out.steps[1].added[0] as number;
  await rename(fin, "rc11_fin");
  const b = await byName("rc11_fin");
  notes.push(`slab ${fmt(b)}`);
  // Leading/trailing edges: the long edges of the two side faces (Y-sloped, not the root or tip ends).
  const span = (e: Edge) => { const dx = e.boundsMm.max[0] - e.boundsMm.min[0]; return dx > 1000; };
  const le = (await info(fin)).edges.filter((e) => span(e) && e.boundsMm.max[1] > -5100 && e.boundsMm.min[1] < -1100 && e.boundsMm.max[1] - e.boundsMm.min[1] > 3000 && e.boundsMm.max[1] > -1300).map((e) => e.id);
  const te = (await info(fin)).edges.filter((e) => span(e) && e.boundsMm.min[1] < -6100).map((e) => e.id);
  notes.push(`LE edges ${le.length}, TE edges ${te.length}`);
  if (!(await fillet(fin, [...le, ...te], 52, "g2", "fin leading/trailing edges", notes))) await fillet(fin, [...le, ...te], 45, "g2", "fin leading/trailing edges", notes);
  const tip = (await info(fin)).edges.filter((e) => e.boundsMm.min[0] > FIN.x + FIN.span * dir[0] - 60).map((e) => e.id);
  await fillet(fin, tip, 30, "g2", "fin tip edge", notes);
  notes.push(`${fmt(await byName("rc11_fin"))}; instances ${await place(fin, [])}`);
});

// ---- 5. grille bars arrayed across the upper inlet slot (X 235..2532, Z 2065..2372), leaning with the nose face.
await stage("grille", async (notes) => {
  await clear("rc11_grille_bar");
  const lean = Math.atan(0.2) / D; // the nose face moves 0.2 mm forward per mm up
  const out = await batch(chain([
    step("plasticity_create_box", { originMm: [300, 6403, 2072], sizeMm: [30, 42, 293], name: "rc11_grille_bar" }),
    step("plasticity_rotate", { ids: ["$PREV.addedSolids[0]"], pivotMm: [315, 6424, 2218], axis: [1, 0, 0], degrees: -lean }),
  ]));
  const bar = out.steps[0].added[0] as number;
  await call("plasticity_set_appearance_material", { ids: [bar], name: "Gunmetal", colorHex: "#2b2f33", roughness: 0.35, metalness: 0.8, revision: await rev() });
  const ts: Vec[] = Array.from({ length: 13 }, (_, k) => [165 * (k + 1), 0, 0]);
  notes.push(`${fmt(await byName("rc11_grille_bar"))}; instances ${await place(bar, ts)}`);
});

// ---- 6. pod side louvres: four angled blades stacked in the recess.
await stage("louvres", async (notes) => {
  await clear("rc11_louvre");
  const out = await batch(chain([
    step("plasticity_create_box", { originMm: [3625, 950, 2350], sizeMm: [16, 3300, 60], name: "rc11_louvre" }),
    step("plasticity_rotate", { ids: ["$PREV.addedSolids[0]"], pivotMm: [3633, 2600, 2380], axis: [0, 1, 0], degrees: 35 }),
  ]));
  const blade = out.steps[0].added[0] as number;
  await call("plasticity_set_appearance_material", { ids: [blade], name: "Gunmetal", colorHex: "#2b2f33", roughness: 0.35, metalness: 0.8, revision: await rev() });
  notes.push(`${fmt(await byName("rc11_louvre"))}; instances ${await place(blade, [1, 2, 3].map((k) => [0, 0, 85 * k] as Vec))}`);
});

// ---- 7. rear deck strakes: thin wedge vanes behind the cabin, arrayed across X.
await stage("strakes", async (notes) => {
  await clear("rc11_strake");
  const x = 488;
  const out = await batch(chain([
    step("plasticity_create_polyline", { pointsMm: [[x, -4800, DECK - 5], [x, -3750, DECK + 90], [x, -3650, DECK + 90], [x, -3650, DECK - 5]], closed: true }),
    step("plasticity_extrude_profile", { id: "$PREV.added[0]", distanceMm: 24 }),
  ]));
  await rename(out.steps[0].added[0], "rc11_strake_profile");
  await hide([out.steps[0].added[0]]);
  const strake = out.steps[1].added[0] as number;
  await rename(strake, "rc11_strake");
  const top = (await info(strake)).edges.filter((e) => e.boundsMm.min[2] > DECK + 10 && e.lengthMm > 50).map((e) => e.id);
  await fillet(strake, top, 10, "round", "strake top edges", notes);
  notes.push(`${fmt(await byName("rc11_strake"))}; instances ${await place(strake, [1, 2, 3].map((k) => [400 * k, 0, 0] as Vec))}`);
});

// ---- 8. hover emitter pads: flat chamfered plates under the pod/body belly, arrayed along Y.
await stage("pads", async (notes) => {
  await clear("rc11_hover_pad");
  const out = await batch(chain([step("plasticity_create_box", { originMm: [2300, -700, 1205], sizeMm: [580, 1400, 40], name: "rc11_hover_pad" })]));
  const pad = out.steps[0].added[0] as number;
  const bottom = (await info(pad)).edges.filter((e) => e.boundsMm.max[2] < 1206).map((e) => e.id);
  await raw("plasticity_chamfer", { id: pad, edgeIds: bottom, distanceMm: 12, revision: await rev() });
  await call("plasticity_set_appearance_material", { ids: [pad], name: "Emitter", colorHex: "#3fd0ff", roughness: 0.2, metalness: 0.1, revision: await rev() });
  notes.push(`${fmt(await byName("rc11_hover_pad"))}; instances ${await place(pad, [-5000, -2500, 2500, 4800].map((y) => [0, y, 0] as Vec))}`);
});

// ---- 9. chrome trim strip along the pod top, just inboard of its outer chamfer.
await stage("trim", async (notes) => {
  await clear("rc11_trim");
  const out = await batch(chain([step("plasticity_create_box", { originMm: [3385, -7100, DECK - 2], sizeMm: [40, 14500, 18], name: "rc11_trim" })]));
  const trim = out.steps[0].added[0] as number;
  const top = (await info(trim)).edges.filter((e) => e.boundsMm.min[2] > DECK + 15 && e.lengthMm > 1000).map((e) => e.id);
  await fillet(trim, top, 8, "round", "trim top edges", notes);
  await call("plasticity_set_appearance_material", { ids: [trim], name: "Chrome", colorHex: "#d9dde2", roughness: 0.08, metalness: 1, revision: await rev() });
  notes.push(`${fmt(await byName("rc11_trim"))}; instances ${await place(trim, [])}`);
});


const BELLY = 1240; // user mesh: flat belly of body and pods

// Rotation-only placements (no translation), so the mirrored copy is exact: mirror(rotate(a, θ)) equals
// rotate(mirrored pivot, axis (ax, -ay, -az), θ) applied to the mirrored source.
async function placeRotations(sourceId: number, pivot: Vec, axis: Vec, degrees: number[]) {
  let n = 0;
  const newest = async (make: () => Promise<unknown>) => {
    const before = new Set((await instances()).map((i) => i.id));
    await make();
    return (await instances()).find((i) => !before.has(i.id))!.id;
  };
  for (const deg of degrees) {
    const a = await newest(async () => call("plasticity_create_instance", { bodyId: sourceId, translationMm: [0, 0, 0], revision: await rev() }));
    await call("plasticity_rotate_instances", { ids: [a], pivotMm: pivot, axis, degrees: deg, revision: await rev() });
    const m = await newest(async () => call("plasticity_create_mirrored_instance", { bodyId: sourceId, axis: "x", planeOffsetMm: 0, revision: await rev() }));
    await call("plasticity_rotate_instances", { ids: [m], pivotMm: [-pivot[0], pivot[1], pivot[2]], axis: [axis[0], -axis[1], -axis[2]], degrees: deg, revision: await rev() });
    n += 2;
  }
  return n;
}
// A stadium solid (long in Y, round ends of radius a about the centreline), Z from z0 to z0+h, cut to X >= 0.
async function halfStadium(a: number, half: number, yc: number, z0: number, h: number, name: string): Promise<number> {
  const out = await batch(chain([
    step("plasticity_create_box", { originMm: [-a, yc - half, z0], sizeMm: [2 * a, 2 * half, h], name }),
    step("plasticity_create_cylinder", { centerMm: [0, yc + half, z0], radiusMm: a, heightMm: h }),
    step("plasticity_create_cylinder", { centerMm: [0, yc - half, z0], radiusMm: a, heightMm: h }),
  ]));
  const id = out.steps[0].added[0] as number;
  const cyl = [out.steps[1].added[0], out.steps[2].added[0]] as number[];
  const c = (await bodies()).find((b) => b.id === cyl[0])!;
  const dz = z0 - c.boundsMm.min[2];
  if (Math.abs(dz) > 1e-6) await raw("plasticity_move", { ids: cyl, deltaMm: [0, 0, dz], revision: await rev() });
  await union(id, cyl);
  await batch(chain([
    step("plasticity_create_box", { originMm: [-9000, -12000, -1000], sizeMm: [9000, 24000, 9000], name: "rc11_cutter" }),
    step("plasticity_boolean", { targetIds: [id], toolIds: ["$PREV.addedSolids[0]"], operation: "difference" }),
  ]));
  await rename(id, name);
  return id;
}
async function union(target: number, tools: number[]) {
  return await raw("plasticity_boolean", { targetIds: [target], toolIds: tools, operation: "union", revision: await rev() });
}
const material = async (ids: number[], name: string, colorHex: string, roughness: number, metalness: number, opacity = 1) =>
  await call("plasticity_set_appearance_material", { ids, name, colorHex, roughness, metalness, opacity, revision: await rev() });

// ---- 10. centre repulsion drive: a stadium bay 160 mm deep cut into the belly on the centreline under the cabin
// (Y -2500..1500, 1800 wide), chamfered lip; inside, a glowing stadium core plate at the ceiling, three flat stadium
// emitter rings stepped toward the opening, and guide vanes (straight run plus radial fans at both ends) that tie
// the rings to the ceiling. Everything is a +X half on X = 0 with mirrored instances.
const BAY = { yc: -500, half: 1100, a: 900, depth: 160 };
await stage("drive", async (notes) => {
  await clear("rc11_drive");
  const ceiling = BELLY + BAY.depth;
  if (once("drive-bay")) {
    const body = await byName("Solid.001");
    const cutter = await halfStadium(BAY.a, BAY.half, BAY.yc, BELLY - 50, BAY.depth + 50, "rc11_drive_bay_cutter");
    const before = new Set((await info(body.id)).edges.map((e) => e.id));
    await raw("plasticity_boolean", { targetIds: [body.id], toolIds: [cutter], operation: "difference", revision: await rev() });
    const lip = (await info(body.id)).edges.filter((e) => !before.has(e.id) && Math.abs(e.boundsMm.min[2] - BELLY) < 0.5 && Math.abs(e.boundsMm.max[2] - BELLY) < 0.5).map((e) => e.id);
    try { await raw("plasticity_chamfer", { id: body.id, edgeIds: lip, distanceMm: 25, revision: await rev() }); notes.push(`bay cut, lip chamfer 25 on ${lip.length} edges`); }
    catch (error) { notes.push(`bay cut; lip chamfer failed (${String(error).slice(0, 160)})`); }
    log["drive-bay"] = { ok: true, ms: 0, notes: ["bay cut into Solid.001"] };
  }
  const core = await halfStadium(300, BAY.half, BAY.yc, ceiling - 12, 12, "rc11_drive_core");
  await material([core], "Repulsor glow", "#5fe6ff", 0.1, 0);
  notes.push(`core plate; instances ${await place(core, [])}`);
  for (const [i, [ri, ro, z]] of ([[420, 520, ceiling - 45], [600, 690, ceiling - 80], [770, 840, ceiling - 115]] as Array<[number, number, number]>).entries()) {
    const outer = await halfStadium(ro, BAY.half, BAY.yc, z, 14, `rc11_drive_ring_${i}`);
    const inner = await halfStadium(ri, BAY.half, BAY.yc, z - 5, 24, "rc11_drive_ring_cutter");
    await raw("plasticity_boolean", { targetIds: [outer], toolIds: [inner], operation: "difference", revision: await rev() });
    await material([outer], "Emitter ring", "#9aa3ad", 0.15, 1);
    notes.push(`ring ${i} (${ri}..${ro}, Z ${z}); instances ${await place(outer, [])}`);
  }
  // Guide vanes: 20 thick, from the core edge (X 300) to the bay wall (X 880), ceiling down to the lowest ring.
  const vaneBox = (y: number, name: string) => step("plasticity_create_box", { originMm: [300, y - 10, ceiling - 130], sizeMm: [580, 20, 130], name });
  const mid = (await batch([vaneBox(BAY.yc, "rc11_drive_vane")])).steps[0].added[0] as number;
  await material([mid], "Gunmetal", "#2b2f33", 0.35, 0.8);
  const straight = [-1100, -825, -550, -275, 275, 550, 825, 1100].map((dy) => [0, dy, 0] as Vec);
  notes.push(`straight vanes; instances ${await place(mid, straight)}`);
  for (const [end, sign] of [[BAY.yc + BAY.half, 1], [BAY.yc - BAY.half, -1]] as Array<[number, number]>) {
    // Each end fan has its own source at the end centre: instances cannot combine translate and rotate exactly
    // for the mirror, so the fans are rotation-only copies.
    const src = (await batch([vaneBox(end, sign > 0 ? "rc11_drive_vane_front" : "rc11_drive_vane_rear")])).steps[0].added[0] as number;
    await material([src], "Gunmetal", "#2b2f33", 0.35, 0.8);
    notes.push(`${sign > 0 ? "front" : "rear"} fan; instances ${await placeRotations(src, [0, end, 0], [0, 0, 1], [30 * sign, 60 * sign])}`);
  }
});

// ---- 11. rear drive exhaust: a framed nozzle on the lower tail face between the pods (centreline half), recessed,
// with horizontal vanes arrayed in Z and a glow plate at the back of the recess.
await stage("exhaust", async (notes) => {
  const E = { x: 1150, y0: -6900, y1: -6450, z0: 1300, z1: 1720 };
  // After the join the frame is part of rc11_hull; then only the glow and vanes are rebuilt.
  const merged = (await bodies()).some((b) => b.name === "rc11_hull");
  for (const p of merged ? ["rc11_exhaust_glow", "rc11_exhaust_vane"] : ["rc11_exhaust"]) await clear(p);
  if (!merged) {
  const box = (await batch([step("plasticity_create_box", { originMm: [0, E.y0, E.z0], sizeMm: [E.x, E.y1 - E.y0, E.z1 - E.z0], name: "rc11_exhaust_frame" })])).steps[0].added[0] as number;
  const rearEdges = (await info(box)).edges.filter((e) => e.boundsMm.max[1] < E.y0 + 0.5 && !(e.boundsMm.max[0] < 0.5)).map((e) => e.id);
  await raw("plasticity_chamfer", { id: box, edgeIds: rearEdges, distanceMm: 30, revision: await rev() });
  await batch(chain([
    step("plasticity_create_box", { originMm: [-10, E.y0 - 10, E.z0 + 60], sizeMm: [E.x - 60, 230, E.z1 - E.z0 - 120], name: "rc11_exhaust_cutter" }),
    step("plasticity_boolean", { targetIds: [box], toolIds: ["$PREV.addedSolids[0]"], operation: "difference" }),
  ]));
  await material([box], "Drive housing", "#3a3f45", 0.4, 0.7);
  notes.push(`frame ${fmt(await byName("rc11_exhaust_frame"))}; instances ${await place(box, [])}`);
  }
  const glow = (await batch([step("plasticity_create_box", { originMm: [0, E.y0 + 214, E.z0 + 60], sizeMm: [E.x - 70, 6, E.z1 - E.z0 - 120], name: "rc11_exhaust_glow" })])).steps[0].added[0] as number;
  await material([glow], "Repulsor glow", "#5fe6ff", 0.1, 0);
  notes.push(`glow; instances ${await place(glow, [])}`);
  const slat = (await batch([step("plasticity_create_box", { originMm: [0, E.y0 + 20, E.z0 + 100], sizeMm: [E.x - 70, 180, 22], name: "rc11_exhaust_vane" })])).steps[0].added[0] as number;
  await material([slat], "Gunmetal", "#2b2f33", 0.35, 0.8);
  notes.push(`vanes; instances ${await place(slat, [1, 2, 3].map((k) => [0, 0, 70 * k] as Vec))}`);
});

// ---- 12. buttresses (spec): tapered sail panels from the cabin's rear quarter aft along the deck, side-view wedge
// extruded across X, top edges rounded G2. Their root blend into deck and cabin happens at the final join.
await stage("buttress", async (notes) => {
  await clear("rc11_buttress");
  const x0 = 2000, w = 260;
  const out = await batch(chain([
    step("plasticity_create_polyline", { pointsMm: [[x0, -2300, DECK - 5], [x0, -2300, 3640], [x0, -2700, 3600], [x0, -4700, DECK - 5]], closed: true }),
    step("plasticity_extrude_profile", { id: "$PREV.added[0]", distanceMm: w }),
  ]));
  await rename(out.steps[0].added[0], "rc11_buttress_profile");
  await hide([out.steps[0].added[0]]);
  const b = out.steps[1].added[0] as number;
  await rename(b, "rc11_buttress");
  const top = (await info(b)).edges.filter((e) => e.boundsMm.max[2] > DECK + 50 && Math.abs(e.boundsMm.max[0] - e.boundsMm.min[0]) < 1 && e.lengthMm > 300).map((e) => e.id);
  if (!(await fillet(b, top, 110, "g2", "buttress top edges", notes))) await fillet(b, top, 80, "g2", "buttress top edges", notes);
  notes.push(`${fmt(await byName("rc11_buttress"))}; instances ${await place(b, [])}`);
});

// ---- 13. Eldorado lighting: slim vertical headlight strips on the pod's front blade face (leans 10.8° forward at
// the top) and thin horizontal taillight bars on the pod's rear blade face (leans 8.1°), below its existing panel.
await stage("lights", async (notes) => {
  await clear("rc11_headlight"); await clear("rc11_taillight");
  const head = await batch(chain([
    step("plasticity_create_box", { originMm: [2700, 7840, 2500], sizeMm: [50, 30, 440], name: "rc11_headlight" }),
    step("plasticity_rotate", { ids: ["$PREV.addedSolids[0]"], pivotMm: [2725, 7855, 2720], axis: [1, 0, 0], degrees: -Math.atan(0.19) / D }),
  ]));
  const h = head.steps[0].added[0] as number;
  await material([h], "Headlight", "#f4f8ff", 0.05, 0);
  notes.push(`${fmt(await byName("rc11_headlight"))}; instances ${await place(h, [[90, 0, 0]])}`);
  const tail = (await batch([step("plasticity_create_box", { originMm: [2880, -7362, 1545], sizeMm: [560, 30, 40], name: "rc11_taillight" })])).steps[0].added[0] as number;
  await material([tail], "Tail light", "#ff2a2a", 0.15, 0);
  notes.push(`${fmt(await byName("rc11_taillight"))}; instances ${await place(tail, [[0, 14, 100], [0, 28, 200]])}`);
});

// ---- 14. sill line along the pod's outer face (chrome strip at the base of its flat face) and a dark sensor/ID
// strip across the upper nose face (tilted 22.4° back, centreline half).
await stage("sill", async (notes) => {
  await clear("rc11_sill"); await clear("rc11_nose_strip");
  const sill = (await batch([step("plasticity_create_box", { originMm: [3650, -6900, 2160], sizeMm: [22, 13100, 30], name: "rc11_sill" })])).steps[0].added[0] as number;
  await material([sill], "Chrome", "#d9dde2", 0.08, 1);
  notes.push(`${fmt(await byName("rc11_sill"))}; instances ${await place(sill, [])}`);
  const tilt = Math.atan(0.38 / 0.92) / D;
  const strip = await batch(chain([
    step("plasticity_create_box", { originMm: [0, 6421, 2795], sizeMm: [2300, 20, 50], name: "rc11_nose_strip" }),
    step("plasticity_rotate", { ids: ["$PREV.addedSolids[0]"], pivotMm: [0, 6431, 2820], axis: [1, 0, 0], degrees: tilt }),
  ]));
  const st = strip.steps[0].added[0] as number;
  await material([st], "Sensor glass", "#0b0d10", 0.05, 0.4);
  notes.push(`${fmt(await byName("rc11_nose_strip"))}; instances ${await place(st, [])}`);
});

await s.close();
