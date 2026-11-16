// Lists bodies (MCP plasticity_status) and native depth.
import { mcp, connect, depth } from "./harness.ts";
const runtime = await connect();
console.log("native", JSON.stringify(await depth(runtime)));
runtime.close();
const session = await mcp();
const st = await session.raw("plasticity_status", { bodyLimit: 50 });
console.log(JSON.stringify({ revision: st.revision, undoDepth: st.undoDepth, bodies: st.bodies.map((b: any) => ({ id: b.id, type: b.type, name: b.name, boundsMm: b.boundsMm })) }));
await session.close();
process.exit(0);
