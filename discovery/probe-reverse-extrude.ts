// Maps extrude_regions reverse-distance results on one region, undoing each case. Edits only temporarily.
// Usage: PLASTICITY_CDP_URL=... node discovery/probe-reverse-extrude.ts <regionId>
import { discoverPlasticityTargets } from "../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../src/plasticity/runtime.ts";
import { PlasticityOperations } from "../src/plasticity/operations.ts";
const [target] = await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
const runtime = await PlasticityRuntime.connect(target!);
const ops = new PlasticityOperations(runtime);
const region = process.argv[2]!;
try {
  for (const [d, r] of [[2, 1.5], [10, 4], [2, 3], [10, 1.5], [5, 5], [3, 0.5]] as const) {
    const before = await ops.state();
    const after = await ops.extrudeRegions([region], d, before.revision, { reverseDistanceMm: r });
    const body = after.bodies.find((b) => !before.bodies.some((o) => o.id === b.id))!;
    console.log(JSON.stringify({ distance: d, reverse: r, z: [body.boundsMm!.min[2], body.boundsMm!.max[2]] }));
    await ops.undo(after.revision);
  }
} finally { runtime.close(); }
