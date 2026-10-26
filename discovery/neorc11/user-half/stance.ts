// Checks and screenshots after the +800 mm stance raise (belly Z 2040): ship heights, belly height over the walk-under
// scale figure (probe rod intersected with the hull, hull kept), mirror instances still exact X reflections, faces of
// the gear/hatch parts coplanar with the hull, validity; normal and zebra matcap checks and five stance shots, then
// the user's shading is restored.
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { discoverPlasticityTargets } from "../../../src/cdp/discovery.ts";
import { CdpClient } from "../../../src/cdp/client.ts";
import { PlasticityRuntime } from "../../../src/plasticity/runtime.ts";
import { openSession } from "../../mcp-client.ts";
const out = resolve("discovery/neorc11/stance");
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
  report.heights = { bellyZ: 2040, hullLowestZ: r1(Math.min(...hf.map((f) => f.boundsMm.min[2]))), shipLowestZ: r1(shipLow), lowestPart: lowest?.name, hullRoofZ: r1(Math.max(...hf.map((f) => f.boundsMm.max[2]))), overallTopZ: r1(shipTop) };
  // ---- belly above the walk-under figure (instance at X -1000, Y 2000): probe rod ∩ hull (hull kept)
  const probeAt = async (x: number, y: number) => {
    const p = (await raw("plasticity_batch", { steps: [{ toolName: "plasticity_create_cylinder", arguments: { centerMm: [x, y, 1500], radiusMm: 3, heightMm: 3000, axis: [0, 0, 1], name: "rc11_tmp_probe" } }] })).steps[0].added[0] as number;
    const pre = new Set((await bodies()).map((b) => b.id));
    await raw("plasticity_boolean", { targetIds: [p], toolIds: [hull.id], operation: "intersection", keepTools: true, revision: await rev() });
    const now = await bodies();
    const res = now.filter((b) => (b.name ?? "").startsWith("rc11_tmp_probe") || (!pre.has(b.id) && b.id !== hull.id));
    const z = Math.min(...res.map((b) => b.boundsMm.min[2]));
    if (res.length) await raw("plasticity_delete", { ids: res.map((b) => b.id), revision: await rev() });
    return z;
  };
  const insts = ((await call("plasticity_list_instances")).instances ?? []) as any[];
  const ref = all.find((b) => b.name === "rc11_ref_human");
  const under = insts.find((i) => i.sourceBodyIds.includes(ref.id) && Math.abs(i.translationMm[0] + 1000) < 1);
  const headTop = ref.boundsMm.max[2] + under.translationMm[2];
  const headXY = [(ref.boundsMm.min[0] + ref.boundsMm.max[0]) / 2 + under.translationMm[0], 2800 + under.translationMm[1]];
  const bellyOver = await probeAt(Math.abs(headXY[0]!), headXY[1]!); // the hull is the +X source; -X is its mirror
  report.walkUnder = { figureHeightMm: r1(ref.boundsMm.max[2] - ref.boundsMm.min[2]), standsAt: headXY.map(r1), headTopZ: r1(headTop), bellyZOverHead: r1(bellyOver), headClearanceMm: r1(bellyOver - headTop) };
  console.log(JSON.stringify(report));
  // ---- mirrors: every -X instance must be a pure X reflection (no X shift, no rotation) so pairs match exactly
  const mirrors = insts.filter((i) => i.scale[0] < 0);
  const bad = mirrors.filter((i) => Math.abs(i.translationMm[0]) > 0.01 || Math.abs(i.scale[1] - 1) > 1e-9 || Math.abs(i.scale[2] - 1) > 1e-9 || Math.abs(i.rotationQuaternion[3]) < 1 - 1e-9);
  report.mirrors = { mirroredInstances: mirrors.length, notPureReflection: bad.map((i) => `${i.targetName}#${i.id}`) };
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
  const belly = { eyeMm: [6500, 9500, -1500], targetMm: [0, 800, 1700], frameRadiusMm: 7000 };
  await matcap("color_matcap");
  await shot("check-normal-belly", belly);
  await matcap("reflection_check_horizontal");
  await shot("check-zebra-belly", belly);
  await matcap("ceramic_dark");
  await shot("stance-01-side", "right");
  await shot("stance-02-front34-low", { eyeMm: [-10000, 17500, 700], targetMm: [0, 500, 2000], frameRadiusMm: 9000 });
  await shot("stance-03-walkunder", { eyeMm: [-5600, -2600, 1000], targetMm: [-900, 2200, 1400], frameRadiusMm: 2700 });
  await shot("stance-04-leg", { eyeMm: [5600, 7000, 1100], targetMm: [1600, 4100, 1150], frameRadiusMm: 1700 });
  await shot("stance-05-lift", { eyeMm: [3600, -1600, 800], targetMm: [0, 2800, 1300], frameRadiusMm: 2600 });
} finally {
  await rt.read(`async function () { if (globalThis.__mcpShadingMemento) this.shading.restoreFromMemento(globalThis.__mcpShadingMemento); for (const v of this.viewports) v.setNeedsRender?.(); return true; }`);
  await writeFile(resolve(out, "stance-report.json"), JSON.stringify(report, null, 1));
  rt.close(); cdp.close(); await s.close();
}
