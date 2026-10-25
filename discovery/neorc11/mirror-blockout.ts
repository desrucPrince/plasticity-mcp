// Step C: mirrored linked instances of the +X blockout half (instance 4 for body 6 came from the probe), then a
// link test: move source pod 8 up 500 mm, read the instance bounds' source, undo.
import { openSession } from "../mcp-client.ts";
const s = await openSession();
try {
  const call = (toolName: string, args: Record<string, unknown>) => s.raw("plasticity_call", { toolName, arguments: args });
  let st = await s.raw("plasticity_status");
  const have = (await call("plasticity_list_instances", {})).instances as any[];
  const mirrored = new Set(have.filter((i) => i.scale[0] < 0).flatMap((i) => i.sourceBodyIds));
  for (const id of [6, 8, 9]) if (!mirrored.has(id)) st = await call("plasticity_create_mirrored_instance", { bodyId: id, axis: "x", planeOffsetMm: 0, revision: st.revision });
  const inst = (await call("plasticity_list_instances", {})).instances as any[];
  console.log("instances", inst.map((i) => `${i.id}<-${i.sourceBodyIds} scale ${i.scale}`).join("; "));
  st = await s.raw("plasticity_status");
  const moved = await s.raw("plasticity_move", { ids: [8], deltaMm: [0, 0, 500], revision: st.revision });
  console.log("moved src 8", JSON.stringify(moved.change?.modified?.map((m: any) => m.after.boundsMm)));
  const shot = await s.raw("plasticity_screenshot", { path: process.cwd() + "/discovery/neorc11/link-test-moved.png" }).catch((e: any) => String(e).slice(0, 200));
  console.log("shot", JSON.stringify(shot).slice(0, 200));
  st = await s.raw("plasticity_status");
  await s.raw("plasticity_undo", { revision: st.revision });
  st = await s.raw("plasticity_status");
  console.log("after undo pod 8", JSON.stringify(st.bodies.find((b: any) => b.id === 8).boundsMm));
} finally { await s.close(); }
