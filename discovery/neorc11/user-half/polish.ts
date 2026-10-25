// High-level polish pass on the joined neoRC 11: conduits with flanged stubs and clamp brackets, fastener rows,
// service hatches with latches, tie-down points, roof sensor pucks, pod-corner marker lights. Every detail is one
// +X source body named rc11_p_* with linked instances for its repeats and a mirrored instance per placement, so it
// stays editable. Hatch seams are cut into the hull on both sides. Rerunning a stage deletes that stage's rc11_p_*
// bodies and their instances first. Reads the full body list (bodyLimit 200) before any delete.
// Usage: PLASTICITY_CDP_URL=http://127.0.0.1:9223 node discovery/neorc11/user-half/polish.ts [stage ...]
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openSession } from "../../mcp-client.ts";

type Vec = [number, number, number];
type Box = { min: Vec; max: Vec };
type Body = { id: number; name: string | null; type: string; boundsMm: Box; visible?: boolean };
type Edge = { id: string; boundsMm: Box; lengthMm: number; faceIds: string[] };
type Step = { toolName: string; arguments?: Record<string, unknown> };

const outDir = resolve("discovery/neorc11/user-half");
const stages = process.argv.slice(2);
const s = await openSession();
const raw = (name: string, args: Record<string, unknown> = {}) => s.raw(name, args);
const call = (toolName: string, args: Record<string, unknown> = {}) => raw("plasticity_call", { toolName, arguments: args });
const batch = (steps: Step[]) => raw("plasticity_batch", { steps, undoOnError: true });
const status = () => raw("plasticity_status", { bodyLimit: 200 });
const rev = async () => (await status()).revision as string;
const step = (toolName: string, args: Record<string, unknown> = {}): Step => ({ toolName, arguments: args });
const bodies = async (): Promise<Body[]> => {
  const st = await status();
  if (st.bodyPagination?.nextOffset != null) throw new Error(`more than 200 bodies (${st.bodyCount}); paginate`);
  return st.bodies;
};
const fmt = (b: Body) => `${b.name}#${b.id} [${b.boundsMm.min.map(Math.round)}]..[${b.boundsMm.max.map(Math.round)}]`;
const edgesOf = async (id: number) => ((await raw("plasticity_body_info", { id })).body.edges ?? []) as Edge[];
const instances = async () => ((await call("plasticity_list_instances")).instances ?? []) as Array<{ id: number; sourceBodyIds: number[] }>;
const D = Math.PI / 180;

const logPath = resolve(outDir, "polish-log.json");
const log: Record<string, { ok: boolean; ms: number; notes: string[] }> = existsSync(logPath) ? JSON.parse(await readFile(logPath, "utf8")) : {};
const counts: Record<string, { sources: number; instances: number }> = (log.__counts as any) ?? {};
async function stage(name: string, run: (notes: string[]) => Promise<void>) {
  if (stages.length && !stages.includes(name)) return;
  const t = performance.now();
  const notes: string[] = [];
  let ok = true;
  try { await run(notes); } catch (error) { ok = false; notes.push(`FAILED: ${String(error).slice(0, 1200)}`); }
  log[name] = { ok, ms: Math.round(performance.now() - t), notes };
  (log as any).__counts = counts;
  console.log(ok ? "OK  " : "FAIL", name, Math.round(performance.now() - t), "ms\n   " + notes.join("\n   "));
  await writeFile(logPath, JSON.stringify(log, null, 1));
  if (!ok) { await s.close(); process.exit(1); }
}
async function rename(id: number, name: string) { await call("plasticity_rename", { id, name, revision: await rev() }); }
async function hide(ids: number[]) { if (ids.length) await call("plasticity_set_visibility", { bodyIds: ids, visible: false, revision: await rev() }); }
const material = async (ids: number[], name: string, colorHex: string, roughness: number, metalness: number) =>
  await call("plasticity_set_appearance_material", { ids, name, colorHex, roughness, metalness, opacity: 1, revision: await rev() });
