// Read-only dump: connects to the first Plasticity window, pages through native bindings and the MCP
// operation catalog, and writes discovery/live-catalog.json. Invokes no mutation tools.
import { writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: process.execPath, args: ["scripts/run-server.ts", "--compact-tools"], stderr: "inherit" });
const client = new Client({ name: "catalog-dump", version: "0" });
await client.connect(transport);

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await client.callTool({ name, arguments: args });
  const text = (response.content as { type: string; text?: string }[]).find((part) => part.type === "text")?.text ?? "";
  if (response.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
};

const windows = await call("plasticity_list_windows");
const targets = (windows.windows ?? windows.targets ?? windows) as { id?: string; targetId?: string }[];
const targetId = targets[0]?.targetId ?? targets[0]?.id;
if (!targetId) throw new Error(`No Plasticity window: ${JSON.stringify(windows)}`);
await call("plasticity_connect", { targetId });

const bindings: string[] = [];
let operations: unknown;
for (let offset: number | null = 0; offset !== null;) {
  const page = await call("plasticity_call", { toolName: "plasticity_capabilities", arguments: { offset, limit: 250 } });
  bindings.push(...page.bindings);
  operations = page.operations;
  offset = page.nextOffset;
}

const tools: unknown[] = [];
for (let offset: number | null = 0; offset !== null;) {
  const page = await call("plasticity_call", { toolName: "catalog", offset, limit: 25 });
  tools.push(...page.tools);
  offset = page.nextOffset;
}

await writeFile("discovery/live-catalog.json", JSON.stringify({
  capturedAt: new Date().toISOString(),
  windows,
  nativeBindings: { total: bindings.length, bindings },
  operations,
  mcpTools: { total: tools.length, tools },
}, null, 2));
console.log(JSON.stringify({ bindings: bindings.length, mcpTools: tools.length }));
await client.close();
