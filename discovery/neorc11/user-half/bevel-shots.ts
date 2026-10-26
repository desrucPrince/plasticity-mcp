// Bevel-pass checks (copied from stance.ts): coplanar scan, validity and zebra close-ups; was: checks after the +800 mm stance raise (belly Z 2040): ship heights, belly height over the walk-under
// scale figure (probe rod intersected with the hull, hull kept), mirror instances still exact X reflections, faces of
// the gear/hatch parts coplanar with the hull, validity; normal and zebra matcap checks and five stance shots, then
// the user's shading is restored.
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { discoverPlasticityTargets } from "../../../src/cdp/discovery.ts";
import { CdpClient } from "../../../src/cdp/client.ts";
import { PlasticityRuntime } from "../../../src/plasticity/runtime.ts";
import { openSession } from "../../mcp-client.ts";
const out = resolve("discovery/neorc11/bevel");
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
const faces = async (id: number) => (await raw("plasticity_body_info", { id })).body.faces as any[];
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
const r1 = (v: number) => Math.round(v * 10) / 10;
const report: Record<string, unknown> = {};
try {
  await rt.read(`async function () { globalThis.__mcpShadingMemento = this.shading.saveToMemento(); return true; }`);
  let all = await bodies();
  const stale = all.filter((b) => (b.name ?? "").startsWith("rc11_tmp_probe")).map((b) => b.id);
  if (stale.length) { await raw("plasticity_delete", { ids: stale, revision: await rev() }); all = await bodies(); }
  const hull = all.find((b) => b.name === "rc11_hull");
  const hf = await faces(hull.id);
  const ship = all.filter((b) => b.visible !== false && b.type !== "Wire" && !/^rc11_(lg|hatch|ref)_/.test(b.name ?? ""));
  const shipTop = Math.max(...ship.filter((b) => b.id !== hull.id).map((b) => b.boundsMm.max[2]), ...hf.map((f) => f.boundsMm.max[2]));
  const shipLow = Math.min(...ship.filter((b) => b.id !== hull.id).map((b) => b.boundsMm.min[2]), ...hf.map((f) => f.boundsMm.min[2]));
  const lowest = ship.filter((b) => b.id !== hull.id).sort((a, b) => a.boundsMm.min[2] - b.boundsMm.min[2])[0];
  // ---- coplanar scan: gear/hatch planar faces against the hull's planar faces
  all = await bodies();
  const hp = (await faces(hull.id)).filter((f) => f.planar);
  const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const hits: string[] = [];
  for (const b of all.filter((x) => /^rc11_(lg|hatch)_/.test(x.name ?? "") && x.visible !== false)) {
    for (const f of (await faces(b.id)).filter((x) => x.planar)) for (const h of hp) {
      if (Math.abs(dot(f.normal, h.normal)) < 0.9999) continue;
      if (Math.abs(dot(h.normal, [f.centerMm[0] - h.centerMm[0], f.centerMm[1] - h.centerMm[1], f.centerMm[2] - h.centerMm[2]])) > 0.05) continue;
      if (![0, 1, 2].every((i) => f.boundsMm.min[i] < h.boundsMm.max[i] - 0.05 && h.boundsMm.min[i] < f.boundsMm.max[i] - 0.05)) continue;
      hits.push(`${b.name}#${b.id} face ${f.id} ~ hull face ${h.id}`);
    }
  }
  report.coplanarWithHull = hits;
  const solids = all.filter((b) => b.type === "Solid" && b.visible !== false);
  const v = await call("plasticity_validate_bodies", { ids: solids.map((b) => b.id), revision: await rev() });
  const rows = (v.bodies ?? []) as any[];
  report.validity = { valid: rows.filter((x) => x.closed && x.nativeValid).length, of: rows.length, invalid: rows.filter((x) => !x.closed || !x.nativeValid).map((x) => `${x.name}#${x.id}`) };
  report.feet = all.filter((b) => (b.name ?? "").startsWith("rc11_lg_foot")).map((b) => r1(b.boundsMm.min[2]));
  console.log(JSON.stringify(report, null, 1));
  // ---- screenshots
  await matcap("color_matcap");
  await shot("check-normal-belly", { eyeMm: [6500, 9500, -1500], targetMm: [0, 800, 1700], frameRadiusMm: 7000 });
  await matcap("reflection_check_horizontal");
  await shot("bevel-01-leg", { eyeMm: [3600, 6200, 1500], targetMm: [1600, 4150, 1900], frameRadiusMm: 700 });
  await shot("bevel-02-foot", { eyeMm: [2900, 5600, 500], targetMm: [1600, 4400, 200], frameRadiusMm: 650 });
  await shot("bevel-03-doors", { eyeMm: [4200, 6800, 900], targetMm: [1600, 3600, 1850], frameRadiusMm: 1300 });
  await shot("bevel-04-lift", { eyeMm: [2600, -300, 700], targetMm: [300, 2600, 600], frameRadiusMm: 1300 });
  await shot("bevel-05-hatch", { eyeMm: [1400, 600, 600], targetMm: [300, 2600, 2040], frameRadiusMm: 1500 });
  await matcap("ceramic_dark");
} finally {
  await rt.read(`async function () { if (globalThis.__mcpShadingMemento) this.shading.restoreFromMemento(globalThis.__mcpShadingMemento); for (const v of this.viewports) v.setNeedsRender?.(); return true; }`);
  await writeFile(resolve(out, "bevel-check.json"), JSON.stringify(report, null, 1));
  rt.close(); cdp.close(); await s.close();
}
