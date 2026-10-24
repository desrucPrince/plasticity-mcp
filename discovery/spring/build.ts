// Print-in-place spring-loaded push button for PETG, ~40 x 40 x 18 mm, built through the MCP server.
// v2 (PETG): 45-degree conical pocket roof so the top plate needs no support, 0.5 mm plunger
// clearance, and 1.5 mm-tall arms for ~0.5 N/mm. v1 (PLA, flat plate) is in git history.
// Refuses unless the open document has no bodies (or only the startup cube). Keeps the result,
// never saves, and does not undo edits it did not make.
// Usage: PLASTICITY_CDP_URL=http://127.0.0.1:9223 node discovery/spring/build.ts
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openSession } from "../mcp-client.ts";

const outDir = resolve("discovery/spring");
await mkdir(outDir, { recursive: true });
const startedAt = performance.now();
let calls = 0;
const s = await openSession();
calls += 2;
const raw = async (name: string, args: Record<string, unknown> = {}) => { calls += 1; return await s.raw(name, args); };
const call = (name: string, args: Record<string, unknown> = {}) => raw("plasticity_call", { toolName: name, arguments: args });
const batch = (steps: Array<{ toolName: string; arguments?: Record<string, unknown> }>, undoOnError = true) => raw("plasticity_batch", { steps, undoOnError });
const status = () => raw("plasticity_status");

type Stage = { stage: string; ms: number; calls: number; ok: boolean; notes: string[] };
const stages: Stage[] = [];
const checks: Record<string, string> = {};
async function stage(name: string, run: (notes: string[]) => Promise<void>) {
  const t = performance.now(); const c = calls; const notes: string[] = []; let ok = true;
  try { await run(notes); } catch (error) { ok = false; notes.push(`FAILED: ${String(error).slice(0, 600)}`); }
  stages.push({ stage: name, ms: Math.round(performance.now() - t), calls: calls - c, ok, notes });
  console.log(ok ? "OK  " : "FAIL", name, Math.round(performance.now() - t), "ms", notes.join(" | "));
  if (!ok && name === "baseline") { await s.close(); throw new Error("baseline check failed; nothing was built"); }
}

// Dimensions (mm). The spring layer sits on the print bed (z 0..1.2); the plunger rises through a
// top plate and ends in a 45-degree cone cap, so nothing overhangs flat over air.
const ARM_T = 1.5, ARM_W = 2.0, ARM_SWEEP_DEG = 240, ARMS = 3;
const FRAME = 40, POCKET_R = 15, PLUNGER_R = 5, CLEARANCE = 0.5, HOLE_R = PLUNGER_R + CLEARANCE;
// The roof cone starts 0.6 mm above the arms at the wall and closes at 45 degrees to the plunger hole.
const ROOF_Z = ARM_T + 0.6, ROOF_H = POCKET_R - HOLE_R, PLATE_MIN = 1.2;
const FRAME_H = ROOF_Z + ROOF_H + PLATE_MIN;
const TRAVEL = 2.0, CAP_R = 9, CAP_H = 4;
// The 45-degree cap reaches the hole radius CLEARANCE above its base, so it meets the plate after TRAVEL.
const PLUNGER_TOP = FRAME_H + TRAVEL - CLEARANCE;
const MOUNT_R = 1.6, MOUNT_AT = 16;

function spiral(startDeg: number) {
  // Archimedean spiral from just inside the plunger to just inside the frame wall.
  const r0 = PLUNGER_R - 0.4, r1 = POCKET_R + 0.6, n = 9;
  const points = [];
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const a = ((startDeg + f * ARM_SWEEP_DEG) * Math.PI) / 180;
    const r = r0 + f * (r1 - r0);
    points.push([round(r * Math.cos(a)), round(r * Math.sin(a)), 0]);
  }
  return points;
}
const round = (v: number) => Math.round(v * 1000) / 1000;

let frame = 0, plunger = 0;
const armIds: number[] = [];

