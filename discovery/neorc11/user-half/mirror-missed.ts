// Finds visible non-gyro bodies with no mirrored instance whose exact faces lie at X >= 0 (body bounds can be loose,
// e.g. -54 mm on the split hull), gives each a mirrored instance, and files them under EDIT SIDE / MIRROR (don't edit).
import { openSession } from "../../mcp-client.ts";
const s = await openSession();
const raw = (n: string, a: Record<string, unknown> = {}) => s.raw(n, a);
const call = (t: string, a: Record<string, unknown> = {}) => raw("plasticity_call", { toolName: t, arguments: a });
const rev = async () => (await raw("plasticity_status", { bodyLimit: 1 })).revision as string;
try {
  const first = await raw("plasticity_status", { bodyLimit: 200 }); const all = [...first.bodies];
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  const inst = (await call("plasticity_list_instances")).instances ?? [];
  const linked = new Set(inst.flatMap((i: any) => i.sourceBodyIds));
  const groups = (await call("plasticity_list_groups")).groups ?? [];
  const edit = groups.find((g: any) => g.name === "EDIT SIDE"), mirror = groups.find((g: any) => g.name === "MIRROR (don't edit)");
  const candidates = all.filter((b) => b.visible !== false && b.type !== "Wire" && !(b.name ?? "").startsWith("rc11_Gyro") && !linked.has(b.id));
  const fixed: string[] = [], skipped: string[] = [];
  for (const b of candidates) {
    const faces = (await raw("plasticity_body_info", { id: b.id })).body.faces as any[];
    const minX = Math.min(...faces.map((f) => f.boundsMm.min[0]));
    if (minX < -1e-3) { skipped.push(`${b.name}#${b.id} (faces reach X ${minX.toFixed(1)})`); continue; }
    const before = new Set(((await call("plasticity_list_instances")).instances ?? []).map((i: any) => i.id));
    await call("plasticity_create_mirrored_instance", { bodyId: b.id, axis: "x", planeOffsetMm: 0, revision: await rev() });
    const id = ((await call("plasticity_list_instances")).instances ?? []).find((i: any) => !before.has(i.id)).id;
    await call("plasticity_move_to_group", { bodyIds: [b.id], destinationGroupId: edit.id, revision: await rev() });
    await call("plasticity_move_to_group", { instanceIds: [id], destinationGroupId: mirror.id, revision: await rev() });
    fixed.push(`${b.name}#${b.id}`);
  }
  console.log("mirrored now:", fixed.join(", ") || "none");
  console.log("left alone:", skipped.join(", ") || "none");
  console.log("instances total:", ((await call("plasticity_list_instances")).instances ?? []).length);
} finally { await s.close(); }
