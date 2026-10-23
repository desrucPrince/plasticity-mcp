// Prints catalog response sizes for typical lookups (no Plasticity needed).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCompactServer } from "../src/server.ts";
const server = createCompactServer(undefined, undefined, undefined, undefined, null);
const client = new Client({ name: "size", version: "0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(b); await client.connect(a);
const sizes: Record<string, number> = {};
for (const query of ["box", "fillet", "extrude", "plasticity_create_box", "plasticity_fillet"]) {
  const response = await client.callTool({ name: "plasticity_call", arguments: { toolName: "catalog", query } });
  sizes[query] = JSON.stringify(response).length;
}
console.log(JSON.stringify(sizes));
await client.close(); await server.close();
