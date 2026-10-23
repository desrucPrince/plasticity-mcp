// Read-only: status with no list_windows/connect first should auto-connect to the single window.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({ command: process.execPath, args: ["scripts/run-server.ts", "--compact-tools"], env: process.env as Record<string, string>, stderr: "inherit" });
const client = new Client({ name: "autoconnect", version: "0" });
await client.connect(transport);
const start = performance.now();
const response = await client.callTool({ name: "plasticity_status", arguments: {} });
const text = (response.content as Array<{ text: string }>)[0]!.text;
console.log(JSON.stringify({ isError: response.isError ?? false, ms: Math.round(performance.now() - start), bytes: text.length, revision: response.isError ? null : JSON.parse(text).revision }));
await client.close();
