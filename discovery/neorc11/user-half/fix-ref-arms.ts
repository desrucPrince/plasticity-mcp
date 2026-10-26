// The reference figure's arms only touched its torso, so the union left them separate (and the linked copy armless):
// nudge each arm 6 mm into the torso and unite them into the figure.
import { openSession } from "../../mcp-client.ts";
const s = await openSession();
const rev = async () => (await s.raw("plasticity_status", { bodyLimit: 1 })).revision as string;
try {
  const first = await s.raw("plasticity_status", { bodyLimit: 200 }); const all = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await s.raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  const refs = all.filter((b) => b.name === "rc11_ref_human");
  const main = refs.reduce((a, b) => ((b.boundsMm.max[2] - b.boundsMm.min[2]) > (a.boundsMm.max[2] - a.boundsMm.min[2]) ? b : a));
  const arms = refs.filter((b) => b !== main);
  for (const a of arms) await s.raw("plasticity_move", { ids: [a.id], deltaMm: [a.boundsMm.min[0] > 0 ? -6 : 6, 0, 0], revision: await rev() });
  await s.raw("plasticity_boolean", { targetIds: [main.id], toolIds: arms.map((a) => a.id), operation: "union", revision: await rev() });
  const left = (await s.raw("plasticity_status", { bodyLimit: 200 })).bodies.filter((b: any) => b.name === "rc11_ref_human");
  console.log("arms united:", arms.length, "ref bodies now:", left.length, JSON.stringify(left.map((b: any) => [b.id, b.boundsMm.min.map(Math.round), b.boundsMm.max.map(Math.round)])));
} finally { await s.close(); }
