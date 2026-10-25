// Builds the neoRC 11 hover-car hull (+X half, mirrored at the end) through the MCP server in the open
// Plasticity document, which must be a fresh document (File → New) holding only the startup cube, or a
// document this script built before. Every body it makes is named "rc11_*"; the blockout reference is
// imported into a hidden "blockout_ref" group. Rerun: deletes rc11_* bodies and instances of them, never
// uses undo, never saves. Stages can be run alone (later stages find earlier bodies by name):
//   PLASTICITY_CDP_URL=http://127.0.0.1:9223 node discovery/neorc11/build.ts            # everything
//   PLASTICITY_CDP_URL=http://127.0.0.1:9223 node discovery/neorc11/build.ts cabin fins # some stages
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { openSession } from "../mcp-client.ts";

type Vec = [number, number, number];
type Body = { id: number; name: string | null; type: string; boundsMm: { min: Vec; max: Vec }; faceCount?: number };
type Edge = { id: string; boundsMm?: { min: Vec; max: Vec }; lengthMm?: number; curveType?: string };
type Step = { toolName: string; arguments?: Record<string, unknown> };

const outDir = resolve("discovery/neorc11");
await mkdir(outDir, { recursive: true });
const only = new Set(process.argv.slice(2));
const want = (stage: string) => only.size === 0 || only.has(stage);
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
const log: Record<string, { ok: boolean; ms: number; notes: string[] }> = existsSync(logPath) && only.size ? JSON.parse(await readFile(logPath, "utf8")) : {};
const continuity: Array<{ blend: string; edges: number; maxG0mm: number; maxG1deg: number; maxRelG2: number; verdict: string }> = [];
async function stage(name: string, run: (notes: string[]) => Promise<void>) {
  if (!want(name)) return;
  const t = performance.now();
  const notes: string[] = [];
  let ok = true;
  try { await run(notes); } catch (error) { ok = false; notes.push(`FAILED: ${String(error).slice(0, 1200)}`); }
  log[name] = { ok, ms: Math.round(performance.now() - t), notes };
  console.log(ok ? "OK  " : "FAIL", name, Math.round(performance.now() - t), "ms", notes.join(" | "));
  await writeFile(logPath, JSON.stringify(log, null, 1));
  if (!ok) { await s.close(); process.exit(1); }
}

async function bodies(): Promise<Body[]> { return (await status()).bodies; }
async function byName(name: string): Promise<Body> {
  const found = (await bodies()).filter((b) => b.name === name);
  if (found.length !== 1) throw new Error(`expected one body named ${name}, found ${found.length}`);
  return found[0]!;
}
async function rename(id: number, name: string) { await call("plasticity_rename", { id, name, revision: await rev() }); }
const fmt = (b: Body) => `${b.name}#${b.id} [${b.boundsMm.min.map(Math.round)}]..[${b.boundsMm.max.map(Math.round)}]`;
async function edgesOf(id: number): Promise<Edge[]> {
  const info = await raw("plasticity_body_info", { id });
  return (info.body?.edges ?? info.edges ?? []) as Edge[];
}
// Edges whose bounds lie inside the box [lo, hi] (and are at least minLen long).
async function edgesIn(id: number, lo: Vec, hi: Vec, minLen = 0): Promise<string[]> {
  return (await edgesOf(id)).filter((e) => e.boundsMm
    && e.boundsMm.min.every((v, i) => v >= lo[i]! - 1e-6) && e.boundsMm.max.every((v, i) => v <= hi[i]! + 1e-6)
    && (e.lengthMm ?? Infinity) >= minLen).map((e) => e.id);
}
async function fillet(id: number, edgeIds: string[], radiusMm: number, shape: "g2" | "round", label: string, notes: string[]) {
  if (edgeIds.length === 0) throw new Error(`${label}: no edges found`);
  const before = new Set((await edgesOf(id)).map((e) => e.id));
  await raw("plasticity_fillet", { id, edgeIds, radiusMm, shape, revision: await rev() });
  notes.push(`${label}: ${edgeIds.length} edges r${radiusMm} ${shape}`);
  if (shape === "g2") await measureNewTangentEdges(id, before, label);
}
// Measure continuity on the edges a fillet created that are tangent (G1) joins.
async function measureNewTangentEdges(id: number, before: Set<string>, label: string) {
  const created = (await edgesOf(id)).filter((e) => !before.has(e.id)).map((e) => ({ bodyId: id, edgeId: e.id }));
  if (!created.length) return;
  const res = await call("plasticity_analyze_surface_continuity", { edges: created.slice(0, 400), revision: await rev() });
  const tangent = (res.analyses ?? []).filter((a: any) => a.maximumNormalAngleDeviationDeg < 1);
  if (!tangent.length) return;
  const max = (k: string) => Math.max(...tangent.map((a: any) => Number(a[k]) || 0));
  const g2 = max("maximumRelativeCurvatureDeviation");
  continuity.push({ blend: label, edges: tangent.length, maxG0mm: r(max("maximumPositionDeviationMm")), maxG1deg: Math.round(max("maximumNormalAngleDeviationDeg") * 1e4) / 1e4, maxRelG2: Math.round(g2 * 1000) / 1000, verdict: g2 <= 0.05 ? "G2" : "G1 only" });
}
function chain(steps: Step[]): Step[] {
  // "$PREV" -> "$<index of previous step>" so helpers can be spliced anywhere in a batch.
  return steps.map((x, i) => JSON.parse(JSON.stringify(x).replaceAll('"$PREV.', `"$${i - 1}.`)));
}
// Remove the X<0 half of a body with an oversized box.
async function keepPositiveX(id: number) {
  await batch(chain([
    step("plasticity_create_box", { originMm: [-9000, -12000, -1000], sizeMm: [9000, 24000, 9000], name: "rc11_cutter" }),
    step("plasticity_boolean", { targetIds: [id], toolIds: ["$PREV.addedSolids[0]"], operation: "difference" }),
  ]));
}
async function hide(ids: number[]) { if (ids.length) await call("plasticity_set_visibility", { bodyIds: ids, visible: false, revision: await rev() }); }
async function union(target: number, tools: number[]) {
  return await raw("plasticity_boolean", { targetIds: [target], toolIds: tools, operation: "union", revision: await rev() });
}

