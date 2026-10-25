// Rear-deck gyro for the neoRC 11 (V5). The flat deck behind the cabin is only 1.35 m deep and the inner deck
// strakes sit 0.93 m apart, so: the strakes inside |X| < 900 are cut back to the deck, a low drum housing (R 880,
// 60 mm proud of the deck) is unioned onto the deck centreline at Y -4250 to give a level rim where the deck starts
// to slope, and a 1.52 m well is sunk 300 mm into it. On top: two trunnion mounts on the X axis, a bolt ring, and
// the gimbal as separate named bodies (outer gimbal on X, inner gimbal on the outer's tilted Y, rotor on the inner's
// Z) with fillet/chamfer edges. Pivots go to discovery/neorc11/gyro_pivots.json.
// Usage: PLASTICITY_CDP_URL=http://127.0.0.1:9223 node discovery/neorc11/user-half/gyro.ts
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openSession } from "../../mcp-client.ts";

type Vec = [number, number, number];
type Body = { id: number; name: string | null; type: string; boundsMm: { min: Vec; max: Vec }; visible?: boolean };
type Edge = { id: string; boundsMm: { min: Vec; max: Vec }; lengthMm: number };
type Face = { id: string; planar: boolean; normal: Vec; boundsMm: { min: Vec; max: Vec } };
const s = await openSession();
const raw = (n: string, a: Record<string, unknown> = {}) => s.raw(n, a);
const call = (t: string, a: Record<string, unknown> = {}) => raw("plasticity_call", { toolName: t, arguments: a });
const status = () => raw("plasticity_status", { bodyLimit: 200 });
const rev = async () => (await status()).revision as string;
async function bodies(): Promise<Body[]> {
  const first = await status();
  const all = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) {
    const p = await raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision });
    all.push(...p.bodies); n = p.bodyPagination?.nextOffset;
  }
  return all;
}
const info = async (id: number) => (await raw("plasticity_body_info", { id })).body as { edges: Edge[]; faces: Face[] };
const byName = async (n: string) => (await bodies()).find((b) => b.name === n)!;
const rename = async (id: number, name: string) => call("plasticity_rename", { id, name, revision: await rev() });
const material = async (ids: number[], name: string, colorHex: string, roughness: number, metalness: number) =>
  call("plasticity_set_appearance_material", { ids, name, colorHex, roughness, metalness, opacity: 1, revision: await rev() });
const notes: string[] = [];
const say = (...x: unknown[]) => { const t = x.map(String).join(" "); notes.push(t); console.log(t); };
const D = Math.PI / 180;

const C: Vec = [0, -4250, 3280];          // gyro centre (all gimbals share it)
const DECK = 3100, DRUM_TOP = 3160, DRUM_R = 880, WELL_R = 760, WELL_FLOOR = 2860;
const OUTER_TILT = 18, INNER_TILT = 22;   // degrees: outer about X, inner about the outer's local Y

