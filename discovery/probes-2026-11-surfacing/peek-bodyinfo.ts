// Read-only: show the shape of plasticity_body_info for one body. usage: node peek-bodyinfo.ts id
import { startMcp, call } from "./mcp.ts";
const client = await startMcp();
const r = await call(client, "plasticity_body_info", { id: Number(process.argv[2] ?? 5) });
console.log(JSON.stringify(r, null, 1).slice(0, 5000));
await client.close(); process.exit(0);
