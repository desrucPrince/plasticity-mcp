// Live edit smoke test. Baseline = the document as found (expects undoDepth 0). Creates a box clear
// of existing bodies, checks it, cuts a cylinder hole, then undoes back to the baseline. Never saves.
// Run from the repo root: node discovery/smoke-edit.ts
import { writeFile } from "node:fs/promises";
import { openSession } from "./mcp-client.ts";

const s = await openSession();
const log: { step: string; ok: boolean; detail?: unknown }[] = [];
const check = (step: string, ok: boolean, detail?: unknown) => { log.push({ step, ok, detail }); console.log(ok ? "PASS" : "FAIL", step, detail === undefined ? "" : JSON.stringify(detail)); };
const status = () => s.op("plasticity_status");
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
const bodySig = (bodies: { id: number; boundsMm: unknown; faceCount: number }[]) => JSON.stringify(bodies.map((b) => [b.id, b.boundsMm, b.faceCount]));

const base = await status();
const baseSig = bodySig(base.bodies);
check("baseline undoDepth is 0", base.undoDepth === 0, { undoDepth: base.undoDepth, bodies: base.bodies.length });
if (base.undoDepth !== 0) { await s.close(); process.exit(1); }

try {
  const box = await s.op("plasticity_create_box", { originMm: [600, 0, 0], sizeMm: [20, 10, 5], name: "smoke-box", intent: "MCP smoke test box", revision: base.revision });
  let st = await status();
  const boxBody = st.bodies.find((b: { name: string | null; id: number }) => b.name === "smoke-box") ?? st.bodies.at(-1);
  const info = await s.op("plasticity_body_info", { id: boxBody.id });
  const bounds = info.boundsMm ?? info.body?.boundsMm ?? boxBody.boundsMm;
  check("box created", st.bodies.length === base.bodies.length + 1, { id: boxBody.id, createResultKeys: Object.keys(box ?? {}) });
  check("box bounds 600..620 x 0..10 x 0..5", near(bounds.min, [600, 0, 0]) && near(bounds.max, [620, 10, 5]), bounds);
  check("box topology 6F/12E/8V", boxBody.faceCount === 6 && boxBody.edgeCount === 12 && boxBody.vertexCount === 8, [boxBody.faceCount, boxBody.edgeCount, boxBody.vertexCount]);

  await s.op("plasticity_create_cylinder", { centerMm: [610, 5, -1], radiusMm: 3, heightMm: 7, axis: [0, 0, 1], name: "smoke-cyl", intent: "MCP smoke test cutter", revision: st.revision });
  st = await status();
  const cyl = st.bodies.find((b: { name: string | null }) => b.name === "smoke-cyl") ?? st.bodies.at(-1);
  check("cylinder created", st.bodies.length === base.bodies.length + 2, { id: cyl.id, boundsMm: cyl.boundsMm });

  await s.op("plasticity_boolean", { targetIds: [boxBody.id], toolIds: [cyl.id], operation: "difference", intent: "MCP smoke test hole", revision: st.revision });
  st = await status();
  const cut = st.bodies.filter((b: { id: number }) => !base.bodies.some((o: { id: number }) => o.id === b.id));
  const holed = cut[0];
  check("boolean leaves one new body", cut.length === 1, cut.map((b: { id: number; faceCount: number }) => [b.id, b.faceCount]));
  check("holed box gained faces (>6)", holed && holed.faceCount > 6, holed && { faceCount: holed.faceCount, edgeCount: holed.edgeCount, boundsMm: holed.boundsMm });
} catch (error) {
  check("edit sequence threw", false, String(error));
} finally {
  // Undo only what this run added: stop at undoDepth 0, which was the baseline.
  for (let i = 0; i < 10; i++) {
    const st = await status();
    if (st.undoDepth === 0) break;
    await s.op("plasticity_undo", { intent: "MCP smoke test cleanup", revision: st.revision });
  }
  const end = await status();
  check("restored: undoDepth 0", end.undoDepth === 0, { undoDepth: end.undoDepth, redoDepth: end.redoDepth });
  check("restored: bodies identical to baseline", bodySig(end.bodies) === baseSig, end.bodies.map((b: { id: number }) => b.id));
  await writeFile("discovery/smoke-edit-result.json", JSON.stringify({ ranAt: new Date().toISOString(), log }, null, 2));
  await s.close();
}
