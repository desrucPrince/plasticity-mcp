// Cleanup: cancel any active command, clear selection, undo through MCP to the given depth (default 0).
import { connect, nativeFunction } from "./harness.ts";
import { startMcp, status, undoTo } from "./mcp.ts";
import { readFileSync } from "node:fs";
const runtime = await connect();
console.log(JSON.stringify(await runtime.mutate(nativeFunction([readFileSync(new URL("./js/cancel-active.js", import.meta.url), "utf8")] as any), [], [], 20000)));
runtime.close();
const client = await startMcp();
await undoTo(client, Number(process.argv[2] ?? 0));
const st = await status(client);
console.log(JSON.stringify({ undoDepth: st.undoDepth, bodies: (st.bodies as any[]).map((b) => b.id) }));
await client.close(); process.exit(0);
