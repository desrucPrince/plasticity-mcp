// Sanity check: run the a1 batch over real stdio (scripts/run-server.ts) to compare wall time with the
// in-process harness. Restores undo depth and body ids. Usage: node .../stdio-a1.ts [repeats]
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { guardEnv, OUT_DIR, save, TARGET } from "./lib.ts";
const env = guardEnv();
const steps = JSON.parse(readFileSync(`${OUT_DIR}/steps-a1.json`, "utf8"));
const transport = new StdioClientTransport({ command: process.execPath, args: ["scripts/run-server.ts", "--compact-tools"], env: { ...(process.env as Record<string, string>), ...env }, stderr: "pipe" });
const client = new Client({ name: "speed-audit", version: "0" });
await client.connect(transport);
const text = (r: { content: unknown }) => (r.content as Array<{ text: string }>)[0]!.text;
const status = async () => JSON.parse(text(await client.callTool({ name: "plasticity_status", arguments: { bodyLimit: 200 } })));
const base = await status();
if (base.targetId !== TARGET) throw new Error("wrong target");
const runs = [];
try {
  for (let i = 0; i < Number(process.argv[2] ?? 3); i++) {
    const t0 = performance.now();
    const r = await client.callTool({ name: "plasticity_batch", arguments: { steps, undoOnError: true } });
    const wallMs = Math.round(performance.now() - t0);
    if (r.isError) throw new Error(text(r).slice(0, 2000));
    const out = JSON.parse(text(r));
    runs.push({ wallMs, respBytes: Buffer.byteLength(text(r)), undoSteps: out.undoSteps });
    await client.callTool({ name: "plasticity_batch", arguments: { steps: Array.from({ length: out.undoSteps }, () => ({ toolName: "plasticity_undo", arguments: {} })) } });
  }
} finally {
  const end = await status();
  const ids = (s: { bodies: Array<{ id: number }> }) => s.bodies.map((b) => b.id).join(",");
  const restored = { ok: end.undoDepth === base.undoDepth && ids(end) === ids(base), undoDepth: end.undoDepth, bodyCount: end.bodies.length };
  save("stdio-a1.json", { measuredAt: new Date().toISOString(), runs, restored, startUndoDepth: base.undoDepth, startBodyCount: base.bodies.length });
  console.log(JSON.stringify({ runs, restored }));
  await client.close();
}