// ---- 0. reset. A fresh document: delete the startup cube, import the blockout hidden in "blockout_ref".
// A document from an earlier run: delete rc11_* bodies and their instances. Anything else: refuse.
const BLOCKOUT = resolve(homedir(), "Downloads/neoRC11_blockout_parts.step");
await stage("reset", async (notes) => {
  const st = await status();
  const groups = ((await call("plasticity_list_groups")).groups ?? []) as Array<{ name: string | null; bodyIds: number[] }>;
  const ref = new Set(groups.filter((g) => g.name === "blockout_ref").flatMap((g) => g.bodyIds));
  const startupCube = (b: Body) => b.boundsMm.min.join() === "-500,-500,0" && b.boundsMm.max.join() === "500,500,1000";
  const mine = st.bodies.filter((b: Body) => (b.name ?? "").startsWith("rc11_"));
  const cube = st.bodies.filter((b: Body) => !ref.has(b.id) && !mine.includes(b) && startupCube(b));
  const unknown = st.bodies.filter((b: Body) => !ref.has(b.id) && !mine.includes(b) && !cube.includes(b));
  if (unknown.length) throw new Error(`Refusing: document has bodies this build did not make: ${unknown.map(fmt).join(", ")}`);
  if (ref.size === 0 && st.undoDepth > 10) throw new Error(`Refusing: not a fresh document (undo depth ${st.undoDepth})`);
  const instances = ((await call("plasticity_list_instances")).instances ?? []) as Array<{ id: number; sourceBodyIds: number[] }>;
  const mineIds = new Set(mine.map((b: Body) => b.id));
  const myInstances = instances.filter((i) => i.sourceBodyIds.some((id) => mineIds.has(id))).map((i) => i.id);
  if (myInstances.length) await call("plasticity_delete_instances", { ids: myInstances, revision: await rev() });
  const drop = [...mine, ...cube].map((b: Body) => b.id);
  if (drop.length) await raw("plasticity_delete", { ids: drop, revision: await rev() });
  notes.push(`deleted ${mine.length} rc11 bodies, ${cube.length} startup cube, ${myInstances.length} instances`);
  if (ref.size === 0) {
    const imported = await call("plasticity_import_step", { path: BLOCKOUT, revision: await rev() });
    const ids = (imported.importedBodyIds ?? imported.bodyIds ?? imported.change?.added?.map((b: Body) => b.id) ?? []) as number[];
    if (!ids.length) throw new Error(`blockout import returned no bodies: ${JSON.stringify(imported).slice(0, 400)}`);
    await call("plasticity_create_group", { bodyIds: ids, name: "blockout_ref", revision: await rev() });
    await hide(ids);
    const b = (await bodies()).filter((x) => ids.includes(x.id));
    notes.push(`imported blockout ${ids.length} bodies (hidden, group blockout_ref): ${b.map(fmt).join("; ")}`);
  }
});