async function clear(prefix: string) {
  const mine = (await bodies()).filter((b) => (b.name ?? "").startsWith(prefix));
  if (!mine.length) return;
  const ids = new Set(mine.map((b) => b.id));
  const inst = (await instances()).filter((i) => i.sourceBodyIds.some((x) => ids.has(x))).map((i) => i.id);
  if (inst.length) await call("plasticity_delete_instances", { ids: inst, revision: await rev() });
  await raw("plasticity_delete", { ids: [...ids], revision: await rev() });
}
async function newest(make: () => Promise<unknown>) {
  const before = new Set((await instances()).map((i) => i.id));
  await make();
  return (await instances()).find((i) => !before.has(i.id))!.id;
}
// Linked instance per translation, plus a mirrored instance (X = 0) for the source and each translation.
async function place(label: string, sourceId: number, ts: Vec[]) {
  let n = 0;
  for (const t of ts) { await newest(async () => call("plasticity_create_instance", { bodyId: sourceId, translationMm: t, revision: await rev() })); n++; }
  for (const t of [[0, 0, 0] as Vec, ...ts]) {
    const id = await newest(async () => call("plasticity_create_mirrored_instance", { bodyId: sourceId, axis: "x", planeOffsetMm: 0, revision: await rev() }));
    if (t.some((v) => v !== 0)) await call("plasticity_move_instances", { ids: [id], deltaMm: [-t[0], t[1], t[2]], revision: await rev() });
    n++;
  }
  counts[label] = { sources: (counts[label]?.sources ?? 0) + 1, instances: (counts[label]?.instances ?? 0) + n };
  return n;
}
// Cylinder whose base centre is `base` and which extends `h` along unit axis `ax`.
async function cylinder(base: Vec, r: number, h: number, ax: Vec, name: string): Promise<number> {
  const out = await batch([step("plasticity_create_cylinder", { centerMm: base, radiusMm: r, heightMm: h, axis: ax, name })]);
  const id = out.steps[0].added[0] as number;
  const b = (await bodies()).find((x) => x.id === id)!;
  const centre = [0, 1, 2].map((i) => (b.boundsMm.min[i]! + b.boundsMm.max[i]!) / 2);
  const want = [0, 1, 2].map((i) => base[i]! + ax[i]! * h / 2);
  const d = want.map((v, i) => v - centre[i]!) as Vec;
  if (d.some((v) => Math.abs(v) > 0.01)) await raw("plasticity_move", { ids: [id], deltaMm: d, revision: await rev() });
  await rename(id, name);
  return id;
}
// Round one end edge of a cylinder (the circle farthest along the axis) with a small fillet.
async function roundTop(id: number, ax: Vec, r: number) {
  const edges = await edgesOf(id);
  const key = (e: Edge) => [0, 1, 2].reduce((sum, i) => sum + ax[i]! * (e.boundsMm.min[i]! + e.boundsMm.max[i]!) / 2, 0);
  const top = edges.reduce((a, b) => (key(b) > key(a) ? b : a));
  try { await raw("plasticity_fillet", { id, edgeIds: [top.id], radiusMm: r, shape: "round", revision: await rev() }); return true; } catch { return false; }
}
async function smallChamfer(id: number, d: number) {
  try { await raw("plasticity_chamfer", { id, edgeIds: (await edgesOf(id)).map((e) => e.id), distanceMm: d, revision: await rev() }); return true; } catch { return false; }
}
const rangeStep = (a: number, b: number, pitch: number) => { const n = Math.floor((b - a) / pitch + 1e-6); const off = (b - a - n * pitch) / 2; return Array.from({ length: n + 1 }, (_, k) => a + off + k * pitch); };

const POD_X = 3657; // pod's flat outer face
const BELLY = 1240;

