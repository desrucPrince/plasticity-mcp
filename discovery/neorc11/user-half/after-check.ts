// Unhides Polyline.001 (left as the user had it), then re-runs counts, validity and symmetry after the fixes.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openSession } from "../../mcp-client.ts";
const s = await openSession();
const call = (t: string, a: Record<string, unknown> = {}) => s.raw("plasticity_call", { toolName: t, arguments: a });
try {
  let first = await s.raw("plasticity_status", { bodyLimit: 200 }); let all = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await s.raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  const poly = all.find((b) => b.name === "Polyline.001");
  if (poly && poly.visible === false) await call("plasticity_set_visibility", { bodyIds: [poly.id], visible: true, revision: first.revision });
  first = await s.raw("plasticity_status", { bodyLimit: 200 }); all = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await s.raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  const vis = all.filter((b) => b.visible !== false);
  const inst = (await call("plasticity_list_instances")).instances ?? [];
  const linked = new Set(inst.filter((i: any) => i.visible !== false).flatMap((i: any) => i.sourceBodyIds));
  const solids = vis.filter((b) => b.type === "Solid");
  const v = await call("plasticity_validate_bodies", { ids: solids.map((b) => b.id), revision: first.revision });
  const rows = v.bodies ?? [];
  const isGyro = (b: any) => (b.name ?? "").startsWith("rc11_Gyro");
  const key = (b: any) => [b.type, ...b.boundsMm.min, ...b.boundsMm.max].map((x: any) => typeof x === "number" ? Math.round(x) : x).join(",");
  const seen = new Map<string, number>(); for (const b of vis) seen.set(key(b), (seen.get(key(b)) ?? 0) + 1);
  const rep = {
    doc: first.title, undo: first.undoDepth, bodies: all.length, visibleSolids: solids.length, visibleSheets: vis.filter((b) => b.type === "Sheet").length, wires: vis.filter((b) => b.type === "Wire").length,
    instances: inst.length, visibleInstances: inst.filter((i: any) => i.visible !== false).length,
    valid: `${rows.filter((x: any) => x.closed && x.nativeValid).length}/${rows.length}`,
    unmirroredPlusX: vis.filter((b) => b.type !== "Wire" && !isGyro(b) && b.boundsMm.max[0] > 1 && !linked.has(b.id)).map((b) => `${b.name}#${b.id}`),
    plainMinusX: vis.filter((b) => b.type !== "Wire" && !isGyro(b) && b.boundsMm.max[0] < -1).map((b) => `${b.name}#${b.id}`),
    stackedDuplicates: [...seen.values()].filter((n) => n > 1).length,
    louvres: { plusX: vis.filter((b) => (b.name ?? "").startsWith("rc11_louvre") && b.boundsMm.min[0] > 0).length, mirrors: inst.filter((i: any) => /louvre/.test(i.targetName ?? "")).length },
    podTrim: vis.filter((b) => b.name === "rc11_pod_trim").map((b) => `#${b.id} mirrored=${linked.has(b.id)}`),
  };
  await writeFile(resolve("discovery/neorc11/review-final/fixes/after-check.json"), JSON.stringify(rep, null, 1));
  console.log(JSON.stringify(rep, null, 1));
} finally { await s.close(); }
