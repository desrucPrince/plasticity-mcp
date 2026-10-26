// Read-only flicker probe: compares the roof sheet with the hull roof (projected lines at several X, temporary
// curves deleted), and lists coincident-face candidates for the visor, glow plates and stacked duplicates.
import { openSession } from "../../mcp-client.ts";
const s = await openSession();
const raw = (n: string, a: Record<string, unknown> = {}) => s.raw(n, a);
const call = (t: string, a: Record<string, unknown> = {}) => raw("plasticity_call", { toolName: t, arguments: a });
const rev = async () => (await raw("plasticity_status", { bodyLimit: 1 })).revision as string;
async function bodies(): Promise<any[]> {
  const first = await raw("plasticity_status", { bodyLimit: 200 }); const all = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  return all;
}
const temp: number[] = [];
async function section(targetId: number, x: number) {
  const before = new Set((await bodies()).map((b) => b.id));
  await call("plasticity_create_polyline", { pointsMm: [[x, -1400, 7000], [x, 1400, 7000]], revision: await rev() });
  const line = (await bodies()).find((b) => !before.has(b.id))!; temp.push(line.id);
  const mid = new Set((await bodies()).map((b) => b.id));
  await call("plasticity_project_curves_onto_body", { targetId, curveIds: [line.id], direction: [0, 0, -1], revision: await rev() }).catch(() => undefined);
  const proj = (await bodies()).filter((b) => !mid.has(b.id)); temp.push(...proj.map((b) => b.id));
  const dirs = await call("plasticity_list_curve_directions");
  const list = (dirs.wires ?? dirs.curves ?? []) as any[];
  const segs = list.filter((w) => proj.some((p) => p.id === (w.bodyId ?? w.id))).flatMap((w: any) => (w.segments ?? []).map((g: any) => ({ bodyId: w.bodyId ?? w.id, segmentEntityId: g.segmentEntityId ?? g.entityId ?? g.id })));
  if (!segs.length) return [] as number[][];
  const ev = await call("plasticity_evaluate_curve_segments", { samples: segs.flatMap((g: any) => Array.from({ length: 11 }, (_, k) => ({ ...g, normalizedParameter: k / 10 }))), revision: await rev() });
  return (ev.samples ?? ev.results ?? []).map((p: any) => (p.positionMm ?? p.pointMm ?? p.position) as number[]);
}
try {
  const all = await bodies();
  const hull = all.find((b) => b.name === "rc11_hull"), sheet = all.find((b) => b.type === "Sheet");
  for (const x of [200, 900, 1600]) {
    const hs = await section(hull.id, x), ss = await section(sheet.id, x);
    // compare at matching Y: for each sheet point, nearest hull point by Y (topmost hull hit at that Y)
    const rows = ss.map((p) => {
      const near = hs.filter((q) => Math.abs(q[1] - p[1]) < 60).sort((a, b) => b[2] - a[2])[0];
      return near ? Math.round(p[2] - near[2]) : null;
    }).filter((v) => v !== null) as number[];
    console.log(`x ${x}: sheet minus hull roof (mm) at ${rows.length} points:`, rows.join(" "));
  }
  const vis = all.filter((b) => b.visible !== false);
  console.log("visor bodies:", vis.filter((b) => /Visor/.test(b.name ?? "")).map((b) => `${b.name}#${b.id} ${b.type}`).join(", "));
  console.log("glow/core:", vis.filter((b) => /drive_core|exhaust_glow/.test(b.name ?? "")).map((b) => `${b.name}#${b.id} [${b.boundsMm.min.map(Math.round)}]..[${b.boundsMm.max.map(Math.round)}]`).join(" | "));
} finally {
  if (temp.length) await raw("plasticity_delete", { ids: temp, revision: await rev() }).catch((e: unknown) => console.log("cleanup", String(e).slice(0, 100)));
  await s.close();
}
