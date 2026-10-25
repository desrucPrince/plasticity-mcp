// Read-only: lists the open document's bodies, groups and instances, and saves a screenshot.
import { openSession } from "../mcp-client.ts";
const s = await openSession();
try {
  const call = (toolName: string, args: Record<string, unknown> = {}) => s.raw("plasticity_call", { toolName, arguments: args });
  const st = await s.raw("plasticity_status", { bodyLimit: 200 });
  console.log("title", st.title, "undo", st.undoDepth, "bodies", st.bodies.length);
  for (const b of st.bodies) console.log(b.id, b.type, JSON.stringify(b.name), "faces", b.faceCount, b.boundsMm.min.map(Math.round).join(","), "→", b.boundsMm.max.map(Math.round).join(","));
  const g = await call("plasticity_list_groups");
  for (const x of g.groups ?? []) console.log("group", x.id, JSON.stringify(x.name), "parent", x.parentId, "bodies", x.bodyIds.join(","), "inst", x.instanceIds.join(","), x.hidden ? "hidden" : "");
  const i = await call("plasticity_list_instances");
  for (const x of i.instances ?? []) console.log("instance", x.id, "src", x.sourceBodyIds.join(","), "scale", x.scale.join(","), "t", x.translationMm.map(Math.round).join(","));
  const shot = await s.raw("plasticity_screenshot", { path: process.cwd() + `/discovery/neorc11/user-doc-${Date.now()}.png` }).catch((e: unknown) => String(e).slice(0, 200));
  console.log("shot", JSON.stringify(shot).slice(0, 200));
} finally { await s.close(); }
