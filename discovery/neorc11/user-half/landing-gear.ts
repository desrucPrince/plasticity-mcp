// Retractable landing gear and a boarding hatch on the neoRC 11 belly, built on the live-mirrored V10+ document.
// Gear (landed pose): four legs at X ±1600, pivots at Y 4400 (front) and -3200 (rear), Z 2250 (belly at Z 2040). Each
// sits in an 880 x 1940 bay, 400 mm deep, with a dark ceiling liner and a chamfered lip. Parts: a trunnion with a pivot
// pin, a 300 mm upper strut, a 260 mm intermediate stage, a chrome slider, a fork housing, a knuckle (Z 110), an 800 mm
// dished footpad 60 mm thick with a bolt ring (bottom at Z 0), a two-link side brace with a knee and a hydraulic
// actuator (both on the fixed upper strut), and two bay doors hanging open 90°. One leg is the source;
// the rear leg is a translated instance, and every +X part has a mirrored instance (EDIT SIDE / MIRROR groups).
// Stowed: the telescope closes 800 mm (intermediate 570 mm into the strut, slider 230 mm more into the intermediate),
// then the leg turns -90° about X through its pivot (foot toward -Y) and the foot turns back flat about its knuckle.
// Boarding lift: a 1.3 x 2.2 m hatch on the centreline under the cabin (Y 1700..3900) deepened into a shaft to Z 4300,
// lined dark with a ceiling light panel; a 150 mm platform (whole centreline part) shown down on its feet at Z 0, on
// four 3-stage telescoping rams (2040 mm travel) that come out of housings in the shaft corners, with a 1.0 m rail on three sides
// (open toward the rear). Raised, the platform closes the hatch flush with the belly. Two 1.80 m human figures go in
// "SCALE REF (hide before export)".
// Contact faces are embedded 0.5 mm; doors and the ramp keep 4 mm shadow gaps; no new face is coplanar with another.
// Writes discovery/neorc11/gear_pivots.json. A rerun removes rc11_lg_* / rc11_hatch_* (hull cuts are made once).
// Usage: PLASTICITY_CDP_URL=http://127.0.0.1:9223 node discovery/neorc11/user-half/landing-gear.ts
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openSession } from "../../mcp-client.ts";

type Vec = [number, number, number];
const s = await openSession();
const raw = (n: string, a: Record<string, unknown> = {}) => s.raw(n, a);
const call = (t: string, a: Record<string, unknown> = {}) => raw("plasticity_call", { toolName: t, arguments: a });
const rev = async () => (await raw("plasticity_status", { bodyLimit: 1 })).revision as string;
async function bodies(): Promise<any[]> {
  const first = await raw("plasticity_status", { bodyLimit: 200 }); const all = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  return all;
}
const body = async (id: number) => (await bodies()).find((b) => b.id === id);
const info = async (id: number) => (await raw("plasticity_body_info", { id })).body as { edges: any[]; faces: any[] };
const instances = async () => ((await call("plasticity_list_instances")).instances ?? []) as Array<{ id: number; sourceBodyIds: number[] }>;
const groupId = async (name: string) => (((await call("plasticity_list_groups")).groups ?? []) as any[]).find((g) => g.name === name)?.id as number | undefined;
const notes: string[] = [];
const say = (...x: unknown[]) => { const t = x.map(String).join(" "); notes.push(t); console.log(t); };
const logPath = resolve("discovery/neorc11/user-half/landing-gear-log.json");
const done: Record<string, boolean> = existsSync(logPath) ? (JSON.parse(await readFile(logPath, "utf8")).done ?? {}) : {};
const D = Math.PI / 180;
const r1 = (v: number) => Math.round(v * 10) / 10;

const BELLY = 2040;
const G = { x: 1600, bayX0: 1160, bayX1: 2040, depth: 400, pivotZ: 2250, front: 4400, rear: -3200, ahead: 150, behind: 1790, gap: 4 };
const CEIL = BELLY + G.depth;
const H = { x1: 650, y0: 1700, y1: 3900, depth: 300, thick: 40, gap: 4 };
// Boarding lift: shaft up to Z 3500 (>= 98 mm of skin under the windscreen), 150 mm platform, rams in the corners.
const L = { shaftTop: 4300, thick: 150, ramX: 560, ramInset: 90, housingBottom: 2210, housingTop: 3500, railX: 450 };
// Telescoping leg, as depths below the pivot (landed): strut 60..690, intermediate 650..1250, slider 1210..pivot-300.
// Closing: the intermediate rises 570 (ends 10 mm inside the strut mouth), the slider rises 800 in all.
const T = { strutEnd: 690, midTop: 650, midEnd: 1250, midR: 130, sliderTop: 1210, closeMid: 570, close: 800 };

