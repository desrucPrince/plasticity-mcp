// Finishing pass for the lift rebuild (landing-gear.ts): scans the new gear/lift parts for faces coplanar with the
// hull and takes the lift screenshots (normal and zebra matcaps for checking, the user's shading restored afterwards).
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { discoverPlasticityTargets } from "../../../src/cdp/discovery.ts";
import { CdpClient } from "../../../src/cdp/client.ts";
import { PlasticityRuntime } from "../../../src/plasticity/runtime.ts";
import { openSession } from "../../mcp-client.ts";
const out = resolve("discovery/neorc11/lift");
await mkdir(out, { recursive: true });
const s = await openSession();
const raw = (n: string, a: Record<string, unknown> = {}) => s.raw(n, a);
const call = (t: string, a: Record<string, unknown> = {}) => raw("plasticity_call", { toolName: t, arguments: a });
const rev = async () => (await raw("plasticity_status", { bodyLimit: 1 })).revision as string;
async function bodies(): Promise<any[]> {
  const first = await raw("plasticity_status", { bodyLimit: 200 }); const all = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  return all;
}
const [target] = await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
const cdp = await CdpClient.connect(target!.webSocketDebuggerUrl);
const rt = await PlasticityRuntime.connect(target!);
const matcap = async (img: string) => { await cdp.send("Runtime.evaluate", { expression: `(() => { const im = [...document.querySelectorAll('img')].find(i => (i.getAttribute('src') || '').endsWith('${img}.png')); im?.closest('button')?.click(); })()` }); await new Promise((r) => setTimeout(r, 700)); };
async function shot(name: string, aim: Record<string, unknown> | string) {
  if (typeof aim === "string") await call("plasticity_set_view", { view: aim, fit: true }); else await call("plasticity_set_camera", aim);
  await new Promise((r) => setTimeout(r, 1300));
  await raw("plasticity_screenshot", { path: resolve(out, `${name}.tmp.png`) });
  const made = (await readdir(out)).find((f) => f.startsWith(`${name}.tmp`));
  if (made) await rename(resolve(out, made), resolve(out, `${name}.png`));
}
const report: Record<string, unknown> = {};
try {
  await rt.read(`async function () { globalThis.__mcpShadingMemento = this.shading.saveToMemento(); return true; }`);
  const all = await bodies();
  // ---- coplanar scan: new parts' planar faces against the hull's planar faces
  const hull = all.find((b) => b.name === "rc11_hull");
  const hf = ((await raw("plasticity_body_info", { id: hull.id })).body.faces as any[]).filter((f) => f.planar);
  const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const hits: string[] = [];
  for (const b of all.filter((x) => /^rc11_(lg|hatch)_/.test(x.name ?? "") && x.visible !== false)) {
    for (const f of ((await raw("plasticity_body_info", { id: b.id })).body.faces as any[]).filter((x) => x.planar)) {
      for (const h of hf) {
        if (Math.abs(dot(f.normal, h.normal)) < 0.9999) continue;
        if (Math.abs(dot(h.normal, [f.centerMm[0] - h.centerMm[0], f.centerMm[1] - h.centerMm[1], f.centerMm[2] - h.centerMm[2]])) > 0.05) continue;
        if (![0, 1, 2].every((i) => f.boundsMm.min[i] < h.boundsMm.max[i] - 0.05 && h.boundsMm.min[i] < f.boundsMm.max[i] - 0.05)) continue;
        hits.push(`${b.name}#${b.id} face ${f.id} ~ hull face ${h.id} (normals ${dot(f.normal, h.normal) > 0 ? "same" : "opposite"}, centre ${f.centerMm.map(Math.round)})`);
      }
    }
  }
  report.coplanarWithHull = hits;
  console.log(JSON.stringify(report, null, 1));
  // ---- screenshots
  await matcap("color_matcap");
  await shot("check-normal-belly", { eyeMm: [6000, 9000, -2500], targetMm: [0, 800, 900], frameRadiusMm: 6500 });
  await matcap("reflection_check_horizontal");
  await shot("check-zebra-belly", { eyeMm: [6000, 9000, -2500], targetMm: [0, 800, 900], frameRadiusMm: 6500 });
  await matcap("ceramic_dark");
  await shot("lift-01-front34-low", { eyeMm: [-9000, 19000, 700], targetMm: [-500, 2500, 1300], frameRadiusMm: 9000 });
  await shot("lift-02-side", "right");
  await shot("lift-03-lift", { eyeMm: [-3200, -800, 900], targetMm: [0, 2800, 900], frameRadiusMm: 1700 });
  await shot("lift-04-leg", { eyeMm: [5400, 7200, 500], targetMm: [1600, 4000, 850], frameRadiusMm: 1450 });
  await shot("lift-05-belly", "bottom");
  await shot("lift-06-shaft", { eyeMm: [150, 2050, 1900], targetMm: [0, 3000, 3400], frameRadiusMm: 900 });
} finally {
  await rt.read(`async function () { if (globalThis.__mcpShadingMemento) this.shading.restoreFromMemento(globalThis.__mcpShadingMemento); for (const v of this.viewports) v.setNeedsRender?.(); return true; }`);
  await writeFile(resolve(out, "finish-report.json"), JSON.stringify(report, null, 1));
  rt.close(); cdp.close(); await s.close();
}