// ---- fasteners: one round cap-screw source per orientation (the style excludes hexagons, so heads are round with a
// crisp rounded top), arrayed at 225 mm pitch along the louvre recess frame, fin roots, drive bay lip, exhaust frame
// and hover pads; small rivet rows along the hood and deck panel-line grooves.
await stage("fasteners", async (notes) => {
  await clear("rc11_p_bolt"); await clear("rc11_p_rivet");
  const H = 9, R = 15;
  const make = async (name: string, base: Vec, ax: Vec, r = R, h = H) => {
    const id = await cylinder(base, r, h, ax, name);
    notes.push(`${name}: top round ${(await roundTop(id, ax, Math.min(3, h / 3))) ? "ok" : "refused"}`);
    await material([id], "Fastener", "#8e959c", 0.25, 1);
    return id;
  };
  // Pod side (+X axis): louvre recess frame (recess Y 900..4300, Z 2330..2700) and the fin root row.
  const side = await make("rc11_p_bolt_side", [POD_X - 2, 900, 2290], [1, 0, 0]);
  const sideTs: Vec[] = [];
  for (const y of rangeStep(900, 4300, 225)) for (const z of [2290, 2740]) sideTs.push([0, y - 900, z - 2290]);
  for (const y of [860, 4340]) for (const z of rangeStep(2400, 2630, 115)) sideTs.push([0, y - 900, z - 2290]);
  for (const y of rangeStep(-5100, -1300, 225)) sideTs.push([0, y - 900, 2650 - 2290]); // above the fin root blend
  notes.push(`side bolts: instances ${await place("bolts (pod side)", side, sideTs.filter((t) => t.some((v) => v !== 0)))}`);
  // Belly (-Z axis): drive bay lip (stadium radius 990 about the centreline, straight run Y -1600..600) and hover
  // pad corners (pads X 2300..2880, Y c±700, bottom Z 1205).
  const belly = await make("rc11_p_bolt_belly", [990, -1600, BELLY + 2], [0, 0, -1]);
  const bellyTs: Vec[] = [];
  for (const y of rangeStep(-1600, 600, 225)) bellyTs.push([0, y + 1600, 0]);
  for (const [yc, sign] of [[600, 1], [-1600, -1]] as Array<[number, number]>) for (const a of [18, 36, 54, 72, 90]) {
    const x = 990 * Math.cos(a * D), y = yc + sign * 990 * Math.sin(a * D);
    if (x > 20) bellyTs.push([x - 990, y + 1600, 0]);
  }
  for (const yc of [-5000, -2500, 0, 2500, 4800]) for (const x of [2345, 2835]) for (const dy of [-650, 650]) bellyTs.push([x - 990, yc + dy + 1600, 1205 - (BELLY + 2) + 2]);
  notes.push(`belly bolts: instances ${await place("bolts (belly: drive lip, hover pads)", belly, bellyTs.filter((t) => t.some((v) => v !== 0)))}`);
  // Exhaust frame rear face (-Y axis): frame Y -6900, X 0..1150, Z 1300..1720; recess X 0..1080, Z 1360..1660.
  const rear = await make("rc11_p_bolt_rear", [150, -6900 + 2, 1345], [0, -1, 0], 12, 7);
  const rearTs: Vec[] = [];
  for (const x of rangeStep(150, 1000, 212)) for (const z of [1345, 1675]) rearTs.push([x - 150, 0, z - 1345]);
  for (const z of [1440, 1580]) rearTs.push([1100 - 150, 0, z - 1345]); // flat bands of the frame, clear of its 30 mm chamfer
  notes.push(`exhaust bolts: instances ${await place("bolts (exhaust frame)", rear, rearTs.filter((t) => t.some((v) => v !== 0)))}`);
  // Rivets (+Z axis) beside the deck grooves at Y 5450 and -3520 (hull top Z 3100), skipping the buttress.
  const rivet = await make("rc11_p_rivet", [120, 5450 + 30, 3100 - 1], [0, 0, 1], 7, 4);
  const rivetTs: Vec[] = [];
  for (const x of rangeStep(120, 2560, 200)) for (const y of [5450 + 30, 5450 - 30]) rivetTs.push([x - 120, y - 5480, 0]);
  for (const x of rangeStep(120, 2560, 200).filter((x) => x < 1950 || x > 2320)) for (const y of [-3520 + 30, -3520 - 30]) rivetTs.push([x - 120, y - 5480, 0]);
  notes.push(`rivets: instances ${await place("rivets (panel seams)", rivet, rivetTs.filter((t) => t.some((v) => v !== 0)))}`);
});