async function cylinder(base: Vec, r: number, h: number, ax: Vec, name: string): Promise<number> {
  const out = await raw("plasticity_batch", { undoOnError: true, steps: [{ toolName: "plasticity_create_cylinder", arguments: { centerMm: base, radiusMm: r, heightMm: h, axis: ax, name } }] });
  const id = out.steps[0].added[0] as number;
  const b = (await bodies()).find((x) => x.id === id)!;
  const want = [0, 1, 2].map((i) => base[i]! + ax[i]! * h / 2);
  const d = [0, 1, 2].map((i) => want[i]! - (b.boundsMm.min[i]! + b.boundsMm.max[i]!) / 2) as Vec;
  if (d.some((v) => Math.abs(v) > 0.01)) await raw("plasticity_move", { ids: [id], deltaMm: d, revision: await rev() });
  await rename(id, name);
  return id;
}
// Flat ring (annulus) of radial width ro-ri and axial thickness t, centred on C, axis Z.
async function ring(ri: number, ro: number, t: number, name: string) {
  const outer = await cylinder([C[0], C[1], C[2] - t / 2], ro, t, [0, 0, 1], name);
  const inner = await cylinder([C[0], C[1], C[2] - t / 2 - 5], ri, t + 10, [0, 0, 1], `${name}_cut`);
  await raw("plasticity_boolean", { targetIds: [outer], toolIds: [inner], operation: "difference", revision: await rev() });
  return outer;
}
async function roundAll(id: number, r: number, label: string) {
  try { await raw("plasticity_fillet", { id, edgeIds: (await info(id)).edges.map((e) => e.id), radiusMm: r, shape: "round", revision: await rev() }); say(`${label}: edges r${r}`); }
  catch { try { await raw("plasticity_chamfer", { id, edgeIds: (await info(id)).edges.map((e) => e.id), distanceMm: r * 0.6, revision: await rev() }); say(`${label}: fillet refused, chamfer ${r * 0.6}`); } catch { say(`${label}: edge polish refused`); } }
}
const rot = async (ids: number[], axis: Vec, deg: number) => raw("plasticity_rotate", { ids, pivotMm: C, axis, degrees: deg, revision: await rev() });
const outerY: Vec = [0, Math.cos(OUTER_TILT * D), Math.sin(OUTER_TILT * D)]; // outer's local Y after its X tilt