// ---- 1. body slab: XZ section (flat belly, sides tucked 100 mm under, deck arc with a 15 mm crown),
// extruded in Y from the vertical tail face, nose cut vertically to the inlet lip's plan V, cut to +X.
const BODY = { yTail: -5800, belly: 1040, deckEdge: 2745, deckCrown: 2760, half: 2400, tuck: 100 };
const NOSE_V = { outerY: 6040, tipY: 6680, halfSpan: 2400 };
const noseY = (x: number) => NOSE_V.tipY - (NOSE_V.tipY - NOSE_V.outerY) * Math.abs(x) / NOSE_V.halfSpan;
const deckZ = (x: number) => { const R = (BODY.half ** 2 + 15 ** 2) / 30; return BODY.deckCrown - R + Math.sqrt(R * R - x * x); };
await stage("body", async (notes) => {
  const y0 = BODY.yTail;
  const out = await batch(chain([
    step("plasticity_create_polyline", { pointsMm: [[-BODY.half, y0, BODY.deckEdge], [-(BODY.half - BODY.tuck), y0, BODY.belly], [BODY.half - BODY.tuck, y0, BODY.belly], [BODY.half, y0, BODY.deckEdge]] }),
    step("plasticity_create_three_point_arc", { startMm: [BODY.half, y0, BODY.deckEdge], throughMm: [0, y0, BODY.deckCrown], endMm: [-BODY.half, y0, BODY.deckEdge] }),
    step("plasticity_join_curves", { ids: ["$0.added[0]", "$1.added[0]"] }),
    step("plasticity_extrude_profile", { id: "$2.added[0]", distanceMm: 12800 }),
  ]));
  const bodyId = out.steps[3].added[0] as number;
  let body = (await bodies()).find((b) => b.id === bodyId)!;
  notes.push(`extruded ${fmt(body)}`);
  if (body.boundsMm.max[1] < y0 + 1) throw new Error(`extrude went -Y: ${fmt(body)}`);
  await rename(out.steps[2].added[0], "rc11_body_section");
  const v = [[-3000, noseY(-3000), 3400], [0, NOSE_V.tipY, 3400], [3000, noseY(3000), 3400]];
  const cut = await batch(chain([
    step("plasticity_create_polyline", { pointsMm: v }),
    step("plasticity_cut_with_curves", { targetIds: [bodyId], curveIds: ["$0.added[0]"], direction: [0, 0, -1], extend: true, keep: "larger" }),
  ]));
  await rename(cut.steps[0].added[0], "rc11_nose_v");
  await keepPositiveX(bodyId);
  await rename(bodyId, "rc11_body");
  await hide((await bodies()).filter((b) => b.type === "Wire" && (b.name ?? "").startsWith("rc11_")).map((b) => b.id));
  body = await byName("rc11_body");
  notes.push(fmt(body));
  // Visible body edges before the pods: belly-to-side (seen from below), tail top/bottom, nose top/bottom.
  await fillet(bodyId, await edgesIn(bodyId, [2200, y0 - 1, 1000], [2400, 6100, 1100], 1000), 100, "g2", "belly side edge", notes);
  await fillet(bodyId, await edgesIn(bodyId, [-1, y0 - 1, 2700], [2401, y0 + 1, 2800]), 80, "g2", "tail top edge", notes);
  await fillet(bodyId, await edgesIn(bodyId, [-1, y0 - 1, 1000], [2401, y0 + 1, 1100]), 60, "g2", "tail belly edge", notes);
  await call("plasticity_create_mirrored_instance", { bodyId, axis: "x", planeOffsetMm: 0, revision: await rev() });
});

