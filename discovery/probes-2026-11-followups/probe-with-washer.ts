// Builds a washer plate (40 x 40 x 5 with a centred r 8 through hole), runs a renderer .js file with { bodyId, ...extra },
// then undoes back to the start. usage: node probe-with-washer.ts js/file.js [jsonExtra] [bindings] [outName]
import { readFileSync } from "node:fs";
import { connect, nativeFunction, save } from "./harness.ts";
import { call, startMcp, status, undoTo } from "./mcp.ts";
const [file, extraJson, bindingList, outName] = process.argv.slice(2);
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
  const r = await runtime.mutate<unknown>(nativeFunction([readFileSync(file!, "utf8")] as any), bindingList ? bindingList.split(",") : [], [{ bodyId: plate.id, faces: body.faces, ...(extraJson ? JSON.parse(extraJson) : {}) }], 30000);
  console.log(JSON.stringify(r, null, 1).slice(0, 30000));
  if (outName) save(outName, r);
} catch (error) { console.error("ERROR", (error as Error).message.slice(0, 3000)); }
finally {
  await undoTo(client, start.undoDepth);
  const end = await status(client);
  console.error("restored", start.undoDepth, start.bodies.length, "->", end.undoDepth, end.bodies.length);
  await client.close(); runtime.close(); process.exit(0);
}