// ---- conduits: two rigid lines per side along the pod's lower 45° face, and two along the belly from the drive
// bay to the exhaust; flanged stubs where they enter the skin, clamp brackets about every metre.
await stage("conduits", async (notes) => {
  await clear("rc11_p_conduit"); await clear("rc11_p_flange"); await clear("rc11_p_clamp");
  const n = [Math.SQRT1_2, 0, -Math.SQRT1_2] as Vec; // pod lower-face normal
  const onFace = (x: number, y: number, off: number): Vec => [x + n[0] * off, y, x - 1660 + n[2] * off];
  const conduits: number[] = [];
  const makeConduit = async (pts: Vec[], name: string, dia: number) => {
    const out = await batch([step("plasticity_create_control_point_curve", { pointsMm: pts }), step("plasticity_create_pipes", { spineIds: ["$0.added[0]"], diameterMm: dia })]);
    await rename(out.steps[0].added[0], `${name}_spine`);
    await hide([out.steps[0].added[0]]);
    const pipe = out.steps[1].added[0] as number;
    await rename(pipe, name);
    await material([pipe], "Conduit", "#2e3338", 0.3, 0.9);
    conduits.push(pipe);
    return pipe;
  };
  // Pod conduits at X 3100 and 3300 on the 45° face, 45 mm off the surface, dipping into the skin at both ends.
  for (const [i, x] of [3100, 3300].entries()) {
    const ys = [-5900, -5600, -5300, 4700, 5000, 5300];
    const offs = [-30, 45, 45, 45, 45, -30];
    await makeConduit(ys.map((y, k) => onFace(x, y, offs[k]!)), `rc11_p_conduit_pod_${i}`, 56);
  }
  // Belly conduits at X 450 and 650: from inside the hull aft of the drive bay down 40 mm, aft, and up into the
  // exhaust frame.
  for (const [i, x] of [450, 650].entries()) {
    const pts: Vec[] = [[x, -2560, BELLY + 30], [x, -2760, BELLY - 40], [x, -3000, BELLY - 40], [x, -6100, BELLY - 40], [x, -6350, BELLY - 40], [x, -6560, 1330]];
    await makeConduit(pts, `rc11_p_conduit_belly_${i}`, 50);
  }
  for (const c of conduits) await place("conduits", c, []);
  // Flanged stubs: a 20 mm collar where each line meets the skin.
  const podFlange = await cylinder(onFace(3100, -5600, -8), 46, 20, n, "rc11_p_flange_pod");
  await roundTop(podFlange, n, 4);
  const podFlangeTs: Vec[] = [];
  for (const x of [3100, 3300]) for (const y of [-5600, 5000]) { const p = onFace(x, y, -8), o = onFace(3100, -5600, -8); podFlangeTs.push([p[0] - o[0], p[1] - o[1], p[2] - o[2]]); }
  const bellyFlange = await cylinder([450, -2720, BELLY + 2], 42, 18, [0, 0, -1], "rc11_p_flange_belly");
  await roundTop(bellyFlange, [0, 0, -1], 4);
  await material([podFlange, bellyFlange], "Fastener", "#8e959c", 0.25, 1);
  notes.push(`pod flanges: ${await place("flanged stubs", podFlange, podFlangeTs.filter((t) => t.some((v) => v !== 0)))}; belly flanges: ${await place("flanged stubs", bellyFlange, [[200, 0, 0]])}`);
  // Clamp brackets: a strap over the pipe, chamfered 3 mm.
  const podClamp = (await batch([step("plasticity_create_box", { originMm: [3100 - 55, -4600 - 18, 1440 - 10], sizeMm: [110, 36, 100], name: "rc11_p_clamp_pod" })])).steps[0].added[0] as number;
  await raw("plasticity_rotate", { ids: [podClamp], pivotMm: [3100, -4600, 1440], axis: [0, 1, 0], degrees: -45, revision: await rev() });
  const bellyClamp = (await batch([step("plasticity_create_box", { originMm: [450 - 50, -3400 - 16, BELLY - 72], sizeMm: [100, 32, 76], name: "rc11_p_clamp_belly" })])).steps[0].added[0] as number;
  for (const c of [podClamp, bellyClamp]) notes.push(`clamp chamfer 3: ${(await smallChamfer(c, 3)) ? "ok" : "refused"}`);
  await material([podClamp, bellyClamp], "Gunmetal", "#2b2f33", 0.35, 0.8);
  const podClampTs: Vec[] = [];
  for (const x of [0, 200]) for (const y of rangeStep(-4600, 3600, 1025)) if (x || y !== -4600) podClampTs.push([x, y + 4600, x]);
  const bellyClampTs: Vec[] = [];
  for (const x of [0, 200]) for (const y of rangeStep(-5800, -3400, 800)) if (x || y !== -3400) bellyClampTs.push([x, y + 3400, 0]);
  notes.push(`pod clamps: ${await place("clamp brackets", podClamp, podClampTs)}; belly clamps: ${await place("clamp brackets", bellyClamp, bellyClampTs)}`);
});

