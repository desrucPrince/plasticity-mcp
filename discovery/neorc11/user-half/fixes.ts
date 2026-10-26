// Must-fix and anti-flicker pass on the user's finished build (open doc), plus matcap verification shots.
// 1. Louvres: delete the 7 loose -X slats, mirror the user's 8 +X slats (EDIT SIDE / MIRROR groups).
// 2. Pod trim: name the new +X trim rc11_pod_trim and mirror it.
// 3. Roof sheet "Face sheet.001": it lies on the hull roof (0..1 mm over most of it, 2..5 mm under toward the rear,
//    ~50 mm under at its edges), which z-fights and shows its blue back face where it dips. It is hidden with its
//    mirror (kept in the document, not deleted); the hull's own closed roof is the visible, exported surface.
// 4. Duplicate stacked drive vanes (#313 on #278, #306 on #279): the straight-run copies and their mirrors go.
// 5. Screenshots in the normal, zebra, face-direction and default matcaps, then the user's shading is restored.
// Usage: PLASTICITY_CDP_URL=http://127.0.0.1:9223 node discovery/neorc11/user-half/fixes.ts [--shots-only]
import { mkdir, readdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { discoverPlasticityTargets } from "../../../src/cdp/discovery.ts";
import { CdpClient } from "../../../src/cdp/client.ts";
import { openSession } from "../../mcp-client.ts";

const out = resolve("discovery/neorc11/review-final/fixes");
await mkdir(out, { recursive: true });
const shotsOnly = process.argv.includes("--shots-only");
const s = await openSession();
const raw = (n: string, a: Record<string, unknown> = {}) => s.raw(n, a);
const call = (t: string, a: Record<string, unknown> = {}) => raw("plasticity_call", { toolName: t, arguments: a });
const rev = async () => (await raw("plasticity_status", { bodyLimit: 1 })).revision as string;
async function bodies(): Promise<any[]> {
  const first = await raw("plasticity_status", { bodyLimit: 200 }); const all = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  return all;
}
const instances = async () => ((await call("plasticity_list_instances")).instances ?? []) as Array<{ id: number; sourceBodyIds: number[]; scale: number[] }>;
const groupId = async (name: string) => (((await call("plasticity_list_groups")).groups ?? []) as any[]).find((g) => g.name === name)?.id as number;
const [target] = await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
const cdp = await CdpClient.connect(target!.webSocketDebuggerUrl);
const page = async (expression: string) => ((await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as any).result?.value;
// Matcap buttons are identified by their thumbnail image; the user's shading is saved once and restored at the end.
const matcap = async (img: string) => {
  const ok = await page(`(() => { const im = [...document.querySelectorAll('img')].find(i => (i.getAttribute('src') || '').endsWith('${img}.png')); const b = im?.closest('button'); if (!b) return false; b.click(); return true; })()`);
  if (!ok) throw new Error(`matcap button ${img} not found`);
  await new Promise((r) => setTimeout(r, 700));
};
const notes: string[] = [];
const say = (...x: unknown[]) => { const t = x.map(String).join(" "); notes.push(t); console.log(t); };
async function shot(name: string, aim: Record<string, unknown> | string) {
  if (typeof aim === "string") await call("plasticity_set_view", { view: aim, fit: true }); else await call("plasticity_set_camera", aim);
  await new Promise((r) => setTimeout(r, 1300));
  await raw("plasticity_screenshot", { path: resolve(out, `${name}.tmp.png`) });
  const made = (await readdir(out)).find((f) => f.startsWith(`${name}.tmp`));
  if (made) await rename(resolve(out, made), resolve(out, `${name}.png`));
}
const PATCH = { eyeMm: [5200, -6200, 6400], targetMm: [1500, -1500, 3950], frameRadiusMm: 1500 };

try {
  // Save the user's shading through the editor object the runtime uses.
  const { PlasticityRuntime } = await import("../../../src/plasticity/runtime.ts");
  const rt = await PlasticityRuntime.connect(target!);
  await rt.read(`async function () { globalThis.__mcpShadingMemento = this.shading.saveToMemento(); return true; }`);
  say("user shading saved");
  if (!shotsOnly) {
    await matcap("face-direction");
    await shot("fix-00-patch-before", PATCH);
    await matcap("reflection_check_horizontal");
    await shot("fix-00b-patch-before-zebra", PATCH);

    const all = await bodies();
    const inst = await instances();
    const edit = await groupId("EDIT SIDE"), mirror = await groupId("MIRROR (don't edit)");
    const mirrorOf = async (ids: number[]) => {
      const before = new Set((await instances()).map((i) => i.id));
      for (const id of ids) await call("plasticity_create_mirrored_instance", { bodyId: id, axis: "x", planeOffsetMm: 0, revision: await rev() });
      const made = (await instances()).filter((i) => !before.has(i.id)).map((i) => i.id);
      await call("plasticity_move_to_group", { bodyIds: ids, destinationGroupId: edit, revision: await rev() });
      await call("plasticity_move_to_group", { instanceIds: made, destinationGroupId: mirror, revision: await rev() });
      return made.length;
    };
    // 1. louvres
    const louvres = all.filter((b) => b.visible !== false && (b.name ?? "").startsWith("rc11_louvre"));
    const negL = louvres.filter((b) => b.boundsMm.max[0] < 0), posL = louvres.filter((b) => b.boundsMm.min[0] > 0);
    if (negL.length) await raw("plasticity_delete", { ids: negL.map((b) => b.id), revision: await rev() });
    const posPlain = posL.filter((b) => !inst.some((i) => i.sourceBodyIds.includes(b.id)));
    say(`louvres: deleted ${negL.length} loose -X slats; mirrored ${await mirrorOf(posPlain.map((b) => b.id))} of ${posL.length} +X slats`);
    // 2. pod trim
    const trim = all.filter((b) => b.visible !== false && b.type === "Solid" && b.name === null && b.boundsMm.min[0] > 3000 && b.boundsMm.max[1] - b.boundsMm.min[1] > 10000 && b.boundsMm.max[2] - b.boundsMm.min[2] < 40);
    for (const t of trim) {
      await call("plasticity_rename", { id: t.id, name: "rc11_pod_trim", revision: await rev() });
      await call("plasticity_set_appearance_material", { ids: [t.id], name: "Chrome", colorHex: "#d9dde2", roughness: 0.08, metalness: 1, opacity: 1, revision: await rev() });
      say(`pod trim #${t.id} renamed rc11_pod_trim, chrome; mirrored ${await mirrorOf([t.id])}`);
    }
    // 3. roof sheet: hide with its mirror
    const sheet = all.find((b) => b.type === "Sheet" && b.visible !== false);
    if (sheet) {
      const sheetInst = (await instances()).filter((i) => i.sourceBodyIds.includes(sheet.id)).map((i) => i.id);
      await call("plasticity_set_visibility", { bodyIds: [sheet.id], instanceIds: sheetInst, visible: false, revision: await rev() });
      say(`roof sheet ${sheet.name}#${sheet.id} and ${sheetInst.length} mirror hidden (kept in the document)`);
    }
    // 4. stacked duplicate vanes: delete the straight-run copy where it sits on a fan source, with its mirror
    const now = await bodies();
    const key = (b: any) => [b.type, ...b.boundsMm.min, ...b.boundsMm.max].map((v: any) => typeof v === "number" ? Math.round(v * 100) : v).join(",");
    const seen = new Map<string, any[]>(); for (const b of now.filter((x) => x.visible !== false)) seen.set(key(b), [...(seen.get(key(b)) ?? []), b]);
    const dupes = [...seen.values()].filter((g) => g.length > 1);
    const drop: number[] = [];
    for (const g of dupes) {
      const keep = g.find((b) => /vane_(front|rear)$/.test(b.name ?? "")) ?? g[0];
      drop.push(...g.filter((b) => b !== keep).map((b) => b.id));
      say(`duplicate stack: keep ${keep.name}#${keep.id}, delete ${g.filter((b) => b !== keep).map((b) => `${b.name}#${b.id}`).join(", ")}`);
    }
    if (drop.length) {
      const di = (await instances()).filter((i) => i.sourceBodyIds.some((x) => drop.includes(x))).map((i) => i.id);
      if (di.length) await call("plasticity_delete_instances", { ids: di, revision: await rev() });
      await raw("plasticity_delete", { ids: drop, revision: await rev() });
      say(`deleted ${drop.length} duplicate bodies and ${di.length} of their mirrors`);
    }
  }
  // 5. verification shots
  await matcap("color_matcap");
  await shot("fix-01-normal-34", { eyeMm: [-11000, 19000, 7000], targetMm: [0, 0, 2800], frameRadiusMm: 9000 });
  await matcap("reflection_check_horizontal");
  await shot("fix-02-zebra-rear34", { eyeMm: [12000, -15000, 13000], targetMm: [0, -1000, 2800], frameRadiusMm: 8500 });
  await matcap("face-direction");
  await shot("fix-03-patch-after", PATCH);
  await matcap("ceramic_dark");
  await shot("fix-04-louvres", "top");
  await shot("fix-05-belly", { eyeMm: [2500, -500, -3000], targetMm: [0, -500, 1300], frameRadiusMm: 2600 });
  await rt.read(`async function () { if (globalThis.__mcpShadingMemento) this.shading.restoreFromMemento(globalThis.__mcpShadingMemento); for (const v of this.viewports) v.setNeedsRender?.(); return true; }`);
  say("user shading restored");
  rt.close();
} finally {
  cdp.close();
  await s.close();
  console.log(JSON.stringify(notes));
}