await stage("baseline", async (notes) => {
  const st = await status();
  const startupCube = (b: { boundsMm: { min: number[]; max: number[] } }) => b.boundsMm.min.join() === "-500,-500,0" && b.boundsMm.max.join() === "500,500,1000";
  if (st.bodies.length > 1 || (st.bodies.length === 1 && !startupCube(st.bodies[0]))) throw new Error(`Refusing: document has ${st.bodies.length} bodies`);
  if (st.bodies.length === 1) await batch([{ toolName: "plasticity_delete", arguments: { ids: [st.bodies[0].id] } }]);
  notes.push(`blank document ${st.documentToken}, undo depth ${st.undoDepth} left as is`);
});

await stage("frame: block, pocket with 45-degree roof, plunger hole, 4 mounting holes", async (notes) => {
  const hole = (x: number, y: number) => ({ toolName: "plasticity_create_cylinder", arguments: { centerMm: [x, y, -1], radiusMm: MOUNT_R, heightMm: FRAME_H + 2 } });
  const out = await batch([
    { toolName: "plasticity_create_box", arguments: { originMm: [-FRAME / 2, -FRAME / 2, 0], sizeMm: [FRAME, FRAME, FRAME_H], name: "Frame" } },
    { toolName: "plasticity_create_cylinder", arguments: { centerMm: [0, 0, -1], radiusMm: POCKET_R, heightMm: ROOF_Z + 1 } },
    { toolName: "plasticity_create_cone", arguments: { bottomCenterMm: [0, 0, ROOF_Z], bottomRadiusMm: POCKET_R, topRadiusMm: HOLE_R, heightMm: ROOF_H, axis: [0, 0, 1], radialDirection: [1, 0, 0] } },
    { toolName: "plasticity_create_cylinder", arguments: { centerMm: [0, 0, ROOF_Z + ROOF_H - 1], radiusMm: HOLE_R, heightMm: PLATE_MIN + 2 } },
    hole(MOUNT_AT, MOUNT_AT), hole(-MOUNT_AT, MOUNT_AT), hole(-MOUNT_AT, -MOUNT_AT), hole(MOUNT_AT, -MOUNT_AT),
    { toolName: "plasticity_boolean", arguments: { targetIds: ["$0.added[0]"], toolIds: ["$1.added[0]", "$2.addedSolids[0]", "$3.added[0]", "$4.added[0]", "$5.added[0]", "$6.added[0]", "$7.added[0]"], operation: "difference" } },
  ]);
  frame = out.steps[0].added[0];
  notes.push(`frame ${frame}`);
});

await stage("plunger: column + 45-degree cone cap", async (notes) => {
  const out = await batch([
    { toolName: "plasticity_create_cylinder", arguments: { centerMm: [0, 0, 0], radiusMm: PLUNGER_R, heightMm: PLUNGER_TOP, name: "Plunger" } },
    { toolName: "plasticity_create_cone", arguments: { bottomCenterMm: [0, 0, PLUNGER_TOP], bottomRadiusMm: PLUNGER_R, topRadiusMm: CAP_R, heightMm: CAP_H, axis: [0, 0, 1], radialDirection: [1, 0, 0] } },
    // create_cone also adds its editable profile Wire, so pick the Solid explicitly.
    { toolName: "plasticity_boolean", arguments: { targetIds: ["$0.added[0]"], toolIds: ["$1.addedSolids[0]"], operation: "union" } },
    { toolName: "plasticity_set_visibility", arguments: { bodyIds: "$1.addedWires", visible: false } },
  ]);
  plunger = out.steps[0].added[0];
  notes.push(`plunger ${plunger}`);
});

await stage("spring arms: 3 control-point spirals extruded ARM_T with ARM_W wall", async (notes) => {
  for (let i = 0; i < ARMS; i++) {
    const out = await batch([
      { toolName: "plasticity_create_control_point_curve", arguments: { pointsMm: spiral((360 / ARMS) * i), closed: false } },
      { toolName: "plasticity_extrude_curves", arguments: { ids: ["$0.added[0]"], distanceMm: ARM_T, direction: [0, 0, 1], options: { thicknessMm: ARM_W } } },
      { toolName: "plasticity_set_visibility", arguments: { bodyIds: ["$0.added[0]"], visible: false } },
    ]);
    const solid = out.steps[1].addedBodies.find((b: { type: string }) => b.type === "Solid");
    if (!solid) throw new Error(`arm ${i} extrusion made ${JSON.stringify(out.steps[1].addedBodies.map((b: { type: string }) => b.type))}, not a Solid`);
    armIds.push(solid.id);
    notes.push(`arm ${solid.id} z ${solid.boundsMm.min[2]}..${solid.boundsMm.max[2]}`);
  }
});