const material = async (ids: number[], name: string, colorHex: string, roughness: number, metalness: number) =>
  call("plasticity_set_appearance_material", { ids, name, colorHex, roughness, metalness, opacity: 1, revision: await rev() });
async function box(o: Vec, size: Vec, name: string) {
  const id = (await raw("plasticity_batch", { steps: [{ toolName: "plasticity_create_box", arguments: { originMm: o.map(r1), sizeMm: size.map(r1), name } }] })).steps[0].added[0] as number;
  return id;
}
async function rod(a: Vec, b: Vec, r: number, name: string) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]; const len = Math.hypot(...d); const ax = d.map((v) => v / len) as Vec;
  const id = (await raw("plasticity_batch", { steps: [{ toolName: "plasticity_create_cylinder", arguments: { centerMm: a, radiusMm: r, heightMm: len, axis: ax, name } }] })).steps[0].added[0] as number;
  const bb = await body(id);
  const delta = [0, 1, 2].map((i) => (a[i]! + b[i]!) / 2 - (bb.boundsMm.min[i] + bb.boundsMm.max[i]) / 2) as Vec;
  if (delta.some((v) => Math.abs(v) > 0.01)) await raw("plasticity_move", { ids: [id], deltaMm: delta, revision: await rev() });
  await call("plasticity_rename", { id, name, revision: await rev() });
  return id;
}
async function unite(target: number, tools: number[]) { if (tools.length) await raw("plasticity_boolean", { targetIds: [target], toolIds: tools, operation: "union", revision: await rev() }); }
async function soften(id: number, r: number) {
  try { await raw("plasticity_fillet", { id, edgeIds: (await info(id)).edges.map((e) => e.id), radiusMm: r, revision: await rev() }); return "fillet"; }
  catch { try { await raw("plasticity_chamfer", { id, edgeIds: (await info(id)).edges.map((e) => e.id), distanceMm: r * 0.6, revision: await rev() }); return "chamfer"; } catch { return "none"; } }
}
const rotate = async (ids: number[], pivot: Vec, axis: Vec, deg: number) => raw("plasticity_rotate", { ids, pivotMm: pivot, axis, degrees: deg, revision: await rev() });
async function newest(make: () => Promise<unknown>) {
  const before = new Set((await instances()).map((i) => i.id)); await make();
  return (await instances()).find((i) => !before.has(i.id))!.id;
}
const counts: Record<string, number> = {};
// +X source: translated linked instances plus a mirrored instance for the source and each translation; grouped.
async function place(src: number, ts: Vec[]) {
  const made: number[] = [];
  for (const t of ts) made.push(await newest(async () => call("plasticity_create_instance", { bodyId: src, translationMm: t, revision: await rev() })));
  for (const t of [[0, 0, 0] as Vec, ...ts]) {
    const id = await newest(async () => call("plasticity_create_mirrored_instance", { bodyId: src, axis: "x", planeOffsetMm: 0, revision: await rev() }));
    if (t.some((v) => v !== 0)) await call("plasticity_move_instances", { ids: [id], deltaMm: [-t[0], t[1], t[2]], revision: await rev() });
    made.push(id);
  }
  await call("plasticity_move_to_group", { bodyIds: [src], destinationGroupId: await groupId("EDIT SIDE"), revision: await rev() });
  await call("plasticity_move_to_group", { instanceIds: made, destinationGroupId: await groupId("MIRROR (don't edit)"), revision: await rev() });
  const name = (await body(src)).name;
  counts[name] = made.length;
}
async function cutHull(o: Vec, size: Vec, label: string) {
  const hull = (await bodies()).find((b) => b.name === "rc11_hull");
  const c = await box(o, size, "rc11_lg_cutter");
  const pre = new Set((await info(hull.id)).edges.map((e) => e.id));
  await raw("plasticity_boolean", { targetIds: [hull.id], toolIds: [c], operation: "difference", revision: await rev() });
  const lip = (await info(hull.id)).edges.filter((e) => !pre.has(e.id) && Math.abs(e.boundsMm.min[2] - BELLY) < 0.5 && Math.abs(e.boundsMm.max[2] - BELLY) < 0.5 && e.lengthMm > 100 && e.boundsMm.max[0] > 1).map((e) => e.id);
  let lipNote = "lip refused";
  try { await raw("plasticity_fillet", { id: hull.id, edgeIds: lip, radiusMm: 10, revision: await rev() }); lipNote = "lip fillet r10"; }
  catch { try { await raw("plasticity_chamfer", { id: hull.id, edgeIds: lip, distanceMm: 8, revision: await rev() }); lipNote = "lip chamfer 8"; } catch { /* keep note */ } }
  say(`${label}: cut ${size.map(Math.round).join(" x ")}, ${lipNote}`);
}