// ---- service hatches: 6 mm seams cut into the hull (both sides) on the pod outer face and the rear deck, with a
// flush latch plate on each.
await stage("hatches", async (notes) => {
  await clear("rc11_p_latch");
  const hull = (await bodies()).find((b) => b.name === "rc11_hull")!;
  const hatches: Array<{ o: Vec; size: Vec; inner: Vec; innerSize: Vec; label: string }> = [];
  // Pod side hatch, Y 4600..5400, Z 2330..2700 (forward of the louvres): a seam frame 8 wide, 6 deep.
  hatches.push({ label: "pod side", o: [POD_X - 6, 4600, 2330], size: [20, 800, 370], inner: [POD_X - 10, 4608, 2338], innerSize: [30, 784, 354] });
  // Hood hatch (the rear deck is taken by the strakes and the cabin blend): X 700..1700, Y 5560..6100.
  hatches.push({ label: "hood", o: [700, 5560, 3100 - 6], size: [1000, 540, 20], inner: [708, 5568, 3100 - 10], innerSize: [984, 524, 30] });
  for (const h of hatches) {
    const out = await batch([
      step("plasticity_create_box", { originMm: h.o, sizeMm: h.size, name: "rc11_p_hatch_cutter" }),
      step("plasticity_create_box", { originMm: h.inner, sizeMm: h.innerSize, name: "rc11_p_hatch_inner" }),
      step("plasticity_boolean", { targetIds: ["$0.addedSolids[0]"], toolIds: ["$1.addedSolids[0]"], operation: "difference" }),
    ]);
    const frame = out.steps[0].added[0] as number;
    const pre = new Set((await bodies()).map((b) => b.id));
    await raw("plasticity_mirror", { ids: [frame], planeOriginMm: [0, 0, 0], planeNormal: [1, 0, 0], keepOriginal: true, revision: await rev() });
    const twin = (await bodies()).find((b) => !pre.has(b.id));
    try {
      await raw("plasticity_boolean", { targetIds: [hull.id], toolIds: [frame, ...(twin ? [twin.id] : [])], operation: "difference", revision: await rev() });
      notes.push(`${h.label} hatch seam cut (both sides)`);
    } catch (error) { notes.push(`${h.label} hatch refused: ${String(error).slice(0, 160)}`); await raw("plasticity_delete", { ids: [frame, ...(twin ? [twin.id] : [])], revision: await rev() }); }
  }
  // Flush latch plates (1.5 mm proud), one per hatch, mirrored.
  const podLatch = (await batch([step("plasticity_create_box", { originMm: [POD_X - 1, 5300, 2490], sizeMm: [2.5, 70, 22], name: "rc11_p_latch_side" })])).steps[0].added[0] as number;
  const hoodLatch = (await batch([step("plasticity_create_box", { originMm: [1165, 6010, 3100 - 1], sizeMm: [70, 22, 2.5], name: "rc11_p_latch_top" })])).steps[0].added[0] as number;
  await material([podLatch, hoodLatch], "Chrome", "#d9dde2", 0.08, 1);
  notes.push(`latches: ${await place("hatch latches", podLatch, [])} + ${await place("hatch latches", hoodLatch, [])}`);
});

