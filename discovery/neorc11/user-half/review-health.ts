// Read-only health checks for the final review, plus the remaining named screenshots.
import { mkdir, rename, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openSession } from "../../mcp-client.ts";
const out = resolve("discovery/neorc11/review-final");
await mkdir(out, { recursive: true });
const s = await openSession();
const call = (t: string, a: Record<string, unknown> = {}) => s.raw("plasticity_call", { toolName: t, arguments: a });
const r = (v: number) => Math.round(v * 1000) / 1000;
try {
  const first = await s.raw("plasticity_status", { bodyLimit: 200 }); const all = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await s.raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  const vis = all.filter((b) => b.visible !== false);
  const inst = (await call("plasticity_list_instances")).instances ?? [];
  const groups = (await call("plasticity_list_groups")).groups ?? [];
  const inGroup = new Set(groups.filter((g: any) => ["EDIT SIDE", "GYRO (centreline)", "blockout_ref"].includes(g.name)).flatMap((g: any) => g.bodyIds));
  const rep: Record<string, unknown> = {};
  rep.notInGroups = vis.filter((b) => !inGroup.has(b.id)).map((b) => `${b.name}#${b.id} ${b.type}`);
  rep.minusXPlain = vis.filter((b) => b.type !== "Wire" && b.boundsMm.max[0] < -1 && !(b.name ?? "").startsWith("rc11_Gyro")).map((b) => `${b.name}#${b.id}`);
  const key = (b: any) => [b.type, ...b.boundsMm.min, ...b.boundsMm.max].map((v: any) => typeof v === "number" ? Math.round(v) : v).join(",");
  const seen = new Map<string, any[]>(); for (const b of vis) seen.set(key(b), [...(seen.get(key(b)) ?? []), b]);
  rep.stackedDuplicates = [...seen.values()].filter((g) => g.length > 1).map((g) => g.map((b: any) => `${b.name}#${b.id}`).join(" = "));
  rep.wires = vis.filter((b) => b.type === "Wire").map((b) => `${b.name}#${b.id} [${b.boundsMm.min.map(Math.round)}]..[${b.boundsMm.max.map(Math.round)}]`);
  rep.trims = vis.filter((b) => /trim|^null$/.test(String(b.name)) && b.type === "Solid").map((b) => `${b.name}#${b.id} [${b.boundsMm.min.map(Math.round)}]..[${b.boundsMm.max.map(Math.round)}] mirrored=${inst.some((i: any) => i.sourceBodyIds.includes(b.id))}`);
  rep.belowGround = vis.filter((b) => b.type !== "Wire" && b.boundsMm.min[2] <= 0).map((b) => b.name);
  // hull: centre faces, one-sided faces (the hull is a +X half now), and continuity on its blend faces
  const hull = vis.find((b) => b.name === "rc11_hull");
  const hb = (await s.raw("plasticity_body_info", { id: hull.id })).body;
  rep.hull = { faces: hb.faces.length, edges: hb.edges.length, centreFaces: hb.faces.filter((f: any) => f.planar && Math.abs(f.boundsMm.min[0]) < 1e-3 && Math.abs(f.boundsMm.max[0]) < 1e-3).length, faceMinX: r(Math.min(...hb.faces.map((f: any) => f.boundsMm.min[0]))), tinyFaces: hb.faces.filter((f: any) => [0, 1, 2].filter((i) => f.boundsMm.max[i] - f.boundsMm.min[i] < 1).length >= 2).length, mirrored: inst.some((i: any) => i.sourceBodyIds.includes(hull.id)) };
  const blends = new Set(hb.faces.filter((f: any) => f.surfaceType === "BSurf").map((f: any) => f.id));
  const edges = hb.edges.filter((e: any) => e.faceIds.length === 2 && e.faceIds.some((f: string) => blends.has(f))).map((e: any) => ({ bodyId: hull.id, edgeId: e.id }));
  const cont = await call("plasticity_analyze_surface_continuity", { edges: edges.slice(0, 400), revision: first.revision });
  const rows = cont.analyses ?? [];
  const tangent = rows.filter((a: any) => a.maximumNormalAngleDeviationDeg < 1);
  rep.hullBlendContinuity = { edgesSampled: rows.length, tangent: tangent.length, g2: tangent.filter((a: any) => Number(a.maximumRelativeCurvatureDeviation) <= 0.05).length, g1Only: tangent.filter((a: any) => Number(a.maximumRelativeCurvatureDeviation) > 0.05).length, creases: rows.length - tangent.length, maxG1degOnTangent: r(Math.max(0, ...tangent.map((a: any) => a.maximumNormalAngleDeviationDeg))) };
  // roof sheet: open boundary and where it sits against the hull
  const sheet = vis.find((b) => b.type === "Sheet");
  if (sheet) {
    const sb = (await s.raw("plasticity_body_info", { id: sheet.id })).body;
    rep.roofSheet = { name: sheet.name, id: sheet.id, faces: sb.faces.length, openEdges: sb.edges.filter((e: any) => e.faceIds.length === 1).length, bounds: [sheet.boundsMm.min.map(Math.round), sheet.boundsMm.max.map(Math.round)], mirrored: inst.some((i: any) => i.sourceBodyIds.includes(sheet.id)) };
  }
  await writeFile(resolve(out, "health.json"), JSON.stringify(rep, null, 1));
  console.log(JSON.stringify(rep, null, 1).slice(0, 6000));
  // screenshots with the required names
  const shots: Array<[string, Record<string, unknown> | string]> = [
    ["01-front34", { eyeMm: [-11000, 19000, 7000], targetMm: [0, 0, 2800], frameRadiusMm: 9000 }],
    ["02-rear34", { eyeMm: [11000, -19000, 9000], targetMm: [0, -500, 2800], frameRadiusMm: 9000 }],
    ["03-side", "right"], ["04-top", "top"], ["05-front", "back"], ["06-belly", "bottom"],
    ["07-detail", { eyeMm: [9000, 2600, 3300], targetMm: [3640, 2600, 2520], frameRadiusMm: 1900 }],
  ];
  for (const [name, aim] of shots) {
    if (typeof aim === "string") await call("plasticity_set_view", { view: aim, fit: true });
    else await call("plasticity_set_camera", aim);
    await new Promise((res) => setTimeout(res, 1200));
    await s.raw("plasticity_screenshot", { path: resolve(out, `${name}.tmp.png`) });
    const made = (await readdir(out)).find((f) => f.startsWith(`${name}.tmp`));
    if (made) await rename(resolve(out, made), resolve(out, `${name}.png`));
  }
} finally { await s.close(); }