try {
  const hull = await byName("rc11_hull");
  // ---- 1. clear the centre strakes and the rivets the drum will cover
  try {
    await raw("plasticity_batch", { undoOnError: true, steps: [
      { toolName: "plasticity_create_box", arguments: { originMm: [-900, -4820, DECK], sizeMm: [1800, 1190, 150], name: "rc11_g_strake_cutter" } },
      { toolName: "plasticity_boolean", arguments: { targetIds: [hull.id], toolIds: ["$0.addedSolids[0]"], operation: "difference" } }] });
    say("centre strakes (|X| < 900) cut back to the deck");
  } catch (error) { say(`strake cut refused: ${String(error).slice(0, 160)}`); }
  const buried = (await bodies()).filter((b) => (b.name ?? "").startsWith("rc11_p_rivet") && Math.hypot((b.boundsMm.min[0] + b.boundsMm.max[0]) / 2 - C[0], (b.boundsMm.min[1] + b.boundsMm.max[1]) / 2 - C[1]) < DRUM_R + 20);
  if (buried.length) await raw("plasticity_delete", { ids: buried.map((b) => b.id), revision: await rev() });
  say(`rivets removed under the drum: ${buried.length}`);

  // ---- 2. drum housing and well
  const drum = await cylinder([C[0], C[1], 2950], DRUM_R, DRUM_TOP - 2950, [0, 0, 1], "rc11_g_drum");
  const top = (await info(drum)).edges.filter((e) => e.boundsMm.min[2] > DRUM_TOP - 1).map((e) => e.id);
  try { await raw("plasticity_chamfer", { id: drum, edgeIds: top, distanceMm: 15, revision: await rev() }); say("drum top edge chamfer 15"); } catch { say("drum chamfer refused"); }
  await raw("plasticity_boolean", { targetIds: [hull.id], toolIds: [drum], operation: "union", revision: await rev() });
  const well = await cylinder([C[0], C[1], WELL_FLOOR], WELL_R, DRUM_TOP + 50 - WELL_FLOOR, [0, 0, 1], "rc11_g_well_cutter");
  const pre = new Set((await info(hull.id)).edges.map((e) => e.id));
  await raw("plasticity_boolean", { targetIds: [hull.id], toolIds: [well], operation: "difference", revision: await rev() });
  const lip = (await info(hull.id)).edges.filter((e) => !pre.has(e.id) && e.boundsMm.min[2] > DRUM_TOP - 20 && e.lengthMm > 1000).map((e) => e.id);
  try { await raw("plasticity_chamfer", { id: hull.id, edgeIds: lip, distanceMm: 10, revision: await rev() }); say(`well lip chamfer 10 (${lip.length} edges)`); } catch { say("well lip chamfer refused"); }
  say(`drum R${DRUM_R} top Z ${DRUM_TOP} (${DRUM_TOP - DECK} mm proud), well R${WELL_R}, depth ${DRUM_TOP - WELL_FLOOR}`);

  // ---- 3. trunnions (mirrored instance) with outer-gimbal pivot pins along X
  const trunnion = (await raw("plasticity_batch", { undoOnError: true, steps: [{ toolName: "plasticity_create_box", arguments: { originMm: [770, C[1] - 100, DRUM_TOP - 5], sizeMm: [100, 200, C[2] + 70 - DRUM_TOP + 5], name: "rc11_Gyro_Trunnion" } }] })).steps[0].added[0] as number;
  await roundAll(trunnion, 10, "trunnion");
  const pin = await cylinder([696, C[1], C[2]], 26, 90, [1, 0, 0], "rc11_Gyro_Trunnion_pin");
  await raw("plasticity_boolean", { targetIds: [trunnion], toolIds: [pin], operation: "union", revision: await rev() });
  await material([trunnion], "Gunmetal", "#2b2f33", 0.35, 0.8);
  await call("plasticity_create_mirrored_instance", { bodyId: trunnion, axis: "x", planeOffsetMm: 0, revision: await rev() });

  // ---- 4. bolt ring on the drum top (rotation instances about the gyro's vertical axis, skipping the trunnions)
  const bolt = await cylinder([820 * Math.cos(11.25 * D), C[1] + 820 * Math.sin(11.25 * D), DRUM_TOP - 2], 15, 11, [0, 0, 1], "rc11_Gyro_Bolt");
  await roundAll(bolt, 3, "drum bolt");
  await material([bolt], "Fastener", "#8e959c", 0.25, 1);
  let bolts = 0;
  for (let k = 1; k < 16; k++) {
    const before = new Set(((await call("plasticity_list_instances")).instances ?? []).map((i: { id: number }) => i.id));
    await call("plasticity_create_instance", { bodyId: bolt, translationMm: [0, 0, 0], revision: await rev() });
    const id = ((await call("plasticity_list_instances")).instances ?? []).find((i: { id: number }) => !before.has(i.id)).id;
    await call("plasticity_rotate_instances", { ids: [id], pivotMm: [C[0], C[1], 0], axis: [0, 0, 1], degrees: 22.5 * k, revision: await rev() });
    bolts++;
  }
  say(`drum bolt ring: 1 + ${bolts} instances at R820`);

  // ---- 5. gimbals and rotor, built flat on C then tilted
  const outer = await ring(640, 700, 60, "rc11_Gyro_OuterGimbal");
  // inner-gimbal pivot pins on the outer ring, along its (pre-tilt) Y axis; they tilt with it
  const pinA = await cylinder([C[0], C[1] + 580, C[2]], 20, 70, [0, 1, 0], "rc11_g_pin_a");
  const pinB = await cylinder([C[0], C[1] - 580, C[2]], 20, 70, [0, -1, 0], "rc11_g_pin_b");
  await raw("plasticity_boolean", { targetIds: [outer], toolIds: [pinA, pinB], operation: "union", revision: await rev() });
  const inner = await ring(535, 590, 50, "rc11_Gyro_InnerGimbal");
  const rotor = await ring(400, 450, 70, "rc11_Gyro_Rotor");
  const rim = await ring(450, 457, 12, "rc11_Gyro_RimLight");
  const core = await cylinder([C[0], C[1], C[2] - 45], 110, 90, [0, 0, 1], "rc11_Gyro_Core");
  const spoke = (await raw("plasticity_batch", { undoOnError: true, steps: [{ toolName: "plasticity_create_box", arguments: { originMm: [C[0] + 105, C[1] - 20, C[2] - 15], sizeMm: [300, 40, 30], name: "rc11_Gyro_Spoke" } }] })).steps[0].added[0] as number;
  for (const [id, r, label] of [[outer, 8, "outer gimbal"], [inner, 6, "inner gimbal"], [rotor, 10, "rotor rim"], [core, 8, "core hub"], [spoke, 4, "spoke"]] as Array<[number, number, string]>) await roundAll(id, r, label);
  await material([outer, inner], "Chrome", "#d9dde2", 0.08, 1);
  await material([rotor, spoke], "Gunmetal", "#2b2f33", 0.35, 0.8);
  await material([core, rim], "Repulsor glow", "#5fe6ff", 0.1, 0);
  // inner group: rotate about Y by the inner tilt first, then everything (with the outer) about X by the outer tilt
  const innerGroup = [inner, rotor, rim, core, spoke];
  await rot(innerGroup, [0, 1, 0], INNER_TILT);
  await rot([outer, ...innerGroup], [1, 0, 0], OUTER_TILT);
  // spokes: 5 more as rotation instances about the rotor axis (read back from the rotor's flat face)
  const rf = (await info(rotor)).faces.filter((f) => f.planar);
  const n = rf[0]!.normal;
  const rotorAxis = (n[2] < 0 ? n.map((v) => -v) : n) as Vec;
  for (let k = 1; k < 6; k++) {
    const before = new Set(((await call("plasticity_list_instances")).instances ?? []).map((i: { id: number }) => i.id));
    await call("plasticity_create_instance", { bodyId: spoke, translationMm: [0, 0, 0], revision: await rev() });
    const id = ((await call("plasticity_list_instances")).instances ?? []).find((i: { id: number }) => !before.has(i.id)).id;
    await call("plasticity_rotate_instances", { ids: [id], pivotMm: C, axis: rotorAxis, degrees: 60 * k, revision: await rev() });
  }
  const innerFace = (await info(inner)).faces.find((f) => f.planar)!.normal;
  const pivots = {
    units: "millimetres, Z up, nose +Y (Plasticity world); Blender scene uses metres (x 0.001)",
    centre: C,
    parts: {
      rc11_Gyro_OuterGimbal: { pivot: C, axis: [1, 0, 0], note: `pivots in the trunnions; tilted ${OUTER_TILT} deg about X at rest` },
      rc11_Gyro_InnerGimbal: { pivot: C, axis: outerY.map((v) => +v.toFixed(6)), note: `the outer's local Y; inner tilted ${INNER_TILT} deg about it at rest; child of the outer` },
      rc11_Gyro_Rotor: { pivot: C, axis: rotorAxis.map((v) => +v.toFixed(6)), note: "spin axis (rotor, rim light, core, spokes); child of the inner" },
    },
    restNormals: { inner: innerFace.map((v: number) => +v.toFixed(6)), rotor: rotorAxis.map((v) => +v.toFixed(6)) },
    animation: { rotorRps: 2.0, innerPrecessionDegPerSec: 12, outerPrecessionDegPerSec: 6 },
  };
  await writeFile(resolve("discovery/neorc11/gyro_pivots.json"), JSON.stringify(pivots, null, 1));
  say(`rotor axis ${rotorAxis.map((v) => v.toFixed(3))}; pivots written`);
  const g = (await bodies()).filter((b) => (b.name ?? "").startsWith("rc11_Gyro"));
  for (const b of g) say(`${b.name}#${b.id} [${b.boundsMm.min.map(Math.round)}]..[${b.boundsMm.max.map(Math.round)}]`);
  const valid = await call("plasticity_validate_bodies", { ids: [hull.id, ...g.map((b) => b.id)], revision: await rev() });
  say(`validate: ${(valid.bodies ?? []).filter((v: any) => v.closed && v.nativeValid).length}/${(valid.bodies ?? []).length} valid`);
} finally {
  await writeFile(resolve("discovery/neorc11/user-half/gyro-log.json"), JSON.stringify(notes, null, 1));
  await s.close();
}
