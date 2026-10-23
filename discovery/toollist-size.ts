// Prints the compact tools/list size per tool (no Plasticity needed).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCompactServer } from "../src/server.ts";
const server = createCompactServer(undefined, undefined, undefined, undefined, null);
const client = new Client({ name: "size", version: "0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(b); await client.connect(a);
const { tools } = await client.listTools();
const rows = tools.map((tool) => ({ name: tool.name, description: tool.description?.length ?? 0, schema: JSON.stringify(tool.inputSchema).length, total: JSON.stringify(tool).length }));
rows.sort((x, y) => y.total - x.total);
console.log(JSON.stringify({ tools: tools.length, bytes: JSON.stringify({ tools }).length, rows }, null, 1));
await client.close(); await server.close();
