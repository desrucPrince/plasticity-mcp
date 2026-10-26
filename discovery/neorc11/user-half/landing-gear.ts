// Retractable landing gear and a boarding hatch on the neoRC 11 belly, built on the live-mirrored V10+ document.
// Gear (landed pose): four legs at X ±1600, pivots at Y 4400 (front) and -3200 (rear), Z 1400. Each sits in a
// 700 x 1890 bay, 320 mm deep, with a dark ceiling liner and a chamfered lip. Parts: a trunnion with a pivot pin, a
// 200 mm strut, a chrome slider, a fork housing, a knuckle (Z 110), a 640 mm dished footpad 60 mm thick with a bolt ring (bottom at Z 0),
// a two-link side brace with a knee, a hydraulic actuator, and two bay doors hanging open 90°. One leg is the source;
// the rear leg is a translated instance, and every +X part has a mirrored instance (EDIT SIDE / MIRROR groups).
// Stowed: the leg turns -90° about X through its pivot (foot toward -Y) and the foot turns back flat about its knuckle.
// Hatch: a 1.3 x 2.2 m opening on the centreline under the cabin (Y 1700..3900), 300 mm deep, cut into the +X hull
// (the mirror follows), with a dark liner, a lip light strip and two hydraulic struts (+X with mirrors). The ramp,
// rails and treads are whole centreline parts in "HATCH (centreline)": the ramp is hinged at the front edge and lowered
// so its free end rests on Z 0 (34.4°), with 6 ribbed treads (a source plus instances) and side rails.
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

