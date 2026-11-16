// Part 1.1 session fixed costs over real stdio (spawns scripts/run-server.ts --compact-tools like an MCP client).
// Read-only against the isolated Plasticity on 127.0.0.1:57147. Writes fixed-costs.json.
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { bytes, guardEnv, save, TARGET } from "./lib.ts";

const env = guardEnv();
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
const textOf = (r: { content: unknown }) => ((r.content as Array<{ type: string; text?: string }>).find((p) => p.type === "text")?.text ?? "");

async function start() {
  const t0 = performance.now();
  const transport = new StdioClientTransport({ command: process.execPath, args: ["scripts/run-server.ts", "--compact-tools"], env: { ...(process.env as Record<string, string>), ...env }, stderr: "pipe" });
  const client = new Client({ name: "speed-audit", version: "0" });
  await client.connect(transport);
  return { client, startMs: performance.now() - t0 };
}

const starts: number[] = [];
const firstCallMs: number[] = [];
let detail: Record<string, unknown> = {};
for (let run = 0; run < 3; run++) {
  const { client, startMs } = await start();
  starts.push(startMs);
  if (run === 0) {
    const t1 = performance.now();
    const listed = await client.listTools();
    const listMs = performance.now() - t1;
    const instructions = client.getInstructions() ?? "";
    const perTool = listed.tools.map((t) => ({ name: t.name, bytes: bytes(t) })).sort((a, b) => b.bytes - a.bytes);
    detail = { toolsListBytes: bytes(listed), toolCount: listed.tools.length, toolsListMs: Math.round(listMs), instructionsBytes: bytes(instructions), perTool };
  }
  // First real call auto-connects (one window open). Measures connect + status.
  const t2 = performance.now();
  const st = await client.callTool({ name: "plasticity_status", arguments: {} });
  firstCallMs.push(performance.now() - t2);
  const stText = textOf(st);
  const parsed = JSON.parse(stText);
  if (parsed.targetId !== TARGET) throw new Error(`wrong target ${parsed.targetId}`);
  if (run === 0) {
    const t3 = performance.now();
    const st2 = await client.callTool({ name: "plasticity_status", arguments: {} });
    const warmStatusMs = performance.now() - t3;
    const catalog: Record<string, { bytes: number; ms: number; names?: string[] }> = {};
    const lookups: Array<[string, Record<string, unknown>]> = [
      ["fuzzy:boss", { query: "boss" }],
      ["fuzzy:screw boss", { query: "screw boss" }],
      ["fuzzy:countersink", { query: "countersink" }],
      ["fuzzy:hole pattern", { query: "hole pattern" }],
      ["fuzzy:shell hollow", { query: "shell hollow" }],
      ["fuzzy:gusset rib", { query: "gusset rib" }],
      ["fuzzy:pattern", { query: "pattern" }],
      ["fuzzy+schema:screw boss", { query: "screw boss", schema: true }],
      ["fuzzy+schema:countersink", { query: "countersink", schema: true }],
      ["exact:plasticity_create_screw_boss_pattern", { query: "plasticity_create_screw_boss_pattern" }],
      ["exact:plasticity_create_connector_opening", { query: "plasticity_create_connector_opening" }],
      ["exact:plasticity_create_countersink_pattern", { query: "plasticity_create_countersink_pattern" }],
      ["exact:plasticity_create_through_hole_pattern", { query: "plasticity_create_through_hole_pattern" }],
      ["exact:plasticity_create_rib", { query: "plasticity_create_rib" }],
      ["exact:plasticity_hollow_faces", { query: "plasticity_hollow_faces" }],
      ["exact:plasticity_radial_pattern", { query: "plasticity_radial_pattern" }],
      ["exact:plasticity_check_interference", { query: "plasticity_check_interference" }],
      ["exact:plasticity_measure_parallel_planar_face_clearance", { query: "plasticity_measure_parallel_planar_face_clearance" }],
      ["exact:plasticity_validate_bodies", { query: "plasticity_validate_bodies" }],
    ];
    for (const [label, args] of lookups) {
      const t = performance.now();
      const r = await client.callTool({ name: "plasticity_call", arguments: { toolName: "catalog", ...args } });
      const text = textOf(r);
      const body = JSON.parse(text);
      catalog[label] = { bytes: bytes(text), ms: Math.round(performance.now() - t), names: body.tools?.map((x: { name: string }) => x.name).slice(0, 8), ...(label.startsWith("fuzzy:") ? { total: body.total } : {}) } as never;
    }
    detail = { ...detail, statusBytes: bytes(stText), statusBodies: parsed.bodies?.length, statusWarmMs: Math.round(warmStatusMs), statusWarmBytes: bytes(textOf(st2)), catalog };
  }
  await client.close();
}
const out = { measuredAt: new Date().toISOString(), endpoint: env.PLASTICITY_CDP_URL, serverStartMs: starts.map(Math.round), serverStartMsMedian: Math.round(median(starts)), firstCallAutoConnectStatusMs: firstCallMs.map(Math.round), ...detail };
save("fixed-costs.json", out);
console.log(JSON.stringify({ ...out, perTool: undefined }, null, 1));
