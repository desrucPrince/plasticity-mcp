// Times MCP server startup, connect and a first status read (read-only).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
let t = performance.now();
const lap = (l: string) => { console.log(l, Math.round(performance.now() - t), "ms"); t = performance.now(); };
const transport = new StdioClientTransport({ command: process.execPath, args: ["scripts/run-server.ts", "--compact-tools"], env: process.env as Record<string, string>, stderr: "inherit" });
const client = new Client({ name: "startup", version: "0" });
await client.connect(transport); lap("spawn+initialize");
await client.listTools(); lap("tools/list");
const w = await client.callTool({ name: "plasticity_list_windows", arguments: {} }); lap("list_windows");
const targetId = JSON.parse((w.content as Array<{ text: string }>)[0]!.text)[0].targetId;
await client.callTool({ name: "plasticity_connect", arguments: { targetId } }); lap("connect");
await client.callTool({ name: "plasticity_status", arguments: {} }); lap("status");
await client.close(); lap("close");
