// Link test for the mirrored instances: end-on shot, move source pod 8 up 500 mm, shot, undo, shot.
import { openSession } from "../mcp-client.ts";
const s = await openSession();
const dir = process.cwd() + "/discovery/neorc11/";
try {
  const call = (toolName: string, args: Record<string, unknown>) => s.raw("plasticity_call", { toolName, arguments: args });
  let st = await s.raw("plasticity_status", { bodyLimit: 200 });
  st = await call("plasticity_set_view", { view: "front", fit: true, revision: st.revision }).catch(async (e: any) => { console.log(String(e).slice(0, 300)); return s.raw("plasticity_status", { bodyLimit: 200 }); });
  await new Promise((r) => setTimeout(r, 800));
  await s.raw("plasticity_screenshot", { path: dir + "link-test-1-before.png" });
  st = await s.raw("plasticity_status", { bodyLimit: 200 });
  await s.raw("plasticity_move", { ids: [8], deltaMm: [0, 0, 500], revision: st.revision });
  await new Promise((r) => setTimeout(r, 800));
  await s.raw("plasticity_screenshot", { path: dir + "link-test-2-moved.png" });
  st = await s.raw("plasticity_status", { bodyLimit: 200 });
  await s.raw("plasticity_undo", { revision: st.revision });
  await new Promise((r) => setTimeout(r, 800));
  await s.raw("plasticity_screenshot", { path: dir + "link-test-3-undone.png" });
  st = await s.raw("plasticity_status", { bodyLimit: 200 });
  console.log("pod 8 after undo", JSON.stringify(st.bodies.find((b: any) => b.id === 8).boundsMm));
} finally { await s.close(); }
