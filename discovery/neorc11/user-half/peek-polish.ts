import { openSession } from "../../mcp-client.ts";
const s = await openSession();
try {
  const a = await s.raw("plasticity_status", { bodyLimit: 200 });
  const b = a.bodyPagination?.nextOffset != null ? await s.raw("plasticity_status", { bodyLimit: 200, bodyOffset: 200, expectedRevision: a.revision }) : { bodies: [] };
  const all = [...a.bodies, ...b.bodies];
  console.log("total", all.length, "bodyCount", a.bodyCount ?? a.bodyPagination?.total);
  const c: Record<string, [number, number]> = {};
  for (const x of all.filter((x: any) => (x.name ?? "").startsWith("rc11_p_") && x.visible !== false && x.type !== "Wire")) {
    const k = x.name.replace(/\.\d+$/, ""); c[k] ??= [0, 0]; c[k][x.boundsMm.max[0] <= 0.5 ? 1 : 0]++;
  }
  for (const [k, [p, m]] of Object.entries(c)) console.log(k.padEnd(28), "+X", p, "-X", m);
} finally { await s.close(); }
