// Roof scoops on the user's isolated roof sheet ("Face sheet.001"), a pair at X ±700: raked, forward-facing intakes
// that rise out of the roof (the side profile follows the sampled roof section, roof-samples.json), each with a
// recessed mouth, a dark back plate, 4 gunmetal vanes (linked instances), G2-rounded top edges, a chamfered lip and
// 3 bolts on the outer side. +X parts get mirrored linked instances for -X. Bodies are named rc11_scoop_*; rerunning
// deletes them (and their instances) first. Never touches the roof sheet itself or the isolate view.
// Usage: PLASTICITY_CDP_URL=http://127.0.0.1:9223 node discovery/neorc11/user-half/scoops.ts
import { readFile, writeFile } from "node:fs/promises";
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
const info = async (id: number) => (await raw("plasticity_body_info", { id })).body as { edges: Array<{ id: string; boundsMm: { min: Vec; max: Vec }; lengthMm: number }>; faces: any[] };
const instances = async () => ((await call("plasticity_list_instances")).instances ?? []) as Array<{ id: number; sourceBodyIds: number[] }>;
const notes: string[] = [];
const say = (...x: unknown[]) => { const t = x.map(String).join(" "); notes.push(t); console.log(t); };
const r1 = (v: number) => Math.round(v * 10) / 10;

// Roof section (constant across X): z(y) by linear interpolation of the samples at X 750.
const samples = (JSON.parse(await readFile(resolve("discovery/neorc11/user-half/roof-samples.json"), "utf8"))["750"] as Vec[]).sort((a, b) => a[1] - b[1]);
const zr = (y: number) => {
  for (let i = 1; i < samples.length; i++) if (y <= samples[i]![1]) {
    const [, y0, z0] = samples[i - 1]!, [, y1, z1] = samples[i]!;
    return z0 + (z1 - z0) * (y - y0) / (y1 - y0);
  }
  return samples.at(-1)![2];
};
const S = { xc: 700, w: 360, yTail: -500, yMouth: 300, h: 110, embed: 40, wall: 25, pocketDepth: 200, lip: 20 };
const xOut = S.xc + S.w / 2, xIn = S.xc - S.w / 2;
const h = (y: number) => { const t = Math.min(1, Math.max(0, (y - S.yTail) / (S.yMouth - S.yTail))); return S.h * t * t * (3 - 2 * t); };

async function newest(make: () => Promise<unknown>) {
  const before = new Set((await instances()).map((i) => i.id));
  await make();
  return (await instances()).find((i) => !before.has(i.id))!.id;
}
async function place(sourceId: number, ts: Vec[]) {
  let n = 0;
  for (const t of ts) { await newest(async () => call("plasticity_create_instance", { bodyId: sourceId, translationMm: t, revision: await rev() })); n++; }
  for (const t of [[0, 0, 0] as Vec, ...ts]) {
    const id = await newest(async () => call("plasticity_create_mirrored_instance", { bodyId: sourceId, axis: "x", planeOffsetMm: 0, revision: await rev() }));
    if (t.some((v) => v !== 0)) await call("plasticity_move_instances", { ids: [id], deltaMm: [-t[0], t[1], t[2]], revision: await rev() });
    n++;
  }
  return n;
}
// Extrude a closed YZ-plane profile (at x0) across X to x1, whichever way Plasticity extrudes it. With smoothTop,
// the first smoothTop points become one smooth control-point curve and the rest a polyline joined to it.
async function extrudeYZ(pts: Array<[number, number]>, x0: number, x1: number, name: string, smoothTop = 0): Promise<number> {
  const at = ([y, z]: [number, number]) => [x0, r1(y), r1(z)];
  const steps = smoothTop
    ? [
      { toolName: "plasticity_create_control_point_curve", arguments: { pointsMm: pts.slice(0, smoothTop).map(at) } },
      { toolName: "plasticity_create_polyline", arguments: { pointsMm: [...pts.slice(smoothTop - 1), pts[0]!].map(at) } },
      { toolName: "plasticity_join_curves", arguments: { ids: ["$0.added[0]", "$1.added[0]"] } },
      // join_curves merges into the first curve and keeps its ID
      { toolName: "plasticity_extrude_profile", arguments: { id: "$0.added[0]", distanceMm: Math.abs(x1 - x0) } },
    ]
    : [
      { toolName: "plasticity_create_polyline", arguments: { pointsMm: pts.map(at), closed: true } },
      { toolName: "plasticity_extrude_profile", arguments: { id: "$0.added[0]", distanceMm: Math.abs(x1 - x0) } },
    ];
  const out = await raw("plasticity_batch", { undoOnError: true, steps });
  const last = steps.length - 1;
  const wire = out.steps[0].added[0] as number, id = out.steps[last].added[0] as number;
  let b = (await bodies()).find((x) => x.id === id);
  const want = Math.min(x0, x1);
  if (Math.abs(b.boundsMm.min[0] - want) > 0.5) await raw("plasticity_move", { ids: [id], deltaMm: [want - b.boundsMm.min[0], 0, 0], revision: await rev() });
  await raw("plasticity_delete", { ids: [wire], revision: await rev() });
  await call("plasticity_rename", { id, name, revision: await rev() });
  return id;
}
const material = async (ids: number[], name: string, colorHex: string, roughness: number, metalness: number) =>
  call("plasticity_set_appearance_material", { ids, name, colorHex, roughness, metalness, opacity: 1, revision: await rev() });

