// Minimal stdio client for the compact MCP server, used by the discovery scripts.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export async function openSession() {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["scripts/run-server.ts", "--compact-tools"], stderr: "inherit" });
  const client = new Client({ name: "discovery", version: "0" });
  await client.connect(transport);
  const raw = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const text = (response.content as { type: string; text?: string }[]).find((part) => part.type === "text")?.text ?? "";
    if (response.isError) throw new Error(`${name}: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
  };
  // Non-core operations are only reachable through the plasticity_call dispatcher in compact mode.
  const op = (name: string, args: Record<string, unknown> = {}) => raw("plasticity_call", { toolName: name, arguments: args });
  const windows = await raw("plasticity_list_windows");
  const targets = (windows.windows ?? windows.targets ?? windows) as { id?: string; targetId?: string }[];
  const targetId = targets[0]?.targetId ?? targets[0]?.id;
  if (!targetId) throw new Error(`No Plasticity window: ${JSON.stringify(windows)}`);
  const connected = await raw("plasticity_connect", { targetId });
  return { raw, op, windows, connected, close: () => client.close() };
}