const BELLY = 1240;
const G = { x: 1600, bayX0: 1250, bayX1: 1950, depth: 320, pivotZ: 1400, front: 4400, rear: -3200, ahead: 150, behind: 1740, gap: 4 };
const CEIL = BELLY + G.depth;
const H = { x1: 650, y0: 1700, y1: 3900, depth: 300, thick: 40, gap: 4 };
const rampLen = H.y1 - H.y0 - 2 * H.gap;
const rampDeg = Math.asin(BELLY / rampLen) / D; // free end's lower edge on Z 0

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
    "hatch": [[0, H.y0, 0], [H.x1, H.y1, BELLY + H.depth]],
  };
  const others = (await bodies()).filter((b) => b.visible !== false && b.type !== "Wire" && b.name !== "rc11_hull" && !/^rc11_(lg|hatch)_/.test(b.name ?? ""));
  for (const [name, [lo, hi]] of Object.entries(zones)) {
    const hits = others.filter((b) => [0, 1, 2].every((i) => b.boundsMm.min[i] < hi[i]! && b.boundsMm.max[i] > lo[i]!));
    if (hits.length) throw new Error(`${name} collides with ${hits.map((b) => `${b.name}#${b.id}`).join(", ")}`);
  }
  say(`clear zones: gear bays X ${G.bayX0}..${G.bayX1} at Y ${G.front - G.behind}..${G.front + G.ahead} and ${G.rear - G.behind}..${G.rear + G.ahead}; hatch X ±${H.x1}, Y ${H.y0}..${H.y1}`);

  // ---- 1. reset earlier gear/hatch parts
  const old = (await bodies()).filter((b) => /^rc11_(lg|hatch)_/.test(b.name ?? ""));
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
    await cutHull([-20, H.y0, BELLY - 20], [H.x1 + 20, H.y1 - H.y0, H.depth + 20], "hatch opening");
    done.cuts = true;
  }

  // ---- 3. leg (front, +X source parts)
  const yp = G.front;
  const P: Vec = [G.x, yp, G.pivotZ];
  const legParts: number[] = [];
  const trunnion = await box([G.x - 110, yp - 130, G.pivotZ - 60], [220, 260, CEIL + 0.5 - (G.pivotZ - 60)], "rc11_lg_trunnion");
  say(`trunnion edges: ${await soften(trunnion, 10)}`);
  await unite(trunnion, [await rod([G.x - 135, yp, G.pivotZ], [G.x + 135, yp, G.pivotZ], 45, "rc11_lg_pin")]);
  const strut = await rod([G.x, yp, G.pivotZ - 40], [G.x, yp, 760], 100, "rc11_lg_strut");
  const slider = await rod([G.x, yp, 800], [G.x, yp, 300], 72, "rc11_lg_slider");
  const fork = await rod([G.x, yp, 340], [G.x, yp, 200], 88, "rc11_lg_fork");
  await unite(fork, [await rod([G.x, yp, 210], [G.x, yp, 59.5], 50, "rc11_lg_post")]);
  const knuckle = await rod([G.x - 110, yp, 110], [G.x + 110, yp, 110], 40, "rc11_lg_knuckle"); // low knuckle: the folded pad rides above the closed doors
  // dished footpad with a bolt ring, bottom exactly on Z 0
  const foot = (await raw("plasticity_batch", { steps: [{ toolName: "plasticity_create_cylinder", arguments: { centerMm: [G.x, yp, 0], radiusMm: 320, heightMm: 60, axis: [0, 0, 1], name: "rc11_lg_foot" } }] })).steps[0].added[0] as number;
  const fb = await body(foot);
  if (Math.abs(fb.boundsMm.min[2]) > 0.01) await raw("plasticity_move", { ids: [foot], deltaMm: [0, 0, -fb.boundsMm.min[2]], revision: await rev() });
  await call("plasticity_rename", { id: foot, name: "rc11_lg_foot", revision: await rev() });
  const dish = (await raw("plasticity_batch", { steps: [{ toolName: "plasticity_create_cylinder", arguments: { centerMm: [G.x, yp, 48], radiusMm: 240, heightMm: 20, axis: [0, 0, 1], name: "rc11_lg_dish" } }] })).steps[0].added[0] as number;
  const db = await body(dish);
  if (Math.abs(db.boundsMm.min[2] - 48) > 0.01) await raw("plasticity_move", { ids: [dish], deltaMm: [0, 0, 48 - db.boundsMm.min[2]], revision: await rev() });
  await raw("plasticity_boolean", { targetIds: [foot], toolIds: [dish], operation: "difference", revision: await rev() });
  const boltsOnFoot: number[] = [];
  for (let k = 0; k < 8; k++) { const a = (k * 45 + 22.5) * D; const c: Vec = [G.x + 282 * Math.cos(a), yp + 282 * Math.sin(a), 59.5]; boltsOnFoot.push(await rod(c, [c[0], c[1], 68], 11, "rc11_lg_footbolt")); }
  await unite(foot, boltsOnFoot);
  // two-link side brace with a knee joint, from the bay ceiling behind the trunnion to the strut
  const knee: Vec = [G.x, yp - 420, 1080];
  const upper = await rod([G.x, yp - 760, CEIL + 0.5], knee, 30, "rc11_lg_brace_upper");
  const lower = await rod(knee, [G.x, yp - 60, 920], 30, "rc11_lg_brace_lower");
  await unite(upper, [lower, await rod([G.x - 55, knee[1], knee[2]], [G.x + 55, knee[1], knee[2]], 42, "rc11_lg_knee")]);
  await call("plasticity_rename", { id: upper, name: "rc11_lg_brace", revision: await rev() });
  // hydraulic actuator beside the brace: cylinder body plus chrome rod
  const aTop: Vec = [G.x + 150, yp - 560, CEIL + 0.5], aBot: Vec = [G.x + 95, yp - 40, 1120];
  const aMid: Vec = [aTop[0] + (aBot[0] - aTop[0]) * 0.58, aTop[1] + (aBot[1] - aTop[1]) * 0.58, aTop[2] + (aBot[2] - aTop[2]) * 0.58];
  const actBody = await rod(aTop, aMid, 45, "rc11_lg_actuator");
  const actRod = await rod([aMid[0] - (aMid[0] - aTop[0]) * 0.05, aMid[1] - (aMid[1] - aTop[1]) * 0.05, aMid[2] - (aMid[2] - aTop[2]) * 0.05], aBot, 22, "rc11_lg_actuator_rod");
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
  await material([foot], "Footpad", "#1a1c1f", 0.7, 0.3);
  await material([dIn, dOut], "Eldorado midnight", "#0b1630", 0.3, 0.7);
  await material([liner], "Bay black", "#08090b", 0.75, 0.1);
  legParts.push(trunnion, strut, slider, fork, knuckle, foot, upper, actBody, actRod, dIn, dOut, liner);

  // ---- 4. retract check on temporary copies (deleted afterwards)
  const check: Record<string, unknown> = {};
  const moving = [strut, slider, fork, knuckle, foot];
  const before = new Set((await bodies()).map((b) => b.id));
  await call("plasticity_duplicate_bodies", { ids: moving, revision: await rev() });
  const temps = (await bodies()).filter((b) => !before.has(b.id));
  const tFoot = temps.find((b) => (b.name ?? "").startsWith("rc11_lg_foot"))!;
  await rotate(temps.map((b) => b.id), P, [1, 0, 0], -90);
  const kn = (await bodies()).find((b) => b.id === temps.find((t) => (t.name ?? "").startsWith("rc11_lg_knuckle"))!.id);
  const knC: Vec = [0, 1, 2].map((i) => (kn.boundsMm.min[i] + kn.boundsMm.max[i]) / 2) as Vec;
  await rotate([tFoot.id], knC, [1, 0, 0], 90);
  const stowed = (await bodies()).filter((b) => temps.some((t) => t.id === b.id));
  const lo = [0, 1, 2].map((i) => Math.min(...stowed.map((b) => b.boundsMm.min[i]))), hi = [0, 1, 2].map((i) => Math.max(...stowed.map((b) => b.boundsMm.max[i])));
  const clear = { xIn: lo[0]! - G.bayX0, xOut: G.bayX1 - hi[0]!, yFront: yp + G.ahead - hi[1]!, yRear: lo[1]! - (yp - G.behind), aboveClosedDoors: lo[2]! - (BELLY + 18), belowCeiling: CEIL - 10.5 - hi[2]! };
  check.leg = { stowedBoundsMm: [lo.map(Math.round), hi.map(Math.round)], clearanceMm: Object.fromEntries(Object.entries(clear).map(([k, v]) => [k, Math.round(v)])), fits: Object.values(clear).every((v) => v >= 20) };
  await raw("plasticity_delete", { ids: temps.map((b) => b.id), revision: await rev() });
  check.doors = { closedOuterFaceZ: BELLY, gapMm: G.gap, flush: true, note: "doors are built closed flush with the belly and swung 90° about their hinge lines" };
  say(`retract check: ${JSON.stringify(check.leg)}`);

  // ---- 5. place the leg: rear leg as translated instances, mirrors for both
  for (const id of legParts) await place(id, [[0, G.rear - G.front, 0]]);

  // ---- 6. hatch: liner, light strips and struts (+X with mirrors); ramp, treads, rails as centreline parts
  const hLiner = await box([0.5, H.y0 + 5, BELLY + H.depth - 10.5], [H.x1 - 5.5, H.y1 - H.y0 - 10, 10], "rc11_hatch_liner");
  await material([hLiner], "Bay black", "#08090b", 0.75, 0.1);
  const strip = await box([H.x1 - 4, H.y0 + 25, BELLY + 15], [5, H.y1 - H.y0 - 50, 12], "rc11_hatch_light");
  await material([strip], "Hatch light", "#5fe6ff", 0.1, 0);
  const hinge: Vec = [0, H.y1 - H.gap, BELLY];
  const ramp = await box([-(H.x1 - H.gap), H.y0 + H.gap, BELLY], [2 * (H.x1 - H.gap), rampLen, H.thick], "rc11_hatch_ramp");
  say(`ramp edges: ${await soften(ramp, 6)}`);
  const tread = await box([-540, H.y0 + H.gap + 220, BELLY + H.thick - 0.5], [1080, 90, 18.5], "rc11_hatch_tread");
  const ribs: number[] = [];
  for (const dy of [18, 41, 64]) ribs.push(await box([-540, H.y0 + H.gap + 220 + dy, BELLY + H.thick + 17.5], [1080, 8, 6.5], "rc11_hatch_rib"));
  await unite(tread, ribs);
  const rail = await box([590, H.y0 + H.gap + 40, BELLY + H.thick - 0.5], [40, rampLen - 80, 70.5], "rc11_hatch_rail");
  await soften(rail, 6);
  await material([ramp], "Eldorado midnight", "#0b1630", 0.3, 0.7);
  await material([tread], "Gunmetal", "#2b2f33", 0.35, 0.8);
  await material([rail], "Chrome", "#d9dde2", 0.08, 1);
  // lower the ramp group about the hinge so the free end rests on Z 0
  await rotate([ramp, tread, rail], hinge, [1, 0, 0], rampDeg);
  if ((await body(ramp)).boundsMm.min[2] > 100) await rotate([ramp, tread, rail], hinge, [1, 0, 0], -2 * rampDeg);
  const rb = await body(ramp);
  say(`ramp lowered ${rampDeg.toFixed(1)}°: Z ${r1(rb.boundsMm.min[2])}..${Math.round(rb.boundsMm.max[2])}, Y ${Math.round(rb.boundsMm.min[1])}..${Math.round(rb.boundsMm.max[1])}`);
  // Up-slope direction (free end toward the hinge) and the upper-face normal, read from the lowered ramp.
  const upLen = Math.hypot(hinge[1] - rb.boundsMm.min[1], hinge[2] - rb.boundsMm.min[2]);
  const up: Vec = [0, (hinge[1] - rb.boundsMm.min[1]) / upLen, (hinge[2] - rb.boundsMm.min[2]) / upLen];
  const nrm: Vec = [0, -up[2], up[1]];
  const treadIds: number[] = [];
  for (let k = 1; k < 6; k++) treadIds.push(await newest(async () => call("plasticity_create_instance", { bodyId: tread, translationMm: [0, r1(up[1] * 340 * k), r1(up[2] * 340 * k)], revision: await rev() })));
  // hydraulic struts (+X): from the well ceiling to the ramp's upper face 900 mm down the slope from the hinge
  const s0 = 900;
  const attach: Vec = [560, hinge[1] - s0 * up[1] + H.thick * nrm[1], hinge[2] - s0 * up[2] + H.thick * nrm[2]];
  const top: Vec = [560, H.y1 - 700, BELLY + H.depth - 10];
  const sm: Vec = [top[0], top[1] + (attach[1] - top[1]) * 0.55, top[2] + (attach[2] - top[2]) * 0.55];
  const strutBody = await rod(top, sm, 34, "rc11_hatch_strut");
  const strutRod = await rod([sm[0], sm[1] - (sm[1] - top[1]) * 0.05, sm[2] - (sm[2] - top[2]) * 0.05], attach, 17, "rc11_hatch_strut_rod");
  await material([strutBody], "Gunmetal", "#2b2f33", 0.35, 0.8);
  await material([strutRod], "Chrome", "#d9dde2", 0.08, 1);
  for (const id of [hLiner, strip, strutBody, strutRod]) await place(id, []);
  const railMirror = await newest(async () => call("plasticity_create_mirrored_instance", { bodyId: rail, axis: "x", planeOffsetMm: 0, revision: await rev() }));
  await call("plasticity_create_group", { bodyIds: [ramp, tread, rail], instanceIds: [...treadIds, railMirror], name: "HATCH (centreline)", revision: await rev() });
  check.ramp = { hinge, axis: [1, 0, 0], deployedDeg: r1(rampDeg), stowedDeg: 0, closedOuterFaceZ: BELLY, freeEndZ: r1(rb.boundsMm.min[2]), treadsAndRailsTopWhenClosedZ: BELLY + H.thick + 24, wellCeilingZ: BELLY + H.depth - 10.5, fits: BELLY + H.thick + 24 <= BELLY + H.depth - 10.5 - 20 };

  // ---- 7. pivots
  const legs = [G.front, G.rear].flatMap((y) => [1, -1].map((sx) => ({ part: `leg ${y > 0 ? "front" : "rear"} ${sx > 0 ? "+X" : "-X"}`, pivot: [sx * G.x, y, G.pivotZ], axis: [1, 0, 0], deployedDeg: 0, stowedDeg: -90,
    foot: { pivot: [sx * G.x, y, 110], axis: [1, 0, 0], deployedDeg: 0, stowedDeg: 90, note: "after the leg turn, about the knuckle" } })));
  const doors = [G.front, G.rear].flatMap((y) => [1, -1].flatMap((sx) => [
    { part: `door inner ${y > 0 ? "front" : "rear"} ${sx > 0 ? "+X" : "-X"}`, hinge: [sx * G.bayX0, y, BELLY], axis: [0, 1, 0], deployedDeg: sx * 90, stowedDeg: 0 },
    { part: `door outer ${y > 0 ? "front" : "rear"} ${sx > 0 ? "+X" : "-X"}`, hinge: [sx * G.bayX1, y, BELLY], axis: [0, 1, 0], deployedDeg: -sx * 90, stowedDeg: 0 }]));
  await writeFile(resolve("discovery/neorc11/gear_pivots.json"), JSON.stringify({ units: "millimetres, Z up, nose +Y", legs, doors, ramp: { part: "rc11_hatch_ramp (+ treads, rails)", hinge, axis: [1, 0, 0], deployedDeg: r1(rampDeg), stowedDeg: 0 }, retractCheck: check }, null, 1));
  // ---- 8. validate
  const mine = (await bodies()).filter((b) => /^rc11_(lg|hatch)_/.test(b.name ?? "") && b.type === "Solid");
  const hull = (await bodies()).find((b) => b.name === "rc11_hull");
  const v = await call("plasticity_validate_bodies", { ids: [hull.id, ...mine.map((b) => b.id)], revision: await rev() });
  say(`validate: ${(v.bodies ?? []).filter((x: any) => x.closed && x.nativeValid).length}/${(v.bodies ?? []).length} valid; below Z 0: ${mine.filter((b) => b.boundsMm.min[2] < -0.5).map((b) => b.name).join(", ") || "none"}`);
  say(`instances: ${JSON.stringify(counts)}; treads 1 + ${treadIds.length}; rail 1 + 1`);
  say(`ramp check: ${JSON.stringify(check.ramp)}`);
} finally {
  await writeFile(logPath, JSON.stringify({ done, notes }, null, 1));
  await s.close();
}
