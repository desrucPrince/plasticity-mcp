// Creates the 20x10x5 mm test box at x=2000 via MCP and records body/face ids in box.json.
import { mcp, save } from "./harness.ts";
const session = await mcp();
const st = await session.raw("plasticity_status", { bodyLimit: 50 });
const origin = JSON.parse(process.argv[2] ?? "[2000,0,0]");
const size = JSON.parse(process.argv[3] ?? "[20,10,5]");
const r = await session.raw("plasticity_create_box", { originMm: origin, sizeMm: size, revision: st.revision });
const st2 = await session.raw("plasticity_status", { bodyLimit: 50 });
const box = st2.bodies.find((b: any) => !st.bodies.some((o: any) => o.id === b.id));
const info = (await session.raw("plasticity_body_info", { id: box.id })).body;
const faces = info.faces.map((f: any) => ({ id: f.id, normal: f.normal, centroid: f.centroidMm ?? f.centerMm ?? f.pointMm }));
const out = { before: { undo: st.undoDepth, bodies: st.bodies.length }, after: { undo: st2.undoDepth, bodies: st2.bodies.length }, box: { id: box.id, boundsMm: box.boundsMm }, faces, faceKeys: Object.keys(info.faces[0]) };
console.log(JSON.stringify(out));
save(process.argv[4] ?? "box.json", out);
await session.close();
process.exit(0);