try {
  // ---- reset earlier runs
  const old = (await bodies()).filter((b) => (b.name ?? "").startsWith("rc11_scoop"));
  if (old.length) {
    const ids = new Set(old.map((b) => b.id));
    const inst = (await instances()).filter((i) => i.sourceBodyIds.some((x) => ids.has(x))).map((i) => i.id);
    if (inst.length) await call("plasticity_delete_instances", { ids: inst, revision: await rev() });
    await raw("plasticity_delete", { ids: [...ids], revision: await rev() });
    say(`removed ${old.length} earlier scoop bodies`);
  }

  // ---- scoop shell: side profile = roof section below, smooth rising top, vertical mouth face
  const ys = Array.from({ length: 17 }, (_, k) => S.yTail + (S.yMouth - S.yTail) * k / 16);
  const profile: Array<[number, number]> = [
    ...ys.map((y) => [y, zr(y) + h(y)] as [number, number]),
    [S.yMouth, zr(S.yMouth) - S.embed],
    ...ys.slice().reverse().slice(1).map((y) => [y, zr(y) - S.embed] as [number, number]),
  ];
  const scoop = await extrudeYZ(profile, xOut, xIn, "rc11_scoop", ys.length);
  say(`scoop shell X ${xIn}..${xOut}, Y ${S.yTail}..${S.yMouth}, mouth ${S.h} mm tall above the roof (roof Z ${Math.round(zr(S.yTail))}..${Math.round(zr(S.yMouth))})`);
  // G2 round on the two top edges (top surface to side walls), then the mouth pocket.
  // Top edges: on a side wall, not vertical, and above the roof line (the base edges sit 40 mm under it).
  const onSide = (e: any) => Math.abs(e.boundsMm.max[0] - e.boundsMm.min[0]) < 0.5 && (Math.abs(e.boundsMm.min[0] - xIn) < 0.5 || Math.abs(e.boundsMm.min[0] - xOut) < 0.5);
  const top = (await info(scoop)).edges.filter((e) => onSide(e) && e.boundsMm.max[1] - e.boundsMm.min[1] > 100 && (e.boundsMm.min[2] + e.boundsMm.max[2]) / 2 > zr((e.boundsMm.min[1] + e.boundsMm.max[1]) / 2) - 5).map((e) => e.id);
  try { await raw("plasticity_fillet", { id: scoop, edgeIds: top, radiusMm: 30, shape: "g2", revision: await rev() }); say(`top edges G2 r30 (${top.length})`); }
  catch (error) { say(`top edge G2 refused (${String(error).slice(0, 100)}); trying round r20`); try { await raw("plasticity_fillet", { id: scoop, edgeIds: top, radiusMm: 20, shape: "round", revision: await rev() }); } catch { say("top edge round refused"); } }
  const yBack = S.yMouth - S.pocketDepth;
  const pocket: Array<[number, number]> = [
    [S.yMouth + 20, zr(S.yMouth) + S.h - S.lip], [yBack, zr(yBack) + h(yBack) - S.lip - 8],
    [yBack, zr(yBack) + 12], [S.yMouth + 20, zr(S.yMouth) + 12],
  ];
  const cutter = await extrudeYZ(pocket, xOut - S.wall, xIn + S.wall, "rc11_scoop_pocket_cutter");
  await raw("plasticity_boolean", { targetIds: [scoop], toolIds: [cutter], operation: "difference", revision: await rev() });
  // Chamfer the mouth lip (edges on the mouth plane).
  const lip = (await info(scoop)).edges.filter((e) => Math.abs(e.boundsMm.min[1] - S.yMouth) < 0.5 && Math.abs(e.boundsMm.max[1] - S.yMouth) < 0.5 && e.boundsMm.min[2] > zr(S.yMouth) + 5).map((e) => e.id);
  try { await raw("plasticity_chamfer", { id: scoop, edgeIds: lip, distanceMm: 6, revision: await rev() }); say(`mouth lip chamfer 6 (${lip.length} edges)`); } catch { say("mouth lip chamfer refused"); }
  await material([scoop], "Eldorado midnight", "#0b1630", 0.3, 0.7);

  // ---- dark back plate in the pocket
  const plate = await extrudeYZ([[yBack + 0.5, zr(yBack) + 12], [yBack + 0.5, zr(yBack) + h(yBack) - S.lip - 8], [yBack + 12, zr(yBack + 12) + h(yBack + 12) - S.lip - 8], [yBack + 12, zr(yBack + 12) + 12]], xOut - S.wall, xIn + S.wall, "rc11_scoop_mouth");
  await material([plate], "Intake black", "#06080a", 0.6, 0.2);

  // ---- 4 vanes in the mouth (one source, 3 translated instances), 8 mm thick
  const inner = S.w - 2 * S.wall, pitch = inner / 5;
  const v0 = xIn + S.wall + pitch;
  const vane = await extrudeYZ([[yBack + 12, zr(yBack + 12) + 12], [yBack + 12, zr(yBack + 12) + h(yBack + 12) - S.lip - 10], [S.yMouth - 10, zr(S.yMouth) + S.h - S.lip - 4], [S.yMouth - 10, zr(S.yMouth) + 12]], v0 - 4, v0 + 4, "rc11_scoop_vane");
  try { await raw("plasticity_chamfer", { id: vane, edgeIds: (await info(vane)).edges.map((e) => e.id), distanceMm: 1.5, revision: await rev() }); } catch { say("vane chamfer refused"); }
  await material([vane], "Gunmetal", "#2b2f33", 0.35, 0.8);

  // ---- bolts on the outer side wall (axis +X), from the same round cap-screw design as the polish pass
  const boltYs = [-150, 50, 250];
  const boltOut = await raw("plasticity_batch", { undoOnError: true, steps: [{ toolName: "plasticity_create_cylinder", arguments: { centerMm: [xOut - 2, boltYs[0], zr(boltYs[0]!) + h(boltYs[0]!) / 2], radiusMm: 12, heightMm: 8, axis: [1, 0, 0], name: "rc11_scoop_bolt" } }] });
  const bolt = boltOut.steps[0].added[0] as number;
  const bb = (await bodies()).find((b) => b.id === bolt);
  const want = [xOut - 2 + 4, boltYs[0]!, zr(boltYs[0]!) + h(boltYs[0]!) / 2];
  const d = [0, 1, 2].map((i) => want[i]! - (bb.boundsMm.min[i] + bb.boundsMm.max[i]) / 2) as Vec;
  if (d.some((v) => Math.abs(v) > 0.01)) await raw("plasticity_move", { ids: [bolt], deltaMm: d, revision: await rev() });
  await call("plasticity_rename", { id: bolt, name: "rc11_scoop_bolt", revision: await rev() });
  await material([bolt], "Fastener", "#8e959c", 0.25, 1);

  // ---- instances and mirrors
  const counts: Record<string, number> = {};
  counts.scoop = await place(scoop, []);
  counts.mouth = await place(plate, []);
  counts.vanes = await place(vane, [1, 2, 3].map((k) => [pitch * k, 0, 0] as Vec));
  counts.bolts = await place(bolt, boltYs.slice(1).map((y) => [0, y - boltYs[0]!, (zr(y) + h(y) / 2) - (zr(boltYs[0]!) + h(boltYs[0]!) / 2)] as Vec));
  say(`instances: ${JSON.stringify(counts)}`);
  const parts = (await bodies()).filter((b) => (b.name ?? "").startsWith("rc11_scoop"));
  const v = await call("plasticity_validate_bodies", { ids: parts.filter((b) => b.type === "Solid").map((b) => b.id), revision: await rev() });
  say(`validate: ${(v.bodies ?? []).filter((x: any) => x.closed && x.nativeValid).length}/${(v.bodies ?? []).length} valid`);
  for (const b of parts) say(`${b.name}#${b.id} [${b.boundsMm.min.map(Math.round)}]..[${b.boundsMm.max.map(Math.round)}]`);
} finally {
  await writeFile(resolve("discovery/neorc11/user-half/scoops-log.json"), JSON.stringify(notes, null, 1));
  await s.close();
}