// ---- 2. inlet pocket: 250 mm deep, Z 1160..2440, floor parallel to the lip V. Its outer wall (X 2200) is
// the pod's inner wall once the pod is unioned, so the pocket is cut wider than the body.
const POCKET = { depth: 250, zLo: 1160, zHi: 2440 };
await stage("inlet", async (notes) => {
  const body = await byName("rc11_body");
  const xs = [0, 2600];
  const floor = xs.map((x) => [x, noseY(x) - POCKET.depth, POCKET.zLo]);
  const front = xs.slice().reverse().map((x) => [x, noseY(x) + 400, POCKET.zLo]);
  const out = await batch(chain([
    step("plasticity_create_polyline", { pointsMm: [[-50, noseY(0) - POCKET.depth, POCKET.zLo], ...floor.slice(1), ...front.slice(0, 1), [-50, noseY(0) + 400, POCKET.zLo]], closed: true }),
    step("plasticity_extrude_profile", { id: "$0.added[0]", distanceMm: POCKET.zHi - POCKET.zLo }),
  ]));
  const prism = out.steps[1].added[0] as number;
  const p = (await bodies()).find((b) => b.id === prism)!;
  if (p.boundsMm.min[2] < POCKET.zLo - 1) throw new Error(`pocket prism went down: ${fmt(p)}`);
  await rename(out.steps[0].added[0], "rc11_pocket_profile");
  await raw("plasticity_boolean", { targetIds: [body.id], toolIds: [prism], operation: "difference", revision: await rev() });
  await hide([out.steps[0].added[0]]);
  notes.push(`pocket cut; ${fmt(await byName("rc11_body"))}`);
});

// ---- 3. fender pod: XZ section (inner wall X 2200 buried in the body, flat bottom Z 1120, vertical outer
// face X 3680, flat top Z 2800 with a crisp outer edge, inner flank sloping 20° down across the deck edge so a
// 250 mm valley blend fits), extruded in Y, blade ends cut on slanted lines, then G2 fillets.
const POD = { xIn: 2200, xOut: 3680, zBot: 1120, zTop: 2800, xTopIn: 2450, flankDeg: 20 };
const FRONT = { yTop: 7160, yBot: 6840 }, REAR = { yTop: -6720, yBot: -6480 };
const bladeY = (end: typeof FRONT, z: number) => end.yBot + (end.yTop - end.yBot) * (z - POD.zBot) / (POD.zTop - POD.zBot);
await stage("pods", async (notes) => {
  const flankZ = (x: number) => POD.zTop - (POD.xTopIn - x) * Math.tan(POD.flankDeg * D);
  const y0 = -7200;
  const section = [[POD.xIn, y0, POD.zBot], [POD.xOut, y0, POD.zBot], [POD.xOut, y0, POD.zTop], [POD.xTopIn, y0, POD.zTop], [POD.xIn, y0, r(flankZ(POD.xIn))]];
  const out = await batch(chain([
    step("plasticity_create_polyline", { pointsMm: section, closed: true }),
    step("plasticity_extrude_profile", { id: "$0.added[0]", distanceMm: 14800 }),
  ]));
  const pod = out.steps[1].added[0] as number;
  await rename(out.steps[0].added[0], "rc11_pod_section");
  await rename(pod, "rc11_pod");
  const x = 3000;
  const line = (end: typeof FRONT) => [[x, r(bladeY(end, 700)), 700], [x, r(bladeY(end, 3200)), 3200]];
  const cut = await batch(chain([
    step("plasticity_create_polyline", { pointsMm: line(FRONT) }),
    step("plasticity_cut_with_curves", { targetIds: [pod], curveIds: ["$0.added[0]"], direction: [1, 0, 0], extend: true, keep: "larger" }),
    step("plasticity_create_polyline", { pointsMm: line(REAR) }),
    step("plasticity_cut_with_curves", { targetIds: [pod], curveIds: ["$2.added[0]"], direction: [1, 0, 0], extend: true, keep: "larger" }),
  ]));
  await rename(cut.steps[0].added[0], "rc11_blade_front");
  await rename(cut.steps[2].added[0], "rc11_blade_rear");
  await hide([out.steps[0].added[0], cut.steps[0].added[0], cut.steps[2].added[0]]);
  notes.push(fmt(await byName("rc11_pod")));
  // Longitudinal pod edges (span most of Y): outer bottom, inner bottom, flank-to-top shoulder. The top outer
  // edge stays sharp (character line).
  const yLo = -6800, yHi = 7200;
  await fillet(pod, await edgesIn(pod, [POD.xOut - 1, yLo, POD.zBot - 1], [POD.xOut + 1, yHi, POD.zBot + 1], 5000), 300, "g2", "pod outer bottom", notes);
  await fillet(pod, await edgesIn(pod, [POD.xIn - 1, yLo, POD.zBot - 1], [POD.xIn + 1, yHi, POD.zBot + 1], 5000), 150, "g2", "pod inner bottom", notes);
  await fillet(pod, await edgesIn(pod, [POD.xTopIn - 1, yLo, POD.zTop - 1], [POD.xTopIn + 1, yHi, POD.zTop + 1], 5000), 250, "g2", "pod flank shoulder", notes);
});

