// Build one fixture through MCP, run a renderer .js file against it (read-only, this = editor), save, undo back.
// usage: node with-fixture.ts <round|g2|wedge> file.js bindingA,bindingB outName.json [extraJsonArgs]
// The .js receives one args object: { bodyId, edgeId, faceIds, ...extra }. edgeId is the tangent (or 30 degree) edge.
import { connect, save, errText, nativeFunction } from "./harness.ts";
import { startMcp, status, undoTo } from "./mcp.ts";
import { filletedBox, wedge30, info, edgeBetween, faceNormal, nonPlanar } from "./fixtures.ts";
import { readFileSync } from "node:fs";

const [kind, file, bindingList, outName, extraJson] = process.argv.slice(2);
const client = await startMcp();
const runtime = await connect();
const start = await status(client);
const out: any = { kind, file, startUndo: start.undoDepth };
try {
  let bodyId: number, edges;
  if (kind === "wedge") {
    bodyId = (await wedge30(client, 5000)).solidId;
    const s = Math.sin(Math.PI / 6), c = Math.cos(Math.PI / 6);
    edges = edgeBetween(await info(client, bodyId), faceNormal([0, -1, 0]), faceNormal([s, -c, 0]));
  } else {
    bodyId = (await filletedBox(client, [5100, 0, 0], 5, kind as "round" | "g2")).solidId;
    edges = edgeBetween(await info(client, bodyId), nonPlanar, (f) => f.planar && Math.abs((f.normal?.[0] ?? 0) - 1) < 1e-6);
  }
  out.edge = edges[0];
  const args = { bodyId, edgeId: edges[0]!.id, faceIds: edges[0]!.faceIds, ...(extraJson ? JSON.parse(extraJson) : {}) };
  out.result = await runtime.readNative<unknown>(nativeFunction([readFileSync(file!, "utf8")] as any), bindingList ? bindingList.split(",").filter(Boolean) : [], [args], 60000);
} catch (e) {
  out.error = errText(e);
} finally {
  await undoTo(client, start.undoDepth);
  out.endUndo = (await status(client)).undoDepth;
  save(outName!, out);
  runtime.close(); await client.close();
}
process.exit(0);
