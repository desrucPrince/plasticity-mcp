// Tries loft options for the fin sections; each attempt undoes itself on failure, successes are deleted.
import { openSession } from "../../mcp-client.ts";
const s = await openSession();
const D = Math.PI / 180, r = (v: number) => Math.round(v * 100) / 100;
const FIN = { x: 3657, z: 2450, cant: 25, span: 1360, t: 110 };
const dir = [Math.cos(FIN.cant * D), 0, -Math.sin(FIN.cant * D)], nrm = [Math.sin(FIN.cant * D), 0, Math.cos(FIN.cant * D)];
const sec = (sp: number, le: number, te: number, rev = false) => {
  const c = le - te, h = FIN.t / 2, base = [FIN.x + sp * dir[0], 0, FIN.z + sp * dir[2]];
  let uv = [[0, 0.55 * h], [40, h], [c / 2, h], [c - 40, h], [c, 0.55 * h], [c, -0.55 * h], [c - 40, -h], [c / 2, -h], [40, -h], [0, -0.55 * h]];
  if (rev) uv = uv.reverse();
  return { toolName: "plasticity_create_control_point_curve", arguments: { closed: true, pointsMm: uv.map(([u, v]) => [r(base[0] + v * nrm[0]), r(le - u), r(base[2] + v * nrm[2])]) } };
};
try {
  for (const [label, loft] of [["natural", { curvature: "natural" }], ["default", {}], ["no-simplify", { simplify: false }], ["clamped", { curvature: "clamped" }]] as const) {
    try {
      const out = await s.raw("plasticity_batch", { undoOnError: true, steps: [sec(-120, -1200, -5200), sec(1360, -5040, -6240),
        { toolName: "plasticity_loft_curves", arguments: { profileIds: ["$0.added[0]", "$1.added[0]"], ...loft } }] });
      console.log(label, "OK", JSON.stringify(out.steps[2].addedBodies?.map((b: any) => [b.type, b.faceCount])));
      const st = await s.raw("plasticity_status", { bodyLimit: 200 });
      await s.raw("plasticity_delete", { ids: out.steps.flatMap((x: any) => x.added), revision: st.revision });
      break;
    } catch (e) { console.log(label, "FAIL", String(e).match(/error `?\d+`?|failed[^"]{0,80}/)?.[0]); }
  }
} finally { await s.close(); }