// ---- 4. pod into body: union, then the G2 valley blend between deck and pod flank and the G2 junction under
// the pod (pod bottom against the tucked body side).
await stage("valley", async (notes) => {
  const body = await byName("rc11_body"), pod = await byName("rc11_pod");
  const before = new Set((await edgesOf(body.id)).map((e) => e.id));
  await union(body.id, [pod.id]);
  const edges = (await edgesOf(body.id)).filter((e) => !before.has(e.id));
  const along = (e: Edge, zlo: number, zhi: number, xlo: number, xhi: number) => e.boundsMm
    && e.boundsMm.min[2] >= zlo && e.boundsMm.max[2] <= zhi && e.boundsMm.min[0] >= xlo && e.boundsMm.max[0] <= xhi
    && e.boundsMm.max[1] - e.boundsMm.min[1] > 2000;
  const valley = edges.filter((e) => along(e, 2700, 2800, 2200, 2450)).map((e) => e.id);
  const under = edges.filter((e) => along(e, 1100, 1300, 2250, 2400)).map((e) => e.id);
  notes.push(`union: ${edges.length} new edges, valley ${valley.length}, under ${under.length}`);
  await fillet(body.id, valley, 250, "g2", "deck-to-pod valley", notes);
  await fillet(body.id, under, 60, "g2", "pod-to-body underside", notes);
  const inst = ((await call("plasticity_list_instances")).instances ?? []) as Array<{ sourceBodyIds: number[] }>;
  notes.push(`mirror instance still linked to rc11_body: ${inst.some((i) => i.sourceBodyIds.includes(body.id))}`);
});