await stage("join arms to frame and plunger, fillet the roots from createdEdges", async (notes) => {
  const joined = await batch([{ toolName: "plasticity_boolean", arguments: { targetIds: [frame], toolIds: [plunger, ...armIds], operation: "union" } }]);
  const created = joined.steps[0].createdEdges as Array<{ edgeId: string }> | undefined;
  checks.createdEdges = created ? `worked: ${created.length} created edges reported` : "MISSING from the batch step";
  notes.push(checks.createdEdges);
  // Root edges: vertical lines as tall as the arm, among the edges the union created.
  for (const radius of [0.8, 0.5]) {
    try {
      const out = await batch([
        { toolName: "plasticity_find_edges", arguments: { query: { bodyIds: [frame], edgeIds: (created ?? []).map((edge) => edge.edgeId), line: true, direction: { vector: [0, 0, 1], toleranceDeg: 2 }, lengthMm: { value: ARM_T, tolerance: 0.05 } } } },
        { toolName: "plasticity_fillet", arguments: { id: frame, edgeIds: "$0.result.matches[*].id", radiusMm: radius } },
      ]);
      notes.push(`filleted ${out.steps[0].result.count ?? out.steps[0].result.ids?.length} root edges at r${radius}`);
      return;
    } catch (error) {
      notes.push(`root fillet r${radius} failed: ${String(error).slice(0, 200)}`);
    }
  }
});

await stage("tool checks on a scratch box: cut keep larger, then undo steps", async (notes) => {
  const before = await status();
  const box = await batch([
    { toolName: "plasticity_create_box", arguments: { originMm: [60, -10, 0], sizeMm: [20, 20, 5] } },
    { toolName: "plasticity_create_polyline", arguments: { pointsMm: [[66, -15, 10], [66, 15, 10]], closed: false } },
    { toolName: "plasticity_cut_with_curves", arguments: { targetIds: ["$0.added[0]"], curveIds: ["$1.added[0]"], direction: [0, 0, -1], extend: true, keep: "larger" } },
  ], false);
  const solids = (await status()).bodies.filter((b: { id: number; type: string }) => b.type === "Solid" && !before.bodies.some((o: { id: number }) => o.id === b.id));
  const kept = solids[0];
  const width = kept ? kept.boundsMm.max[0] - kept.boundsMm.min[0] : 0;
  checks.cutKeepLarger = solids.length === 1 && Math.abs(width - 14) < 0.01 ? "worked: one part left, the 14 mm side" : `unexpected: ${solids.length} new solids, width ${width}`;
  notes.push(checks.cutKeepLarger);
  const st = await status();
  const steps = st.undoDepth - before.undoDepth;
  await raw("plasticity_undo", { steps, revision: st.revision });
  const after = await status();
  const same = after.bodies.map((b: { id: number }) => b.id).join() === before.bodies.map((b: { id: number }) => b.id).join() && after.undoDepth === before.undoDepth;
  checks.undoSteps = same ? `worked: one call undid ${steps} steps` : `unexpected: undo depth ${after.undoDepth} vs ${before.undoDepth}`;
  notes.push(checks.undoSteps, `box batch undoSteps ${box.undoSteps}`);
});

