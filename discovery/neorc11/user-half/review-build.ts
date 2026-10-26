// Read-only review of the user's finished build: document, groups, instances, bodies without a mirror, new bodies
// since V10 (ids above the last known), validity, bounds, plus screenshots from five angles (camera moves only).
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openSession } from "../../mcp-client.ts";
const dir = resolve("discovery/neorc11/user-half/review-final");
await mkdir(dir, { recursive: true });
const s = await openSession();
const call = (t: string, a: Record<string, unknown> = {}) => s.raw("plasticity_call", { toolName: t, arguments: a });
try {
  const first = await s.raw("plasticity_status", { bodyLimit: 200 }); const all = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await s.raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  const inst = (await call("plasticity_list_instances")).instances ?? [];
  const groups = (await call("plasticity_list_groups")).groups ?? [];
  const linked = new Set(inst.flatMap((i: any) => i.sourceBodyIds));
  const vis = all.filter((b) => b.visible !== false);
  const byType: Record<string, number> = {};
  for (const b of vis) byType[b.type] = (byType[b.type] ?? 0) + 1;
  const solids = vis.filter((b) => b.type === "Solid");
  const v = await call("plasticity_validate_bodies", { ids: solids.map((b) => b.id), revision: first.revision });
  const rows = v.bodies ?? [];
  const invalid = rows.filter((x: any) => !x.closed || !x.nativeValid).map((x: any) => `${x.name}#${x.id}`);
  const newBodies = vis.filter((b) => b.id > 966);
  const unmirrored = vis.filter((b) => b.type !== "Wire" && !linked.has(b.id) && !(b.name ?? "").startsWith("rc11_Gyro") && b.boundsMm.max[0] > 1);
  const lo = [0, 1, 2].map((i) => Math.min(...vis.filter((b) => b.type !== "Wire").map((b) => Math.min(b.boundsMm.min[i], i === 0 ? -b.boundsMm.max[0] : Infinity))));
  const hi = [0, 1, 2].map((i) => Math.max(...vis.filter((b) => b.type !== "Wire").map((b) => Math.max(b.boundsMm.max[i], i === 0 ? -b.boundsMm.min[0] : -Infinity))));
  const report = {
    doc: first.title, undo: first.undoDepth, bodies: all.length, visible: vis.length, byType, instances: inst.length, mirroredInstances: inst.filter((i: any) => i.scale[0] < 0).length,
    groups: groups.filter((g: any) => g.id > 0).map((g: any) => `${g.name}: ${g.bodyIds.length} bodies, ${g.instanceIds.length} instances${g.hidden ? " (hidden)" : ""}`),
    validity: `${rows.length - invalid.length}/${rows.length} solids valid`, invalid,
    newSinceV10: newBodies.map((b) => `${b.name}#${b.id} ${b.type} [${b.boundsMm.min.map(Math.round)}]..[${b.boundsMm.max.map(Math.round)}]${linked.has(b.id) ? " (mirrored)" : ""}`),
    withoutMirror: unmirrored.map((b) => `${b.name}#${b.id} ${b.type} [${b.boundsMm.min.map(Math.round)}]..[${b.boundsMm.max.map(Math.round)}]`),
    boundsWithMirrorMm: { min: lo.map(Math.round), max: hi.map(Math.round), size: hi.map((x, i) => Math.round(x - lo[i]!)) },
  };
  await writeFile(resolve(dir, "review.json"), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1).slice(0, 7000));
  const shots: Array<[string, () => Promise<unknown>]> = [
    ["iso", () => call("plasticity_set_view", { view: "isometric", fit: true })],
    ["top", () => call("plasticity_set_view", { view: "top", fit: true })],
    ["side", () => call("plasticity_set_view", { view: "right", fit: true })],
    ["front34", () => call("plasticity_set_camera", { eyeMm: [-11000, 19000, 7000], targetMm: [0, 0, 2800], frameRadiusMm: 9000 })],
    ["rear34", () => call("plasticity_set_camera", { eyeMm: [11000, -19000, 9000], targetMm: [0, -500, 2800], frameRadiusMm: 9000 })],
  ];
  for (const [label, aim] of shots) {
    await aim();
    await new Promise((r) => setTimeout(r, 1200));
    await s.raw("plasticity_screenshot", { path: resolve(dir, `${label}-${Date.now()}.png`) });
  }
} finally { await s.close(); }