// ---- 5. cabin: closed control-point sections (full width, flat crowned roof, slight tumblehome, buried flat
// bottom), lofted with natural curvature through the six spec stations plus one buried station beyond each
// root so the cabin rises out of the deck, capped, cut to +X, unioned, G2 300 mm fillet to the deck.
const STATIONS: Array<[number, number, number, number]> = [
  [-3260, 3900, 0, 2560], // buried, behind the rear root (top 2560 is under the deck)
  [-3040, 4160, 240, 2800], [-2720, 4320, 960, 3160], [-2200, 4320, 1200, 3360],
  [200, 4320, 1200, 3360], [1000, 4160, 960, 3240], [1680, 3920, 320, 2920],
  [2000, 3600, 0, 2600], // buried, ahead of the front root
];
function cabinSection(y: number, width: number, height: number, cz: number) {
  const a = width / 2;
  const top = height > 0 ? cz + height / 2 : cz;
  const bottom = 2400;
  const corner = Math.min(0.25 * Math.max(height, 200), 160);
  const crown = height >= 900 ? 20 : 10;
  const right = [[0, top + crown], [0.5 * a, top + crown * 0.7], [0.9 * a, top], [0.97 * a, top - corner], [a, Math.max(bottom + 50, top - 0.5 * Math.max(height, 200))], [a, bottom], [0.5 * a, bottom]];
  const pts = [...right, [0, bottom], ...right.slice(1).reverse().map(([x, z]) => [-x!, z!])];
  return { toolName: "plasticity_create_control_point_curve", arguments: { pointsMm: pts.map(([x, z]) => [r(x!), y, r(z!)]), closed: true } };
}
await stage("cabin", async (notes) => {
  const n = STATIONS.length;
  const out = await batch([
    ...STATIONS.map(([y, w, h, cz]) => cabinSection(y, w, h, cz)),
    step("plasticity_loft_curves", { profileIds: STATIONS.map((_, i) => `$${i}.added[0]`), curvature: "natural" }),
    step("plasticity_cap_sheet_holes", { ids: [`$${n}.added[0]`] }),
  ]);
  const sections = out.steps.slice(0, n).map((x: { added: number[] }) => x.added[0]!);
  for (const [i, id] of sections.entries()) await rename(id, `rc11_cabin_station_${i}`);
  await hide(sections);
  const loft = out.steps[n].added[0] as number;
  let cabin = (await bodies()).find((b) => b.id === loft)!;
  if (cabin.type !== "Solid") {
    const solid = await call("plasticity_create_solid_from_sheet", { id: loft, revision: await rev() });
    const sid = (solid.change?.added ?? []).find((b: Body) => b.type === "Solid")?.id;
    if (!sid) throw new Error(`cabin did not close into a solid: ${fmt(cabin)}`);
    await hide([loft]); await rename(loft, "rc11_cabin_sheet");
    cabin = (await bodies()).find((b) => b.id === sid)!;
  }
  await rename(cabin.id, "rc11_cabin");
  await keepPositiveX(cabin.id);
  notes.push(fmt(await byName("rc11_cabin")));
  // Visor glass: the cabin surface between Z 3300 and 3440 ahead of Y -2500 (front and sides at the waist),
  // copied as a separate sheet "rc11_Visor"; the hull keeps its own faces and stays watertight.
  const band = await batch(chain([
    step("plasticity_duplicate_bodies", { ids: [cabin.id] }),
    step("plasticity_create_box", { originMm: [0, -2500, 3300], sizeMm: [3000, 6000, 140], name: "rc11_visor_band" }),
    step("plasticity_boolean", { targetIds: ["$0.added[0]"], toolIds: ["$1.addedSolids[0]"], operation: "intersection" }),
  ]));
  const bandId = band.steps[0].added[0] as number;
  const faces = ((await raw("plasticity_body_info", { id: bandId })).body?.faces ?? []) as Array<{ id: string; planar: boolean }>;
  const outer = faces.filter((f) => !f.planar);
  if (outer.length) {
    const ex = await call("plasticity_extract_faces", { faces: outer.map((f) => ({ bodyId: bandId, faceId: f.id })), revision: await rev() });
    const sheets = (ex.change?.added ?? []).map((b: Body) => b.id) as number[];
    if (sheets.length > 1) await call("plasticity_join_sheets", { ids: sheets, revision: await rev() });
    const visor = (await bodies()).find((b) => sheets.includes(b.id))!;
    await rename(visor.id, "rc11_Visor");
    await call("plasticity_set_appearance_material", { ids: [visor.id], name: "Visor glass", colorHex: "#1b2a38", roughness: 0.05, metalness: 0.2, opacity: 0.55, revision: await rev() });
    notes.push(`visor ${fmt(visor)} from ${outer.length} faces`);
  } else notes.push("visor: no curved faces in band");
  await raw("plasticity_delete", { ids: [bandId], revision: await rev() });
});

await stage("cabin-blend", async (notes) => {
  const body = await byName("rc11_body"), cabin = await byName("rc11_cabin");
  const before = new Set((await edgesOf(body.id)).map((e) => e.id));
  await union(body.id, [cabin.id]);
  const created = (await edgesOf(body.id)).filter((e) => !before.has(e.id) && e.boundsMm && e.boundsMm.min[2] > 2600 && e.boundsMm.max[2] < 2900 && e.boundsMm.min[1] > -3500 && e.boundsMm.max[1] < 2300).map((e) => e.id);
  notes.push(`cabin seam edges ${created.length}`);
  await fillet(body.id, created, 300, "g2", "cabin-to-deck", notes);
});

// ---- 6. buttresses: tapered sail panels from the cabin's rear quarter aft along the deck, lofted from three
// closed sections that shrink into the deck, unioned, G2 blended.
await stage("buttress", async (notes) => {
  const body = await byName("rc11_body");
  const sec = (y: number, xc: number, w: number, top: number) => {
    const a = w / 2, b = 2560;
    const pts = [[xc, top], [xc + 0.6 * a, top - 0.15 * (top - b)], [xc + a, b + 0.4 * (top - b)], [xc + a, b], [xc - a, b], [xc - a, b + 0.4 * (top - b)], [xc - 0.6 * a, top - 0.15 * (top - b)]];
    return { toolName: "plasticity_create_control_point_curve", arguments: { pointsMm: pts.map(([x, z]) => [r(x!), y, r(z!)]), closed: true } };
  };
  const out = await batch([
    sec(-2500, 1900, 520, 3500), sec(-3700, 1900, 380, 2980), sec(-5000, 1900, 220, 2700),
    step("plasticity_loft_curves", { profileIds: ["$0.added[0]", "$1.added[0]", "$2.added[0]"], curvature: "natural" }),
    step("plasticity_cap_sheet_holes", { ids: ["$3.added[0]"] }),
  ]);
  await hide([0, 1, 2].map((i) => out.steps[i].added[0]));
  for (const i of [0, 1, 2]) await rename(out.steps[i].added[0], `rc11_buttress_station_${i}`);
  const b = out.steps[3].added[0] as number;
  await rename(b, "rc11_buttress");
  const before = new Set((await edgesOf(body.id)).map((e) => e.id));
  await union(body.id, [b]);
  const created = (await edgesOf(body.id)).filter((e) => !before.has(e.id) && e.boundsMm && e.boundsMm.max[1] < -2300 && e.boundsMm.min[2] > 2600).map((e) => e.id);
  notes.push(`buttress seam edges ${created.length}`);
  await fillet(body.id, created, 120, "g2", "buttress-to-deck", notes);
});