// ---- small functional bits: tie-down rings on the pod sides, flat sensor pucks on the roof, marker lights at the
// pod corners (amber front, red rear).
await stage("bits", async (notes) => {
  await clear("rc11_p_tiedown"); await clear("rc11_p_puck"); await clear("rc11_p_marker");
  const ring = await cylinder([POD_X - 2, -6200, 2220], 38, 14, [1, 0, 0], "rc11_p_tiedown");
  const hole = await cylinder([POD_X - 10, -6200, 2220], 20, 40, [1, 0, 0], "rc11_p_tiedown_hole");
  await raw("plasticity_boolean", { targetIds: [ring], toolIds: [hole], operation: "difference", revision: await rev() });
  notes.push(`tie-down round: ${(await roundTop(ring, [1, 0, 0], 3)) ? "ok" : "refused"}`);
  await material([ring], "Fastener", "#8e959c", 0.25, 1);
  notes.push(`tie-downs: ${await place("tie-down points", ring, [[0, 12600, 0]])}`);
  const puck = await cylinder([800, 1800, 4476], 70, 14, [0, 0, 1], "rc11_p_puck"); // flat roof panel Y 1516..2537
  notes.push(`puck round: ${(await roundTop(puck, [0, 0, 1], 5)) ? "ok" : "refused"}`);
  await material([puck], "Sensor glass", "#0b0d10", 0.05, 0.4);
  notes.push(`pucks: ${await place("roof sensor pucks", puck, [[0, 500, 0]])}`);
  const front = (await batch([step("plasticity_create_box", { originMm: [POD_X - 4, 6700, 2760], sizeMm: [10, 120, 50], name: "rc11_p_marker_front" })])).steps[0].added[0] as number;
  const rearM = (await batch([step("plasticity_create_box", { originMm: [POD_X - 4, -7240, 2760], sizeMm: [10, 120, 50], name: "rc11_p_marker_rear" })])).steps[0].added[0] as number;
  await material([front], "Marker amber", "#ffab2e", 0.15, 0);
  await material([rearM], "Tail light", "#ff2a2a", 0.15, 0);
  notes.push(`markers: ${await place("marker lights", front, [])} + ${await place("marker lights", rearM, [])}`);
});

// ---- validate everything visible
await stage("validate", async (notes) => {
  const all = (await bodies()).filter((b) => b.visible !== false && b.type === "Solid" && (b.name ?? "").startsWith("rc11_"));
  const v = await call("plasticity_validate_bodies", { ids: all.map((b) => b.id), revision: await rev() });
  const rows = (v.bodies ?? []) as Array<{ id: number; name: string; closed: boolean; nativeValid: boolean }>;
  const bad = rows.filter((x) => !x.closed || !x.nativeValid);
  notes.push(`solids ${rows.length}, valid ${rows.length - bad.length}${bad.length ? `, invalid: ${bad.map((b) => `${b.name}#${b.id}`).join(", ")}` : ""}`);
  notes.push(`instances in document: ${(await instances()).length}`);
  notes.push(`counts: ${JSON.stringify(counts)}`);
});

await s.close();
