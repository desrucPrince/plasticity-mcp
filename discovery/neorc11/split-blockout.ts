// Step B: keep only the +X half of the working blockout copy: boolean-subtract an X<0 box from slab 6 and
// cabin 9, and delete the -X pod copy 7. (split_solid_by_plane refused: its 1e-8 volume check fails on this
// imported OCC slab by 5e-6 relative.)
import { openSession } from "../mcp-client.ts";
const s = await openSession();
try {
  const out = await s.raw("plasticity_batch", { undoOnError: true, steps: [
    { toolName: "plasticity_create_box", arguments: { originMm: [-6000, -10000, 0], sizeMm: [6000, 20000, 6000], name: "cutter" } },
    { toolName: "plasticity_boolean", arguments: { targetIds: [6, 9], toolIds: ["$0.addedSolids[0]"], operation: "difference" } },
    { toolName: "plasticity_delete", arguments: { ids: [7] } },
  ] });
  console.log(JSON.stringify(out.steps.map((x: any) => ({ t: x.toolName, added: x.added, removed: x.removed }))));
} finally { await s.close(); }
