// MCP client for probes: starts scripts/run-server.ts against the isolated instance only.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { CDP, HERE, TARGET } from "./harness.ts";

export async function startMcp(): Promise<Client> {
  const root = join(HERE, "..", "..");
  const state = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "surfacing-probe-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "scripts", "run-server.ts")],
    cwd: root,
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, TMPDIR: process.env.TMPDIR ?? "/tmp", PLASTICITY_CDP_URL: CDP, PLASTICITY_AUTO_LAUNCH: "0", PLASTICITY_HUD: "0",
      PLASTICITY_MCP_STATE_DIR: join(state, "state"), PLASTICITY_CONSTRUCTION_HISTORY_ROOT: join(state, "history") },
    stderr: "pipe",
  });
  const client = new Client({ name: "surfacing-probe", version: "1.0.0" });
  await client.connect(transport);
  await call(client, "plasticity_connect", { targetId: TARGET });
  return client;
}

export async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response: any = await client.callTool({ name, arguments: args });
  const text = response.content?.find((entry: any) => entry.type === "text")?.text ?? "";
  if (response.isError) throw new Error(text);
  try { return JSON.parse(text); } catch { return text; }
}

export async function tryCall(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  try { return { ok: true, value: await call(client, name, args) }; } catch (error) { return { ok: false, error: (error as Error).message.slice(0, 2000) }; }
}

export async function status(client: Client): Promise<any> { return await call(client, "plasticity_status", { bodyLimit: 200 }); }

export async function undoTo(client: Client, depth: number): Promise<void> {
  for (let count = 0; count < 60; count += 1) {
    const current = await status(client);
    if (current.undoDepth <= depth) return;
    await call(client, "plasticity_undo", { intent: "probe cleanup", revision: current.revision });
  }
  throw new Error("undoTo did not converge");
}