// ---- 7. side fins: 110 mm vanes with built-in round leading/trailing edges, lofted root→tip along a span
// canted 25° down from the pod outer face at X 3680, Z 2120, unioned, G2 root blend.
const FIN = { x: 3680, z: 2120, cant: 25, rootLe: -1200, rootTe: -5200, span: 1360, tipLe: -5040, tipTe: -6240, t: 110 };
await stage("fins", async (notes) => {
  const body = await byName("rc11_body");
  const dir: Vec = [Math.cos(FIN.cant * D), 0, -Math.sin(FIN.cant * D)];
  const nrm: Vec = [Math.sin(FIN.cant * D), 0, Math.cos(FIN.cant * D)];
  const sec = (s: number, le: number, te: number) => {
    const c = le - te, h = FIN.t / 2;
    const base: Vec = [FIN.x + s * dir[0], 0, FIN.z + s * dir[2]];
    const uv = [[0, 0.55 * h], [40, h], [c / 2, h], [c - 40, h], [c, 0.55 * h], [c, -0.55 * h], [c - 40, -h], [c / 2, -h], [40, -h], [0, -0.55 * h]];
    return { toolName: "plasticity_create_control_point_curve", arguments: { closed: true, pointsMm: uv.map(([u, v]) => [r(base[0] + v! * nrm[0]), r(le - u!), r(base[2] + v! * nrm[2])]) } };
  };
  const out = await batch([
    sec(-150, FIN.rootLe + 30, FIN.rootTe - 30), sec(FIN.span, FIN.tipLe, FIN.tipTe),
    step("plasticity_loft_curves", { profileIds: ["$0.added[0]", "$1.added[0]"], curvature: "natural" }),
    step("plasticity_cap_sheet_holes", { ids: ["$2.added[0]"] }),
  ]);
  await rename(out.steps[0].added[0], "rc11_fin_root"); await rename(out.steps[1].added[0], "rc11_fin_tip");
  await hide([out.steps[0].added[0], out.steps[1].added[0]]);
  const fin = out.steps[2].added[0] as number;
  await rename(fin, "rc11_fin");
  notes.push(fmt(await byName("rc11_fin")));
  const tipEdges = await edgesIn(fin, [FIN.x + FIN.span * dir[0] - 80, -6400, 0], [9000, -4900, 9000]);
  if (tipEdges.length) await fillet(fin, tipEdges, 40, "g2", "fin tip edge", notes);
  const before = new Set((await edgesOf(body.id)).map((e) => e.id));
  await union(body.id, [fin]);
  const created = (await edgesOf(body.id)).filter((e) => !before.has(e.id) && e.boundsMm && e.boundsMm.min[0] > FIN.x - 5 && e.boundsMm.max[0] < FIN.x + 5).map((e) => e.id);
  await fillet(body.id, created, 80, "g2", "fin root", notes);
});

// ---- 8. blade edges: tiny round on the slanted pod end edges (character lines kept sharp-looking).
await stage("blades", async (notes) => {
  const body = await byName("rc11_body");
  const all = await edgesOf(body.id);
  const atEnd = (e: Edge, end: typeof FRONT) => e.boundsMm && e.boundsMm.min[0] >= POD.xIn - 1 && e.boundsMm.min[1] >= Math.min(end.yTop, end.yBot) - 400 && e.boundsMm.max[1] <= Math.max(end.yTop, end.yBot) + 1;
  const front = all.filter((e) => atEnd(e, FRONT)).map((e) => e.id);
  const rear = all.filter((e) => e.boundsMm && e.boundsMm.min[0] >= POD.xIn - 1 && e.boundsMm.min[1] >= REAR.yTop - 1 && e.boundsMm.max[1] <= REAR.yBot + 400).map((e) => e.id);
  await fillet(body.id, [...front, ...rear], 8, "round", "blade end edges", notes);
});

