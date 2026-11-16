// Dumps catalog entries (description + JSON schema) for named tools, offline (no Plasticity needed).
// Usage: node discovery/speed-2026-11/dump-schemas.ts out.json name1 name2 ...
import { writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCompactServer } from "../../src/server.ts";
const [out, ...names] = process.argv.slice(2);
const server = createCompactServer(undefined, undefined, undefined, undefined, null);
const client = new Client({ name: "dump", version: "0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(b); await client.connect(a);
const result: Record<string, unknown> = {};
for (const name of names) {
  const r = await client.callTool({ name: "plasticity_call", arguments: { toolName: "catalog", query: name } });
  const text = (r.content as { text: string }[])[0].text;
  result[name] = { bytes: Buffer.byteLength(text), entry: JSON.parse(text) };
}
await writeFile(out!, JSON.stringify(result, null, 1));
await client.close(); await server.close();