await stage("views, section and screenshots", async (notes) => {
  const shot = async (view: string, name: string) => {
    await call("plasticity_set_view", { view, fit: true });
    const path = resolve(outDir, `${name}.png`);
    await rm(path, { force: true });
    await raw("plasticity_screenshot", { path });
    notes.push(path);
  };
  // Leftover construction curves (section profiles, cone profiles, arm paths) are deleted.
  const wires = (await status()).bodies.filter((b: { type: string }) => b.type === "Wire").map((b: { id: number }) => b.id);
  if (wires.length > 0) await batch([{ toolName: "plasticity_delete", arguments: { ids: wires } }]);
  notes.push(`deleted ${wires.length} construction curves`);
  await shot("isometric", "button-iso");
  await shot("top", "button-top");
  // Viewport sections: through the plunger axis, along one arm, and across the spring layer.
  const sectionShot = async (originMm: number[], normal: number[], xDirection: number[], view: string, name: string) => {
    // Only remove the section this script made; leave any the user applied.
    const existing = new Set(((await status()).sectionAnalyses ?? []).map((section: { id: number }) => section.id));
    await batch([{ toolName: "plasticity_create_section_analysis", arguments: { originMm, normal, xDirection, name } }]);
    await shot(view, name);
    for (const section of (await status()).sectionAnalyses ?? []) {
      if (!existing.has(section.id)) await batch([{ toolName: "plasticity_delete_section_analysis", arguments: { id: section.id } }]);
    }
  };
  await sectionShot([0, 0, 0], [0, 1, 0], [1, 0, 0], "isometric", "section-axis-iso");
  await sectionShot([0, 0, 0], [0, 1, 0], [1, 0, 0], "front", "section-axis-side");
  await sectionShot([0, 0, ARM_T / 2], [0, 0, 1], [1, 0, 0], "top", "section-spring-top");
  await shot("isometric", "button-iso-final");
});

await stage("export 3MF", async (notes) => {
  const path = resolve(outDir, "push-button-petg.3mf");
  await rm(path, { force: true });
  const out = await call("plasticity_export_3mf", { ids: [frame], path, chordToleranceMm: 0.01, angleToleranceDegrees: 10, revision: (await status()).revision });
  notes.push(`${path} ${out.bytes} bytes, ${out.triangles} triangles`);
});

// Guided-beam estimate (each arm fixed at both ends, plunger moves straight down). See NOTES.md.
const armLength = (() => {
  let length = 0; const p = spiral(0);
  for (let i = 1; i < p.length; i++) length += Math.hypot(p[i]![0]! - p[i - 1]![0]!, p[i]![1]! - p[i - 1]![1]!);
  return length;
})();
const estimate = Object.fromEntries([["PLA", 3500], ["PETG", 2100]].map(([material, modulusMpa]) => {
  const E = modulusMpa as number, I = (ARM_W * ARM_T ** 3) / 12, travel = 2;
  const kArm = (12 * E * I) / armLength ** 3;
  const stress = (6 * E * travel * (ARM_T / 2)) / armLength ** 2;
  const yieldMpa = material === "PLA" ? 50 : 50;
  return [material, { modulusMpa: E, stiffnessNPerMm: round(kArm * ARMS), forceAt2mmN: round(kArm * ARMS * travel), maxBendingStressMpaAt2mm: round(stress), stressToYield: round(stress / yieldMpa) }];
}));
checks.geometry = JSON.stringify({ FRAME_H: round(FRAME_H), ROOF_Z: round(ROOF_Z), PLUNGER_TOP: round(PLUNGER_TOP), capTop: round(PLUNGER_TOP + CAP_H), clearanceMm: CLEARANCE, armToRoofAtWallMm: round(ROOF_Z - ARM_T), travelMm: TRAVEL });
checks.estimate = JSON.stringify({ armLengthMm: round(armLength), ...estimate });

const final = await status();
const summary = { builtAt: new Date().toISOString(), totalMs: Math.round(performance.now() - startedAt), mcpCalls: calls, stages, checks, bodies: final.bodies.filter((b: { visible: boolean }) => b.visible).map((b: { id: number; type: string; name: string | null; boundsMm: unknown; faceCount: number }) => ({ id: b.id, type: b.type, name: b.name, boundsMm: b.boundsMm, faces: b.faceCount })) };
await writeFile(resolve(outDir, "build-result.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ totalMs: summary.totalMs, mcpCalls: calls, checks }, null, 1));
await s.close();