// ---- 9. finish: drop the live instance, mirror, union into one solid, validate, export, measure.
await stage("finish", async (notes) => {
  const half = await byName("rc11_body");
  const inst = ((await call("plasticity_list_instances")).instances ?? []) as Array<{ id: number; sourceBodyIds: number[] }>;
  const mine = inst.filter((i) => i.sourceBodyIds.includes(half.id)).map((i) => i.id);
  if (mine.length) await call("plasticity_delete_instances", { ids: mine, revision: await rev() });
  const m = await raw("plasticity_mirror", { ids: [half.id], planeOriginMm: [0, 0, 0], planeNormal: [1, 0, 0], keepOriginal: true, revision: await rev() });
  const other = (m.change?.added ?? []).map((b: Body) => b.id) as number[];
  await union(half.id, other);
  await rename(half.id, "rc11_hull");
  const visor = (await bodies()).find((b) => b.name === "rc11_Visor");
  if (visor) {
    const mv = await raw("plasticity_mirror", { ids: [visor.id], planeOriginMm: [0, 0, 0], planeNormal: [1, 0, 0], keepOriginal: true, revision: await rev() });
    const v2 = (mv.change?.added ?? []).map((b: Body) => b.id) as number[];
    if (v2.length) await call("plasticity_join_sheets", { ids: [visor.id, ...v2], revision: await rev() }).catch((e: unknown) => notes.push(`visor join: ${String(e).slice(0, 200)}`));
  }
  const hull = await byName("rc11_hull");
  const valid = await call("plasticity_validate_bodies", { ids: [hull.id], revision: await rev() });
  notes.push(`hull ${fmt(hull)} faces ${hull.faceCount}; validate ${JSON.stringify(valid).slice(0, 500)}`);
  // Centre seam continuity (edges lying in X = 0).
  const seam = (await edgesOf(hull.id)).filter((e) => e.boundsMm && Math.abs(e.boundsMm.min[0]) < 0.5 && Math.abs(e.boundsMm.max[0]) < 0.5).map((e) => ({ bodyId: hull.id, edgeId: e.id }));
  if (seam.length) {
    const res = await call("plasticity_analyze_surface_continuity", { edges: seam, revision: await rev() });
    const a = res.analyses ?? [];
    const max = (k: string) => Math.max(0, ...a.map((x: any) => Number(x[k]) || 0));
    continuity.push({ blend: "X=0 centre seam", edges: a.length, maxG0mm: r(max("maximumPositionDeviationMm")), maxG1deg: Math.round(max("maximumNormalAngleDeviationDeg") * 1e4) / 1e4, maxRelG2: Math.round(max("maximumRelativeCurvatureDeviation") * 1000) / 1000, verdict: "see per-edge" });
    await writeFile(resolve(outDir, "seam-continuity.json"), JSON.stringify(a, null, 1));
  } else notes.push("no seam edges left in X=0 (faces merged across the centre)");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const ids = [hull.id, ...(visor ? [visor.id] : [])];
  await raw("plasticity_export_step", { ids, path: resolve(outDir, `neoRC11-hull-${stamp}.step`), revision: await rev() });
  await call("plasticity_export_stl", { ids: [hull.id], path: resolve(outDir, `neoRC11-hull-${stamp}.stl`), chordToleranceMm: 2, angleToleranceDegrees: 10, revision: await rev() });
  await call("plasticity_export_obj", { ids: [hull.id], path: resolve(outDir, `neoRC11-hull-${stamp}.obj`), chordToleranceMm: 2, angleToleranceDegrees: 10, revision: await rev() });
  notes.push(`exported neoRC11-hull-${stamp}.{step,stl,obj}`);
});

if (continuity.length) {
  const path = resolve(outDir, "continuity.json");
  const old = existsSync(path) && only.size ? JSON.parse(await readFile(path, "utf8")) as typeof continuity : [];
  const merged = [...old.filter((o) => !continuity.some((c) => c.blend === o.blend)), ...continuity];
  await writeFile(path, JSON.stringify(merged, null, 1));
  console.table(continuity);
}
console.log((await bodies()).filter((b) => (b.name ?? "").startsWith("rc11_") && b.type !== "Wire").map(fmt).join("\n"));
await s.close();
