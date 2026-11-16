// Washer face: which hit point lets DimensionDistanceCommand dimension the top face (single and pair mode).
import { readFileSync } from "node:fs";
import { connect, nativeFunction, save } from "./harness.ts";
import { call, startMcp, status, undoTo } from "./mcp.ts";
const runtime = await connect();
const client = await startMcp();
const start = await status(client);
const add = async (tool: string, args: Record<string, unknown>) => {
  const before = await status(client);
  await call(client, tool, { ...args, revision: before.revision });
  const after = await status(client);
  return after.bodies.filter((body: any) => !before.bodies.some((old: any) => old.id === body.id));
};
try {
  const [plate] = await add("plasticity_create_box", { originMm: [2500, 0, 0], sizeMm: [40, 40, 5] });
  const [hole] = await add("plasticity_create_cylinder", { centerMm: [2520, 20, -1], radiusMm: 8, heightMm: 7 });
  const current = await status(client);
  await call(client, "plasticity_boolean", { targetIds: [plate.id], toolIds: [hole.id], operation: "difference", revision: current.revision });
  const body = (await call(client, "plasticity_body_info", { id: plate.id })).body;
  const top = body.faces.find((f: any) => f.planar && f.normal[2] > 0.999);
  const bottom = body.faces.find((f: any) => f.planar && f.normal[2] < -0.999);
  const trials = [
    { label: "single_mid", faces: [top.id], hit: "mid", distanceM: 0.008 },
    { label: "single_any", faces: [top.id], hit: "any", distanceM: 0.008 },
    { label: "pair_mid", faces: [bottom.id, top.id], hit: "mid", distanceM: 0.008 },
    { label: "pair_any", faces: [bottom.id, top.id], hit: "any", distanceM: 0.008 },
  ];
  const r = await runtime.mutate<any>(nativeFunction([readFileSync("js/washer-ddc.js", "utf8")] as any), ["DimensionDistanceCommand", "DimensionDistanceSpaceDialog"], [{ bodyId: plate.id, trials }], 60000);
  console.log(JSON.stringify(r, null, 1));
  save("probe-washer.json", { top: { id: top.id, centerMm: top.centerMm }, results: r, undoAfterTrials: (await status(client)).undoDepth });
} catch (error) { console.error("ERROR", (error as Error).message.slice(0, 3000)); }
finally {
  await undoTo(client, start.undoDepth);
  const end = await status(client);
  console.error("restored", start.undoDepth, start.bodies.length, "->", end.undoDepth, end.bodies.length);
  await client.close(); runtime.close(); process.exit(0);
}