try {
  // ---- 0. clearance of the planned cut-outs against existing parts (abort if anything is in the way)
  const zones: Record<string, [Vec, Vec]> = {
    "front gear bay": [[G.bayX0, G.front - G.behind, 900], [G.bayX1, G.front + G.ahead, CEIL]],
    "rear gear bay": [[G.bayX0, G.rear - G.behind, 900], [G.bayX1, G.rear + G.ahead, CEIL]],
    "hatch shaft": [[0, H.y0, 0], [H.x1, H.y1, L.shaftTop]],
  };
  const others = (await bodies()).filter((b) => b.visible !== false && b.type !== "Wire" && b.name !== "rc11_hull" && !/^rc11_(lg|hatch|ref)_/.test(b.name ?? ""));
  for (const [name, [lo, hi]] of Object.entries(zones)) {
    const hits = others.filter((b) => [0, 1, 2].every((i) => b.boundsMm.min[i] < hi[i]! && b.boundsMm.max[i] > lo[i]!));
    if (hits.length) throw new Error(`${name} collides with ${hits.map((b) => `${b.name}#${b.id}`).join(", ")}`);
  }
  say(`clear zones: gear bays X ${G.bayX0}..${G.bayX1} at Y ${G.front - G.behind}..${G.front + G.ahead} and ${G.rear - G.behind}..${G.rear + G.ahead}; hatch X ±${H.x1}, Y ${H.y0}..${H.y1}`);

  // ---- 1. reset earlier gear/hatch parts
  const old = (await bodies()).filter((b) => /^rc11_(lg|hatch|ref)_/.test(b.name ?? ""));
  if (old.length) {
    const ids = new Set(old.map((b) => b.id));
    const inst = (await instances()).filter((i) => i.sourceBodyIds.some((x) => ids.has(x))).map((i) => i.id);
    if (inst.length) await call("plasticity_delete_instances", { ids: inst, revision: await rev() });
    await raw("plasticity_delete", { ids: [...ids], revision: await rev() });
    say(`removed ${old.length} earlier gear/hatch bodies`);
  }
  // ---- 2. hull cuts (once)
  if (!done.cuts) {
    for (const yp of [G.front, G.rear]) await cutHull([G.bayX0, yp - G.behind, BELLY - 20], [G.bayX1 - G.bayX0, G.behind + G.ahead, G.depth + 20], `gear bay at Y ${yp}`);
    await cutHull([-20, H.y0, BELLY - 20], [H.x1 + 20, H.y1 - H.y0, L.shaftTop - BELLY + 20], "hatch shaft");
    done.cuts = true;
  }

  // ---- 3. leg (front, +X source parts)
  const yp = G.front;
  const P: Vec = [G.x, yp, G.pivotZ];
  const legParts: number[] = [];
  const trunnion = await box([G.x - 165, yp - 195, G.pivotZ - 90], [330, 390, CEIL + 0.5 - (G.pivotZ - 90)], "rc11_lg_trunnion");
  say(`trunnion edges: ${await soften(trunnion, 10)}`);
  await unite(trunnion, [await rod([G.x - 200, yp, G.pivotZ], [G.x + 200, yp, G.pivotZ], 68, "rc11_lg_pin")]);
  const strut = await rod([G.x, yp, G.pivotZ - 60], [G.x, yp, G.pivotZ - T.strutEnd], 150, "rc11_lg_strut");
  const mid = await rod([G.x, yp, G.pivotZ - T.midTop], [G.x, yp, G.pivotZ - T.midEnd], T.midR, "rc11_lg_stage");
  const slider = await rod([G.x, yp, G.pivotZ - T.sliderTop], [G.x, yp, 300], 108, "rc11_lg_slider");
  const fork = await rod([G.x, yp, 340], [G.x, yp, 190], 130, "rc11_lg_fork");
  await unite(fork, [await rod([G.x, yp, 200], [G.x, yp, 59.5], 75, "rc11_lg_post")]);
  const knuckle = await rod([G.x - 160, yp, 110], [G.x + 160, yp, 110], 58, "rc11_lg_knuckle"); // low knuckle: the folded pad rides above the closed doors
  // dished footpad with a bolt ring, bottom exactly on Z 0
  const foot = (await raw("plasticity_batch", { steps: [{ toolName: "plasticity_create_cylinder", arguments: { centerMm: [G.x, yp, 0], radiusMm: 400, heightMm: 60, axis: [0, 0, 1], name: "rc11_lg_foot" } }] })).steps[0].added[0] as number;
  const fb = await body(foot);
  if (Math.abs(fb.boundsMm.min[2]) > 0.01) await raw("plasticity_move", { ids: [foot], deltaMm: [0, 0, -fb.boundsMm.min[2]], revision: await rev() });
  await call("plasticity_rename", { id: foot, name: "rc11_lg_foot", revision: await rev() });
  const dish = (await raw("plasticity_batch", { steps: [{ toolName: "plasticity_create_cylinder", arguments: { centerMm: [G.x, yp, 48], radiusMm: 310, heightMm: 20, axis: [0, 0, 1], name: "rc11_lg_dish" } }] })).steps[0].added[0] as number;
  const db = await body(dish);
  if (Math.abs(db.boundsMm.min[2] - 48) > 0.01) await raw("plasticity_move", { ids: [dish], deltaMm: [0, 0, 48 - db.boundsMm.min[2]], revision: await rev() });
  await raw("plasticity_boolean", { targetIds: [foot], toolIds: [dish], operation: "difference", revision: await rev() });
  const boltsOnFoot: number[] = [];
  for (let k = 0; k < 8; k++) { const a = (k * 45 + 22.5) * D; const c: Vec = [G.x + 355 * Math.cos(a), yp + 355 * Math.sin(a), 59.5]; boltsOnFoot.push(await rod(c, [c[0], c[1], 69], 14, "rc11_lg_footbolt")); }
  await unite(foot, boltsOnFoot);
  // two-link side brace with a knee joint, from the bay ceiling behind the trunnion to the strut
  const knee: Vec = [G.x, yp - 420, G.pivotZ - 370];
  const upper = await rod([G.x, yp - 760, CEIL + 0.5], knee, 42, "rc11_lg_brace_upper");
  const lower = await rod(knee, [G.x, yp - 90, G.pivotZ - 530], 42, "rc11_lg_brace_lower");
  await unite(upper, [lower, await rod([G.x - 77, knee[1], knee[2]], [G.x + 77, knee[1], knee[2]], 59, "rc11_lg_knee")]);
  await call("plasticity_rename", { id: upper, name: "rc11_lg_brace", revision: await rev() });
  // hydraulic actuator beside the brace: cylinder body plus chrome rod
  const aTop: Vec = [G.x + 230, yp - 560, CEIL + 0.5], aBot: Vec = [G.x + 140, yp - 40, G.pivotZ - 330];
  const aMid: Vec = [aTop[0] + (aBot[0] - aTop[0]) * 0.58, aTop[1] + (aBot[1] - aTop[1]) * 0.58, aTop[2] + (aBot[2] - aTop[2]) * 0.58];
  const actBody = await rod(aTop, aMid, 63, "rc11_lg_actuator");
  const actRod = await rod([aMid[0] - (aMid[0] - aTop[0]) * 0.05, aMid[1] - (aMid[1] - aTop[1]) * 0.05, aMid[2] - (aMid[2] - aTop[2]) * 0.05], aBot, 31, "rc11_lg_actuator_rod");
  // bay doors: built closed (outer face flush with the belly, 4 mm gaps), then swung open 90° about their hinges
  const half = (G.bayX1 - G.bayX0) / 2;
  const dIn = await box([G.bayX0 + G.gap, yp - G.behind + G.gap, BELLY], [half - 1.5 * G.gap, G.behind + G.ahead - 2 * G.gap, 18], "rc11_lg_door_inner");
  const dOut = await box([G.bayX0 + half + 0.5 * G.gap, yp - G.behind + G.gap, BELLY], [half - 1.5 * G.gap, G.behind + G.ahead - 2 * G.gap, 18], "rc11_lg_door_outer");
  for (const d of [dIn, dOut]) await soften(d, 4);
  await rotate([dIn], [G.bayX0, 0, BELLY], [0, 1, 0], 90);
  if ((await body(dIn)).boundsMm.min[2] > BELLY - 100) await rotate([dIn], [G.bayX0, 0, BELLY], [0, 1, 0], -180);
  await rotate([dOut], [G.bayX1, 0, BELLY], [0, 1, 0], -90);
  if ((await body(dOut)).boundsMm.min[2] > BELLY - 100) await rotate([dOut], [G.bayX1, 0, BELLY], [0, 1, 0], 180);
  say(`doors open: inner Z ${Math.round((await body(dIn)).boundsMm.min[2])}..${Math.round((await body(dIn)).boundsMm.max[2])}, outer Z ${Math.round((await body(dOut)).boundsMm.min[2])}..${Math.round((await body(dOut)).boundsMm.max[2])}`);
  const liner = await box([G.bayX0 + 5, yp - G.behind + 5, CEIL - 10.5], [G.bayX1 - G.bayX0 - 10, G.behind + G.ahead - 10, 10], "rc11_lg_liner");
  await material([trunnion, strut, fork, knuckle, upper, actBody], "Gunmetal", "#2b2f33", 0.35, 0.8);
  await material([slider, actRod], "Chrome", "#d9dde2", 0.08, 1);
  await material([mid], "Satin chrome", "#a9b0b8", 0.22, 1);
  await material([foot], "Footpad", "#1a1c1f", 0.7, 0.3);
  await material([dIn, dOut], "Eldorado midnight", "#0b1630", 0.3, 0.7);
  await material([liner], "Bay black", "#08090b", 0.75, 0.1);
  legParts.push(trunnion, strut, mid, slider, fork, knuckle, foot, upper, actBody, actRod, dIn, dOut, liner);

  // ---- 4. retract check on temporary copies (deleted afterwards)
  const check: Record<string, unknown> = {};
  const moving = [strut, mid, slider, fork, knuckle, foot];
  const before = new Set((await bodies()).map((b) => b.id));
  await call("plasticity_duplicate_bodies", { ids: moving, revision: await rev() });
  const temps = (await bodies()).filter((b) => !before.has(b.id));
  const tFoot = temps.find((b) => (b.name ?? "").startsWith("rc11_lg_foot"))!;
  const tMid = temps.find((b) => (b.name ?? "").startsWith("rc11_lg_stage"))!;
  const tLow = temps.filter((b) => /^rc11_lg_(slider|fork|knuckle|foot)/.test(b.name ?? ""));
  // close the telescope first
  await raw("plasticity_move", { ids: [tMid.id], deltaMm: [0, 0, T.closeMid], revision: await rev() });
  await raw("plasticity_move", { ids: tLow.map((b) => b.id), deltaMm: [0, 0, T.close], revision: await rev() });
  const closed = (await bodies()).filter((b) => temps.some((t) => t.id === b.id));
  const zr = (re: RegExp) => { const b = closed.find((x) => re.test(x.name ?? ""))!; return [b.boundsMm.min[2], b.boundsMm.max[2]] as [number, number]; };
  const [sLo, sHi] = zr(/^rc11_lg_strut/), [mLo, mHi] = zr(/^rc11_lg_stage/), [slLo, slHi] = zr(/^rc11_lg_slider/), [fLo] = zr(/^rc11_lg_foot/);
  check.telescope = { strokeMm: T.close, intermediateStrokeMm: T.closeMid, sliderStrokeInIntermediateMm: T.close - T.closeMid,
    closedIntermediateInsideStrutMm: { top: r1(sHi - mHi), bottom: r1(mLo - sLo) }, closedSliderTopInsideIntermediateMm: r1(mHi - slHi),
    closedSliderBelowStrutMm: r1(sLo - slLo), extendedOverlapsMm: { strutStage: T.strutEnd - T.midTop, stageSlider: T.midEnd - T.sliderTop }, closedFootBottomZ: r1(fLo) };
  await rotate(temps.map((b) => b.id), P, [1, 0, 0], -90);
  const kn = (await bodies()).find((b) => b.id === temps.find((t) => (t.name ?? "").startsWith("rc11_lg_knuckle"))!.id);
  const knC: Vec = [0, 1, 2].map((i) => (kn.boundsMm.min[i] + kn.boundsMm.max[i]) / 2) as Vec;
  await rotate([tFoot.id], knC, [1, 0, 0], 90);
  const stowed = (await bodies()).filter((b) => temps.some((t) => t.id === b.id));
  const lo = [0, 1, 2].map((i) => Math.min(...stowed.map((b) => b.boundsMm.min[i]))), hi = [0, 1, 2].map((i) => Math.max(...stowed.map((b) => b.boundsMm.max[i])));
  const clear = { xIn: lo[0]! - G.bayX0, xOut: G.bayX1 - hi[0]!, yFront: yp + G.ahead - hi[1]!, yRear: lo[1]! - (yp - G.behind), aboveClosedDoors: lo[2]! - (BELLY + 18), belowCeiling: CEIL - 10.5 - hi[2]! };
  check.leg = { pivotToKnuckleLandedMm: G.pivotZ - 110, pivotToKnuckleClosedMm: G.pivotZ - 110 - T.close, stowedBoundsMm: [lo.map(Math.round), hi.map(Math.round)], clearanceMm: Object.fromEntries(Object.entries(clear).map(([k, v]) => [k, Math.round(v)])), fits: Object.values(clear).every((v) => v >= 20) };
  await raw("plasticity_delete", { ids: temps.map((b) => b.id), revision: await rev() });
  check.doors = { closedOuterFaceZ: BELLY, gapMm: G.gap, flush: true, note: "doors are built closed flush with the belly and swung 90° about their hinge lines" };
  say(`retract check: ${JSON.stringify(check.leg)}`);

  // ---- 5. place the leg: rear leg as translated instances, mirrors for both
  for (const id of legParts) await place(id, [[0, G.rear - G.front, 0]]);

  // ---- 6. boarding lift in the hatch shaft
  // Shaft liner (+X with mirrors): side wall, front and rear walls, ceiling plate with an inset light panel. Each
  // plate is embedded 0.5 mm into its wall, so its visible face stands 9.5 mm proud and is never coplanar.
  const liners: number[] = [];
  liners.push(await box([H.x1 - 10, H.y0 + 10, BELLY + 60], [10.5, H.y1 - H.y0 - 20, L.shaftTop - 10 - (BELLY + 60)], "rc11_hatch_liner_side"));
  liners.push(await box([0.5, H.y1 - 10, BELLY + 60], [H.x1 - 11, 10.5, L.shaftTop - 10 - (BELLY + 60)], "rc11_hatch_liner_front"));
  liners.push(await box([0.5, H.y0 - 0.5, BELLY + 60], [H.x1 - 11, 10.5, L.shaftTop - 10 - (BELLY + 60)], "rc11_hatch_liner_rear"));
  liners.push(await box([0.5, H.y0 + 10, L.shaftTop - 10], [H.x1 - 11, H.y1 - H.y0 - 20, 10.5], "rc11_hatch_liner_ceiling"));
  await material(liners, "Bay black", "#08090b", 0.75, 0.1);
  const panel = await box([80, 2150, L.shaftTop - 15], [420, 1500, 5.5], "rc11_hatch_ceiling_light");
  const strip = await box([H.x1 - 4, H.y0 + 25, BELLY + 15], [5, H.y1 - H.y0 - 50, 12], "rc11_hatch_light");
  await material([panel, strip], "Hatch light", "#5fe6ff", 0.1, 0);
  // Ram housings recessed in the shaft corners (+X: rear corner source, front corner instance) and 3 chrome stages.
  const ramYs = [H.y0 + L.ramInset, H.y1 - L.ramInset];
  const housing = await rod([L.ramX, ramYs[0]!, L.housingBottom], [L.ramX, ramYs[0]!, L.housingTop], 70, "rc11_hatch_ram_housing");
  await material([housing], "Gunmetal", "#2b2f33", 0.35, 0.8);
  // Platform (whole centreline part), deployed resting on Z 0 (no feet, so raised it closes flush with the belly).
  const pz0 = 0, pz1 = pz0 + L.thick;
  const platform = await box([-(H.x1 - H.gap), H.y0 + H.gap, pz0], [2 * (H.x1 - H.gap), H.y1 - H.y0 - 2 * H.gap, L.thick], "rc11_hatch_platform");
  say(`platform edges: ${await soften(platform, 6)}`);
  await material([platform], "Eldorado midnight", "#0b1630", 0.3, 0.7);
  // Tread-plate ribs on top (one source, instances along Y) and light strips along the long top edges (+X, mirrored).
  const rib = await box([-560, H.y0 + 120, pz1 - 0.5], [1120, 14, 8.5], "rc11_hatch_rib");
  await material([rib], "Gunmetal", "#2b2f33", 0.35, 0.8);
  const ribIds: number[] = [];
  for (let k = 1; k < 17; k++) ribIds.push(await newest(async () => call("plasticity_create_instance", { bodyId: rib, translationMm: [0, 120 * k, 0], revision: await rev() })));
  const edgeLight = await box([H.x1 - H.gap - 30, H.y0 + 40, pz1 - 0.5], [18, H.y1 - H.y0 - 80, 4.5], "rc11_hatch_platform_light");
  await material([edgeLight], "Hatch light", "#5fe6ff", 0.1, 0);
  // Rams: stages from the housing bottom down to the platform top, overlapping 20 mm, chrome.
  const span = L.housingBottom - pz1;
  const stageLen = (span + 2 * 20) / 3;
  const stages: number[] = [];
  const radii = [55, 45, 35];
  for (let k = 0; k < 3; k++) {
    const top = L.housingBottom + 20 - k * (stageLen - 20), bottom = top - stageLen;
    stages.push(await rod([L.ramX, ramYs[0]!, top], [L.ramX, ramYs[0]!, k === 2 ? pz1 - 0.5 : bottom], radii[k]!, `rc11_hatch_ram_stage_${k + 1}`));
  }
  await material(stages, "Chrome", "#d9dde2", 0.08, 1);
  // Safety rail on 3 sides (open toward the rear, -Y): +X long rail with posts, front half rail; mirrored.
  const rx = L.railX, rTop = pz1 + 1000, rMid = pz1 + 500, ry0 = H.y0 + 260, ry1 = H.y1 - 170;
  const rail = await rod([rx, ry0, rTop], [rx, ry1, rTop], 20, "rc11_hatch_rail");
  const railParts: number[] = [await rod([rx, ry0, rMid], [rx, ry1, rMid], 14, "rc11_hatch_rail_mid")];
  for (const y of [ry0, (ry0 + ry1) / 2, ry1]) railParts.push(await rod([rx, y, pz1 - 0.5], [rx, y, rTop + 10], 18, "rc11_hatch_rail_post"));
  railParts.push(await rod([0.5, ry1, rTop], [rx, ry1, rTop], 20, "rc11_hatch_rail_front"), await rod([0.5, ry1, rMid], [rx, ry1, rMid], 14, "rc11_hatch_rail_front_mid"));
  await unite(rail, railParts);
  await material([rail], "Chrome", "#d9dde2", 0.08, 1);

  // ---- retract check for the lift on temporary copies: raise platform + rail + ribs by the travel; stages nest
  const travel = BELLY - pz0;
  const pre2 = new Set((await bodies()).map((b) => b.id));
  await call("plasticity_duplicate_bodies", { ids: [platform, rail, edgeLight], revision: await rev() });
  const tLift = (await bodies()).filter((b) => !pre2.has(b.id));
  await raw("plasticity_move", { ids: tLift.map((b) => b.id), deltaMm: [0, 0, travel], revision: await rev() });
  const lifted = (await bodies()).filter((b) => tLift.some((t) => t.id === b.id));
  const tp = lifted.find((b) => (b.name ?? "").startsWith("rc11_hatch_platform") && b.boundsMm.max[0] > 600)!;
  const tr = lifted.find((b) => (b.name ?? "").startsWith("rc11_hatch_rail"))!;
  const stowedStageTop = pz1 + travel + stageLen; // innermost stage pushed fully into the housing
  check.lift = {
    travelMm: travel, platformBottomRaisedZ: r1(tp.boundsMm.min[2]), flushErrorMm: r1(Math.abs(tp.boundsMm.min[2] - BELLY)),
    railTopRaisedZ: r1(tr.boundsMm.max[2]), shaftCeilingZ: L.shaftTop - 10, railClearToCeilingMm: r1(L.shaftTop - 10 - tr.boundsMm.max[2]),
    railToHousingMm: r1((L.ramX - 70) - (rx + 20)), housingToRaisedPlatformMm: r1(L.housingBottom - (pz1 + travel)),
    stagesNestInHousing: stowedStageTop <= L.housingTop - 20, stageLengthMm: r1(stageLen), headroomAboveRaisedPlatformMm: r1(L.shaftTop - 10 - (pz1 + travel)),
  };
  await raw("plasticity_delete", { ids: tLift.map((b) => b.id), revision: await rev() });
  say(`lift check: ${JSON.stringify(check.lift)}`);
  for (const id of [...liners, panel, strip, housing, ...stages, edgeLight, rail]) await place(id, id === housing || stages.includes(id) ? [[0, ramYs[1]! - ramYs[0]!, 0]] : []);
  await call("plasticity_create_group", { bodyIds: [platform, rib], instanceIds: ribIds, name: "HATCH (centreline)", revision: await rev() });

  // ---- human scale references (1.80 m mannequin): one on the lift platform, a linked copy beside the nose
  const human = async (o: Vec) => {
    const parts: number[] = [];
    const foot = async (sx: number) => { const id = await box([o[0] + sx * 105 - 50, o[1] - 70, o[2]], [100, 260, 80], "rc11_ref_human"); await soften(id, 20); return id; };
    parts.push(await foot(1), await foot(-1));
    for (const sx of [1, -1]) parts.push(await rod([o[0] + sx * 105, o[1], o[2] + 70], [o[0] + sx * 100, o[1], o[2] + 940], 72, "rc11_ref_human"));
    const torso = await box([o[0] - 200, o[1] - 115, o[2] + 900], [400, 230, 580], "rc11_ref_human");
    await soften(torso, 70); parts.push(torso);
    for (const sx of [1, -1]) parts.push(await rod([o[0] + sx * 239, o[1], o[2] + 1440], [o[0] + sx * 259, o[1], o[2] + 760], 45, "rc11_ref_human")); // overlap the torso so the union joins
    parts.push(await rod([o[0], o[1], o[2] + 1460], [o[0], o[1], o[2] + 1570], 55, "rc11_ref_human"));
    const head = (await raw("plasticity_batch", { steps: [{ toolName: "plasticity_create_sphere", arguments: { centerMm: [o[0], o[1], o[2] + 1680], radiusMm: 120, name: "rc11_ref_human" } }] })).steps[0].added[0] as number;
    parts.push(head);
    const [first, ...rest] = parts;
    await unite(first!, rest);
    await call("plasticity_rename", { id: first!, name: "rc11_ref_human", revision: await rev() });
    await material([first!], "Scale reference", "#ff8a3d", 0.5, 0);
    return first!;
  };
  const ref = await human([0, 2800, pz1 - 0.5]);
  const hb = await body(ref);
  const refCopy = await newest(async () => call("plasticity_create_instance", { bodyId: ref, translationMm: [-1800, 8700 - 2800, -(pz1 - 0.5)], revision: await rev() }));
  // walk-under check: a copy standing on the ground beside the lift, between the platform and the -X front gear
  const refUnder = await newest(async () => call("plasticity_create_instance", { bodyId: ref, translationMm: [-1000, 2000 - 2800, -(pz1 - 0.5)], revision: await rev() }));
  await call("plasticity_create_group", { bodyIds: [ref], instanceIds: [refCopy, refUnder], name: "SCALE REF (hide before export)", revision: await rev() });
  check.human = { heightMm: r1(hb.boundsMm.max[2] - hb.boundsMm.min[2]), shoulderWidthMm: r1(hb.boundsMm.max[0] - hb.boundsMm.min[0]) };
  say(`human reference: ${JSON.stringify(check.human)}`);

  // ---- 7. pivots
  const legs = [G.front, G.rear].flatMap((y) => [1, -1].map((sx) => ({ part: `leg ${y > 0 ? "front" : "rear"} ${sx > 0 ? "+X" : "-X"}`, pivot: [sx * G.x, y, G.pivotZ], axis: [1, 0, 0], deployedDeg: 0, stowedDeg: -90,
    telescope: { axis: "along the leg, toward the pivot", parts: { rc11_lg_stage: { closeMm: T.closeMid }, "rc11_lg_slider + fork + knuckle + foot": { closeMm: T.close } }, note: "step 1: close the telescope (landed axis is -Z)" },
    foot: { pivot: [sx * G.x, y, 110], pivotClosed: [sx * G.x, y, 110 + T.close], axis: [1, 0, 0], deployedDeg: 0, stowedDeg: 90, note: "step 3: after the leg turn, about the knuckle (pivotClosed is before the leg turn)" },
    sequence: ["close telescope", "leg -90 about pivot", "foot +90 about knuckle", "close doors"] })));
  const doors = [G.front, G.rear].flatMap((y) => [1, -1].flatMap((sx) => [
    { part: `door inner ${y > 0 ? "front" : "rear"} ${sx > 0 ? "+X" : "-X"}`, hinge: [sx * G.bayX0, y, BELLY], axis: [0, 1, 0], deployedDeg: sx * 90, stowedDeg: 0 },
    { part: `door outer ${y > 0 ? "front" : "rear"} ${sx > 0 ? "+X" : "-X"}`, hinge: [sx * G.bayX1, y, BELLY], axis: [0, 1, 0], deployedDeg: -sx * 90, stowedDeg: 0 }]));
  await writeFile(resolve("discovery/neorc11/gear_pivots.json"), JSON.stringify({ units: "millimetres, Z up, nose +Y", legs, doors, lift: { part: "rc11_hatch_platform (+ ribs, rail, edge lights)", travelAxis: [0, 0, 1], deployedBottomZ: 0, stowedBottomZ: BELLY, travelMm: BELLY, rams: { stages: 3, stageLengthMm: check.lift && (check.lift as any).stageLengthMm, extendedFromZ: L.housingBottom, housingZ: [L.housingBottom, L.housingTop], note: "stage k slides out of stage k-1; fully retracted they nest inside the housing" } }, retractCheck: check }, null, 1));
  // ---- tidy: dissolve empty duplicate groups left by reruns
  const empties = (((await call("plasticity_list_groups")).groups ?? []) as any[]).filter((g) => ["HATCH (centreline)", "SCALE REF (hide before export)"].includes(g.name) && !g.bodyIds.length && !g.instanceIds.length && !g.childGroupIds.length);
  if (empties.length) await call("plasticity_dissolve_groups", { ids: empties.map((g) => g.id), revision: await rev() });
  // ---- 8. validate
  const mine = (await bodies()).filter((b) => /^rc11_(lg|hatch|ref)_/.test(b.name ?? "") && b.type === "Solid");
  const hull = (await bodies()).find((b) => b.name === "rc11_hull");
  const v = await call("plasticity_validate_bodies", { ids: [hull.id, ...mine.map((b) => b.id)], revision: await rev() });
  say(`validate: ${(v.bodies ?? []).filter((x: any) => x.closed && x.nativeValid).length}/${(v.bodies ?? []).length} valid; below Z 0: ${mine.filter((b) => b.boundsMm.min[2] < -0.5).map((b) => b.name).join(", ") || "none"}`);
  say(`instances: ${JSON.stringify(counts)}; platform ribs 1 + 16`);
} finally {
  await writeFile(logPath, JSON.stringify({ done, notes }, null, 1));
  await s.close();
}
