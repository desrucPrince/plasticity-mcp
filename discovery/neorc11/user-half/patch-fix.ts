// The blue patch by the gyro is the filled region of the user's closed construction curve Polyline.001 (a planar
// profile at X 2150 along the buttress). Shots before/after hiding it (hidden, not deleted), in the face-direction and
// zebra matcaps, then the user's shading is restored.
import { readdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { discoverPlasticityTargets } from "../../../src/cdp/discovery.ts";
import { CdpClient } from "../../../src/cdp/client.ts";
import { PlasticityRuntime } from "../../../src/plasticity/runtime.ts";
import { openSession } from "../../mcp-client.ts";
const out = resolve("discovery/neorc11/review-final/fixes");
const s = await openSession();
const call = (t: string, a: Record<string, unknown> = {}) => s.raw("plasticity_call", { toolName: t, arguments: a });
const [target] = await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
const cdp = await CdpClient.connect(target!.webSocketDebuggerUrl);
const rt = await PlasticityRuntime.connect(target!);
const matcap = async (img: string) => { await cdp.send("Runtime.evaluate", { expression: `(() => { const im = [...document.querySelectorAll('img')].find(i => (i.getAttribute('src') || '').endsWith('${img}.png')); im?.closest('button')?.click(); })()` }); await new Promise((r) => setTimeout(r, 700)); };
const shot = async (name: string) => {
  await call("plasticity_set_camera", { eyeMm: [8500, -9500, 7500], targetMm: [1900, -2700, 3450], frameRadiusMm: 2200 });
  await new Promise((r) => setTimeout(r, 1300));
  await s.raw("plasticity_screenshot", { path: resolve(out, `${name}.tmp.png`) });
  const made = (await readdir(out)).find((f) => f.startsWith(`${name}.tmp`));
  if (made) await rename(resolve(out, made), resolve(out, `${name}.png`));
};
try {
  await rt.read(`async function () { globalThis.__mcpShadingMemento = this.shading.saveToMemento(); return true; }`);
  const first = await s.raw("plasticity_status", { bodyLimit: 200 }); const all = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await s.raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  const poly = all.find((b) => b.name === "Polyline.001" && b.type === "Wire");
  const regions = (first.regions ?? []).length;
  console.log("Polyline.001", poly?.id, JSON.stringify(poly?.boundsMm), "visible", poly?.visible, "regions in doc", regions);
  await matcap("reflection_check_horizontal"); await shot("fix-00-patch-before");
  await matcap("face-direction"); await shot("fix-00b-patch-before-facedir");
  if (poly && poly.visible !== false) await call("plasticity_set_visibility", { bodyIds: [poly.id], visible: false, revision: (await s.raw("plasticity_status", { bodyLimit: 1 })).revision });
  await matcap("reflection_check_horizontal"); await shot("fix-03-patch-after");
  await matcap("face-direction"); await shot("fix-03b-patch-after-facedir");
} finally {
  await rt.read(`async function () { if (globalThis.__mcpShadingMemento) this.shading.restoreFromMemento(globalThis.__mcpShadingMemento); for (const v of this.viewports) v.setNeedsRender?.(); return true; }`);
  rt.close(); cdp.close(); await s.close();
}
