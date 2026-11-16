// Creates the generalisation fixtures via MCP: open polyline, closed triangle, cylinder. Writes general-geometry.json.
import { mcp, save } from "./harness.ts";
const session = await mcp();
const added: any = {};
const add = async (label: string, tool: string, args: any) => {
  const st = await session.raw("plasticity_status", { bodyLimit: 200 });
  await session.raw(tool, { ...args, revision: st.revision });
  const st2 = await session.raw("plasticity_status", { bodyLimit: 200 });
  added[label] = st2.bodies.filter((b: any) => !st.bodies.some((o: any) => o.id === b.id)).map((b: any) => ({ id: b.id, type: b.type, name: b.name, boundsMm: b.boundsMm }));
  added[label + "_undo"] = st2.undoDepth;
};
await add("polylineOpen", "plasticity_create_polyline", { pointsMm: [[2100, 0, 0], [2120, 0, 0], [2120, 15, 0]], closed: false });
await add("triangle", "plasticity_create_polyline", { pointsMm: [[2150, 0, 0], [2180, 0, 0], [2160, 20, 0]], closed: true });
await add("cylinder", "plasticity_create_cylinder", { centerMm: [2200, 0, 0], radiusMm: 5, heightMm: 10 });
console.log(JSON.stringify(added));
save("general-geometry.json", added);
await session.close(); process.exit(0);
