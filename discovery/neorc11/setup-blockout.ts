// Step A: keep the imported blockout untouched in a hidden "blockout_ref" group; split a working copy at X=0
// and keep only the +X halves. Prints body ids. Run once on the doc holding the 4 imported blockout solids.
import { openSession } from "../mcp-client.ts";
const s = await openSession();
const st = await s.raw("plasticity_status");
const ids = st.bodies.map((b: any) => b.id).sort((a: number, b: number) => a - b);
if (ids.join() !== "2,3,4,5") throw new Error("unexpected bodies " + ids.join());
const dup = await s.raw("plasticity_batch", { undoOnError: true, steps: [
  { toolName: "plasticity_duplicate_bodies", arguments: { ids } },
  { toolName: "plasticity_create_group", arguments: { bodyIds: ids, name: "blockout_ref" } },
  { toolName: "plasticity_set_visibility", arguments: { bodyIds: ids, visible: false } },
] });
console.log(JSON.stringify(dup).slice(0, 2500));
await s.close();
