// Live latency benchmark. Requires a Plasticity window on an untouched startup document (undo depth 0) (use npm run start:plasticity-isolated and pass its endpoint). Undoes everything it adds.
// Usage: PLASTICITY_CDP_URL=http://127.0.0.1:<port> node discovery/bench.ts discovery/perf-baseline.json
import { writeFile } from "node:fs/promises";
import { openSession } from "./mcp-client.ts";

const output = process.argv[2] ?? "discovery/perf.json";
const env = { PLASTICITY_TIMING: "1", PLASTICITY_CONSTRUCTION_HISTORY_ROOT: process.env.PLASTICITY_CONSTRUCTION_HISTORY_ROOT ?? "" };
const REPEATS = 5;

async function listSize(full: boolean) {
  const s = await openSession({ full, env });
  const listed = await s.client.listTools();
  await s.close();
  return { tools: listed.tools.length, bytes: Buffer.byteLength(JSON.stringify(listed)) };
}

const tools = { compact: await listSize(false), full: await listSize(true) };
const s = await openSession({ env });
const status = () => s.op("plasticity_status");
const base = await status();
if (base.undoDepth !== 0 || !String(base.title).startsWith("Untitled")) {
  await s.close();
  throw new Error(`Refusing: need an Untitled startup document with undo depth 0, got "${base.title}" with undo ${base.undoDepth}`);
}
const baseBodies = base.bodies.length;

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function timed(label: string, run: () => Promise<{ timing?: Record<string, number> } | unknown>) {
  const wall: number[] = [];
  const phases: Record<string, number[]> = {};
  for (let i = 0; i < REPEATS; i++) {
    const start = performance.now();
    const value = await run() as { timing?: Record<string, number> };
    wall.push(performance.now() - start);
    console.error(label, Math.round(performance.now() - start), "ms");
    for (const [phase, ms] of Object.entries(value?.timing ?? {})) (phases[phase] ??= []).push(ms);
  }
  return { label, wallMsMedian: Math.round(median(wall)), serverPhasesMsMedian: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, median(v)])) };
}

async function undoTo(depth: number) {
  for (let i = 0; i < 100; i++) {
    const st = await status();
    if (st.undoDepth <= depth) return;
    await s.op("plasticity_undo", { revision: st.revision });
  }
  throw new Error("undo did not converge");
}

async function suite(bodies: number) {
  const results = [];
  results.push(await timed("status", () => status()));
  results.push(await timed("body_info", () => s.op("plasticity_body_info", { id: base.bodies[0].id })));
  let x = 2000;
  results.push(await timed("create_box (status read + box with revision)", async () => {
    const st = await status();
    x += 30;
    return await s.op("plasticity_create_box", { originMm: [x, 0, 0], sizeMm: [20, 10, 5], revision: st.revision });
  }));
  results.push(await timed("create_box (with known revision)", async () => {
    const st = await status();
    x += 30;
    const start = performance.now();
    const value = await s.op("plasticity_create_box", { originMm: [x, 0, 0], sizeMm: [20, 10, 5], revision: st.revision });
    return { ...value, timing: { ...value.timing, boxOnlyWallMs: Math.round(performance.now() - start) } };
  }));
  results.push(await timed("undo (status read + undo)", async () => {
    const st = await status();
    return await s.op("plasticity_undo", { revision: st.revision });
  }));
  const batchAvailable = (await s.client.listTools()).tools.some((tool) => tool.name === "plasticity_batch");
  if (batchAvailable) {
    results.push(await timed("batch: box + hole + fillet (one call), then undo", async () => {
      const start = performance.now();
      const out = await s.raw("plasticity_batch", { steps: [
        { toolName: "plasticity_create_box", arguments: { originMm: [3000, 0, 0], sizeMm: [20, 10, 5] } },
        { toolName: "plasticity_create_cylinder", arguments: { centerMm: [3010, 5, -1], radiusMm: 3, heightMm: 7 } },
        { toolName: "plasticity_boolean", arguments: { targetIds: ["$0.added[0]"], toolIds: "$1.added", operation: "difference" } },
        { toolName: "plasticity_find_edges", arguments: { query: { bodyIds: ["$0.added[0]"], line: true } } },
        { toolName: "plasticity_fillet", arguments: { id: "$0.added[0]", edgeIds: "$3.result.matches[*].id", radiusMm: 1 } },
      ] });
      const batchMs = Math.round(performance.now() - start);
      await s.raw("plasticity_batch", { steps: Array.from({ length: out.undoSteps }, () => ({ toolName: "plasticity_undo", arguments: {} })) });
      return { timing: { batchCallMs: batchMs, responseBytes: JSON.stringify(out).length } };
    }));
  }
  return { bodies, results };
}

const runs = [];
try {
  runs.push(await suite(1));
  await undoTo(0);
  for (let i = 0; i < 20 - baseBodies; i++) {
    const st = await status();
    await s.op("plasticity_create_box", { originMm: [i * 30, 600, 0], sizeMm: [20, 10, 5], revision: st.revision });
  }
  const filled = await status();
  runs.push(await suite(filled.bodies.length));
} finally {
  await undoTo(0);
  const end = await status();
  // Full revision includes redo depth, which is nonzero after undoing, so compare bodies and undo depth.
  const ids = (st: { bodies: { id: number }[] }) => st.bodies.map((body) => body.id).join(",");
  if (ids(end) !== ids(base) || end.undoDepth !== 0) console.error("WARNING: document not back at baseline", end.bodies.length, end.undoDepth);
  await s.close();
}

await writeFile(output, JSON.stringify({ measuredAt: new Date().toISOString(), repeats: REPEATS, toolsList: tools, runs }, null, 2));
console.log(JSON.stringify({ tools, runs }, null, 1));
