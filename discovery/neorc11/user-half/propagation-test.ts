// Does a geometry edit on an instance source reach its mirrored instance? A scratch box 40 m ahead of the model gets a
// mirrored instance; the box then gets a fillet and a boolean hole. The instance's link is read back and both are
// screenshotted. Everything made here is deleted at the end.
import { resolve } from "node:path";
import { openSession } from "../../mcp-client.ts";
const s = await openSession();
const raw = (n: string, a: Record<string, unknown> = {}) => s.raw(n, a);
const call = (t: string, a: Record<string, unknown> = {}) => raw("plasticity_call", { toolName: t, arguments: a });
const rev = async () => (await raw("plasticity_status", { bodyLimit: 1 })).revision as string;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const made: number[] = []; let inst: number | undefined;
try {
  const box = (await raw("plasticity_batch", { steps: [{ toolName: "plasticity_create_box", arguments: { originMm: [200, 40000, 0], sizeMm: [400, 400, 400], name: "propagation-test" } }] })).steps[0].added[0] as number;
  made.push(box);
  const before = new Set(((await call("plasticity_list_instances")).instances ?? []).map((i: any) => i.id));
  await call("plasticity_create_mirrored_instance", { bodyId: box, axis: "x", planeOffsetMm: 0, revision: await rev() });
  inst = ((await call("plasticity_list_instances")).instances ?? []).find((i: any) => !before.has(i.id)).id;
  const top = ((await raw("plasticity_body_info", { id: box })).body.edges as any[]).filter((e) => e.boundsMm.min[2] > 399).map((e) => e.id);
  await raw("plasticity_fillet", { id: box, edgeIds: top, radiusMm: 60, revision: await rev() });
  const hole = (await raw("plasticity_batch", { steps: [{ toolName: "plasticity_create_cylinder", arguments: { centerMm: [400, 40200, -10], radiusMm: 80, heightMm: 500, name: "propagation-hole" } }] })).steps[0].added[0] as number;
  await raw("plasticity_boolean", { targetIds: [box], toolIds: [hole], operation: "difference", revision: await rev() });
  const link = ((await call("plasticity_list_instances")).instances ?? []).find((i: any) => i.id === inst);
  console.log("instance after edits:", JSON.stringify({ sourceBodyIds: link?.sourceBodyIds, scale: link?.scale }));
  await call("plasticity_set_camera", { eyeMm: [0, 37600, 2600], targetMm: [0, 40200, 200], frameRadiusMm: 900 });
  await pause(1200);
  await raw("plasticity_screenshot", { path: resolve(`discovery/neorc11/user-half/review-v10/propagation-test-${Date.now()}.png`) });
} finally {
  if (inst !== undefined) await call("plasticity_delete_instances", { ids: [inst], revision: await rev() }).catch(() => {});
  const all = (await raw("plasticity_status", { bodyLimit: 200 })).bodies as any[];
  const first = await raw("plasticity_status", { bodyLimit: 200 }); const bodies = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); bodies.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  const scratch = bodies.filter((b) => /^propagation-/.test(b.name ?? "")).map((b) => b.id);
  if (scratch.length) await raw("plasticity_delete", { ids: scratch, revision: await rev() });
  console.log("scratch removed:", scratch.length, "(of", all.length, "first-page bodies read)");
  await s.close();
}
