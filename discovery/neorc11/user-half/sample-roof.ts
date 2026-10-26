// Samples the isolated roof sheet (Face sheet.001): projects lines along Y at several X onto it (straight down) and
// evaluates the projected curves at 21 points each. Writes discovery/neorc11/user-half/roof-samples.json and deletes
// its temporary curves. Read-only for the user's bodies.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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
try {
  const sheet = (await bodies()).find((b) => b.name === "Face sheet.001" && b.type === "Sheet");
  if (!sheet) throw new Error("Face sheet.001 not found");
  const xs = [0, 300, 450, 600, 750, 900, 1050, 1200];
  const out: Record<string, Array<[number, number, number]>> = {};
  for (const x of xs) {
    const before = new Set((await bodies()).map((b) => b.id));
    await call("plasticity_create_polyline", { pointsMm: [[x, -1400, 6500], [x, 1400, 6500]], revision: await rev() });
    const line = (await bodies()).find((b) => !before.has(b.id))!; temp.push(line.id);
    const mid = new Set((await bodies()).map((b) => b.id));
    await call("plasticity_project_curves_onto_body", { targetId: sheet.id, curveIds: [line.id], direction: [0, 0, -1], revision: await rev() });
    const proj = (await bodies()).filter((b) => !mid.has(b.id)); temp.push(...proj.map((b) => b.id));
    const dirs = (await call("plasticity_list_curve_directions")).wires ?? (await call("plasticity_list_curve_directions")).curves ?? [];
    const segs = (Array.isArray(dirs) ? dirs : []).filter((w: any) => proj.some((p) => p.id === (w.bodyId ?? w.id))).flatMap((w: any) => (w.segments ?? []).map((g: any) => ({ bodyId: w.bodyId ?? w.id, segmentEntityId: g.segmentEntityId ?? g.entityId ?? g.id })));
    const samples = segs.flatMap((g: any) => Array.from({ length: 21 }, (_, k) => ({ ...g, normalizedParameter: k / 20 })));
    if (!samples.length) { out[String(x)] = []; continue; }
    const ev = await call("plasticity_evaluate_curve_segments", { samples, revision: await rev() });
    out[String(x)] = (ev.samples ?? ev.results ?? []).map((p: any) => (p.positionMm ?? p.pointMm ?? p.position).map((v: number) => Math.round(v))).sort((a: number[], b: number[]) => a[1] - b[1]);
    console.log("x", x, "points", out[String(x)].length, "z range", Math.min(...out[String(x)].map((p) => p[2])), Math.max(...out[String(x)].map((p) => p[2])));
  }
  await writeFile(resolve("discovery/neorc11/user-half/roof-samples.json"), JSON.stringify(out));
} finally {
  if (temp.length) await raw("plasticity_delete", { ids: temp, revision: await rev() }).catch((e: unknown) => console.log("cleanup", String(e).slice(0, 120)));
  await s.close();
}
