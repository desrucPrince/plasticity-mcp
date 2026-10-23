// Builds a ~300 mm fighter through the MCP server (mostly plasticity_batch) in the open Plasticity
// document. It first undoes back to undo depth 0 and refuses unless only the startup cube (or
// nothing) is left, so it is rerunnable on the same blank test document. It never saves.
// Usage: PLASTICITY_CDP_URL=http://127.0.0.1:9223 node discovery/spaceship/build.ts
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openSession } from "../mcp-client.ts";

const outDir = resolve("discovery/spaceship");
await mkdir(outDir, { recursive: true });
const startedAt = performance.now();
let calls = 0;
const s = await openSession();
calls += 2; // list_windows + connect inside openSession
const raw = async (name: string, args: Record<string, unknown> = {}) => { calls += 1; return await s.raw(name, args); };
const call = (name: string, args: Record<string, unknown> = {}) => raw("plasticity_call", { toolName: name, arguments: args });
const batch = (steps: Array<{ toolName: string; arguments?: Record<string, unknown> }>, undoOnError = true) => raw("plasticity_batch", { steps, undoOnError });
const status = () => raw("plasticity_status");

type Stage = { stage: string; ms: number; calls: number; ok: boolean; notes: string[] };
const stages: Stage[] = [];
const painPoints: string[] = [];
async function stage(name: string, run: (notes: string[]) => Promise<void>) {
  const t = performance.now();
  const c = calls;
  const notes: string[] = [];
  let ok = true;
  try {
    await run(notes);
  } catch (error) {
    ok = false;
    notes.push(`FAILED: ${String(error).slice(0, 500)}`);
  }
  stages.push({ stage: name, ms: Math.round(performance.now() - t), calls: calls - c, ok, notes });
  console.log(ok ? "OK  " : "FAIL", name, Math.round(performance.now() - t), "ms", notes.join(" | "));
}
const ids = (out: { change?: { added?: Array<{ id: number; type: string }> } }, type?: string) =>
  (out.change?.added ?? []).filter((b) => !type || b.type === type).map((b) => b.id);

// Closed control-point section in the YZ plane at x: separate top and bottom heights give a flat belly.
function section(x: number, halfWidth: number, top: number, bottom: number, centerZ: number) {
  const points = [];
  for (let k = 0; k < 8; k++) {
    const t = (k * Math.PI) / 4;
    const scale = 1.08; // a closed cubic B-spline sits inside its control polygon
    points.push([x, round(halfWidth * Math.cos(t) * scale), round(centerZ + (Math.sin(t) >= 0 ? top : bottom) * Math.sin(t) * scale)]);
  }
  return { toolName: "plasticity_create_control_point_curve", arguments: { pointsMm: points, closed: true } };
}
const round = (v: number) => Math.round(v * 100) / 100;

// ---- 0. baseline: undo back to depth 0 and require only the startup cube or nothing
let fuselage = 0, canopy = 0, wingR = 0, wingL = 0, nacelleR = 0, nacelleL = 0, finR = 0, finL = 0, hull = 0;
await stage("baseline", async (notes) => {
  const first = await status();
  if (first.undoDepth > 0) await raw("plasticity_undo", { steps: first.undoDepth, revision: first.revision });
  const st = await status();
  const startupCube = (b: { boundsMm: { min: number[]; max: number[] } }) => b.boundsMm.min.join() === "-500,-500,0" && b.boundsMm.max.join() === "500,500,1000";
  if (st.undoDepth !== 0 || st.bodies.length > 1 || (st.bodies.length === 1 && !startupCube(st.bodies[0]))) {
    throw new Error(`Refusing: document is not blank (bodies ${st.bodies.length}, undo ${st.undoDepth})`);
  }
  if (st.bodies.length === 1) await batch([{ toolName: "plasticity_delete", arguments: { ids: [st.bodies[0].id] } }]);
  notes.push("blank document confirmed");
});

// ---- 1. fuselage: six control-point sections lofted with natural (G2) curvature, then capped
await stage("fuselage loft", async (notes) => {
  const out = await batch([
    section(8, 20, 13, 9, 0), section(60, 30, 20, 13, 2), section(140, 30, 24, 14, 4),
    section(215, 21, 17, 11, 3), section(275, 8, 7, 5, 1), section(297, 1.6, 1.6, 1.4, 0),
    { toolName: "plasticity_loft_curves", arguments: { profileIds: ["$0.added[0]", "$1.added[0]", "$2.added[0]", "$3.added[0]", "$4.added[0]", "$5.added[0]"], curvature: "natural" } },
    { toolName: "plasticity_cap_sheet_holes", arguments: { ids: ["$6.added[0]"] } },
    { toolName: "plasticity_set_visibility", arguments: { bodyIds: ["$0.added[0]", "$1.added[0]", "$2.added[0]", "$3.added[0]", "$4.added[0]", "$5.added[0]"], visible: false } },
  ]);
  fuselage = out.steps[6].added[0];
  notes.push(`fuselage ${fuselage}`);
});

// ---- 2. canopy: a separate bubble lofted from four sections sitting in the fuselage top
await stage("canopy loft", async (notes) => {
  const out = await batch([
    section(166, 3, 2, 2, 23), section(192, 13, 11, 6, 21), section(224, 10, 8, 5, 17), section(250, 2, 1.5, 1.5, 12),
    { toolName: "plasticity_loft_curves", arguments: { profileIds: ["$0.added[0]", "$1.added[0]", "$2.added[0]", "$3.added[0]"], curvature: "natural" } },
    { toolName: "plasticity_cap_sheet_holes", arguments: { ids: ["$4.added[0]"] } },
    { toolName: "plasticity_set_visibility", arguments: { bodyIds: ["$0.added[0]", "$1.added[0]", "$2.added[0]", "$3.added[0]"], visible: false } },
  ]);
  canopy = out.steps[4].added[0];
  notes.push(`canopy ${canopy}`);
});

// ---- 3. wings: swept planform, two-sided extrude to a 4 mm slab, rounded edges, mirrored
await stage("wings", async (notes) => {
  const build = (radius: number) => batch([
    { toolName: "plasticity_create_polyline", arguments: { pointsMm: [[52, 14, 0], [170, 14, 0], [92, 108, 0], [62, 112, 0]], closed: true } },
    { toolName: "plasticity_extrude_profile", arguments: { id: "$0.added[0]", distanceMm: 2, options: { reverseDistanceMm: 2 } } },
    { toolName: "plasticity_find_edges", arguments: { query: { bodyIds: ["$1.added[0]"] } } },
    { toolName: "plasticity_fillet", arguments: { id: "$1.added[0]", edgeIds: "$2.result.matches[*].id", radiusMm: radius } },
    { toolName: "plasticity_set_visibility", arguments: { bodyIds: ["$0.added[0]"], visible: false } },
  ]);
  let out;
  try {
    out = await build(1.8);
  } catch (error) {
    notes.push(`fillet r1.8 on all edges failed (${String(error).slice(0, 120)}); retry r1.2`);
    painPoints.push("Wing: fillet of every slab edge at r=1.8 failed; needed a smaller radius.");
    out = await build(1.2);
  }
  wingR = out.steps[1].added[0];
  const mirrored = await batch([{ toolName: "plasticity_mirror", arguments: { ids: [wingR], planeOriginMm: [0, 0, 0], planeNormal: [0, 1, 0] } }]);
  wingL = ids(mirrored, "Solid")[0]!;
  notes.push(`wings ${wingR}, ${wingL}`);
});

// ---- 4. join wings to the fuselage and round the junction
await stage("wing-fuselage union + junction fillet", async (notes) => {
  const out = await batch([{ toolName: "plasticity_boolean", arguments: { targetIds: [fuselage], toolIds: [wingR, wingL], operation: "union" } }]);
  hull = out.change.modified.find((m: { id: number }) => m.id === fuselage) ? fuselage : (ids(out, "Solid")[0] ?? fuselage);
  notes.push(`hull ${hull}`);
  // Junction edges: non-line edges in the wing plane band where the wings enter the fuselage.
  const found = await call("plasticity_find_edges", { revision: out.revision, query: { bodyIds: [hull], line: false, boundsMm: { min: [40, -36, -3], max: [180, 36, 3] } } });
  const junction = (found.matches as Array<{ id: string; boundsMm: { min: number[]; max: number[] } }>)
    .filter((edge) => Math.abs(edge.boundsMm.min[1]!) > 12 && Math.abs(edge.boundsMm.max[1]!) > 12)
    .map((edge) => edge.id);
  notes.push(`${junction.length} junction edges`);
  if (junction.length === 0) { painPoints.push("Junction fillet: no way to ask for 'edges where body A met body B' after a union; bounds filtering found none."); return; }
  try {
    await batch([{ toolName: "plasticity_fillet", arguments: { id: hull, edgeIds: junction, radiusMm: 3 } }]);
    notes.push("junction filleted r3");
  } catch (error) {
    notes.push(`junction fillet r3 failed: ${String(error).slice(0, 160)}`);
    painPoints.push("Junction fillet failed at r=3 on the edges found by bounds; picking blend edges by bounds is fragile.");
    try { await batch([{ toolName: "plasticity_fillet", arguments: { id: hull, edgeIds: junction, radiusMm: 1.5 } }]); notes.push("junction filleted r1.5"); } catch (again) { notes.push(`r1.5 failed too: ${String(again).slice(0, 120)}`); }
  }
});

// ---- 5. engine nacelles: lofted from three circles, capped, angled intake cut with a curve, mirrored
await stage("nacelles + intake cut", async (notes) => {
  const circle = (x: number, r: number) => ({ toolName: "plasticity_create_circle", arguments: { centerMm: [x, 46, -5], radiusMm: r, normal: [1, 0, 0] } });
  const out = await batch([
    circle(18, 6), circle(55, 7.5), circle(98, 5.5),
    { toolName: "plasticity_loft_curves", arguments: { profileIds: ["$0.added[0]", "$1.added[0]", "$2.added[0]"], curvature: "natural" } },
    { toolName: "plasticity_cap_sheet_holes", arguments: { ids: ["$3.added[0]"] } },
    { toolName: "plasticity_set_visibility", arguments: { bodyIds: ["$0.added[0]", "$1.added[0]", "$2.added[0]"], visible: false } },
    // Angled intake: a curve in the XZ plane, swept along Y, slices the nacelle nose at a slant.
    { toolName: "plasticity_create_nurbs_curve", arguments: { pointsMm: [[84, 46, 6], [90, 46, -4], [97, 46, -14]], closed: false } },
    { toolName: "plasticity_cut_with_curves", arguments: { targetIds: ["$3.added[0]"], curveIds: ["$6.added[0]"], direction: [0, 1, 0], extend: true } },
  ]);
  // The cut leaves two Solids (the original id and one new id); keep the longer one as the nacelle.
  const lengthOf = (body?: { boundsMm: { min: number[]; max: number[] } }) => body ? body.boundsMm.max[0]! - body.boundsMm.min[0]! : -1;
  const original = out.change.modified.find((m: { id: number }) => m.id === out.steps[3].added[0])?.after ?? out.change.added.find((b: { id: number }) => b.id === out.steps[3].added[0]);
  const piece = out.steps[7].addedBodies?.[0];
  if (!piece) throw new Error("intake cut produced no second part");
  const [keep, offcut] = lengthOf(original) >= lengthOf(piece) ? [out.steps[3].added[0], piece.id] : [piece.id, out.steps[3].added[0]];
  nacelleR = keep;
  await batch([{ toolName: "plasticity_delete", arguments: { ids: [offcut] } }, { toolName: "plasticity_set_visibility", arguments: { bodyIds: [out.steps[6].added[0]], visible: false } }]);
  notes.push(`kept ${keep} (${Math.round(Math.max(lengthOf(original), lengthOf(piece)))} mm), deleted offcut ${offcut}`);
  const mirrored = await batch([{ toolName: "plasticity_mirror", arguments: { ids: [nacelleR], planeOriginMm: [0, 0, 0], planeNormal: [0, 1, 0] } }]);
  nacelleL = ids(mirrored, "Solid")[0]!;
  notes.push(`nacelles ${nacelleR}, ${nacelleL}`);
});

// ---- 6. twin canted tail fins
await stage("tail fins", async (notes) => {
  const out = await batch([
    { toolName: "plasticity_create_polyline", arguments: { pointsMm: [[6, 0, 8], [62, 0, 12], [30, 0, 52], [12, 0, 54]], closed: true } },
    { toolName: "plasticity_extrude_profile", arguments: { id: "$0.added[0]", distanceMm: 0.8, options: { reverseDistanceMm: 0.8 } } },
    { toolName: "plasticity_find_edges", arguments: { query: { bodyIds: ["$1.added[0]"] } } },
    { toolName: "plasticity_fillet", arguments: { id: "$1.added[0]", edgeIds: "$2.result.matches[*].id", radiusMm: 0.6 } },
    { toolName: "plasticity_set_visibility", arguments: { bodyIds: ["$0.added[0]"], visible: false } },
    { toolName: "plasticity_rotate", arguments: { ids: ["$1.added[0]"], pivotMm: [30, 0, 8], axis: [1, 0, 0], degrees: -18 } },
    { toolName: "plasticity_move", arguments: { ids: ["$1.added[0]"], deltaMm: [0, 16, 0] } },
  ]);
  finR = out.steps[1].added[0];
  const mirrored = await batch([{ toolName: "plasticity_mirror", arguments: { ids: [finR], planeOriginMm: [0, 0, 0], planeNormal: [0, 1, 0] } }]);
  finL = ids(mirrored, "Solid")[0]!;
  notes.push(`fins ${finR}, ${finL}`);
});

// ---- 7. panel line: knife a line around the nose
await stage("knife panel line", async (notes) => {
  const box = (await status()).bodies.find((b: { id: number }) => b.id === hull)?.boundsMm;
  notes.push(`hull bounds ${JSON.stringify(box)}`);
  try {
    await batch([{ toolName: "plasticity_knife_curve", arguments: { targetId: hull, pointsMm: [[255, -14, 3], [255, 0, 14], [255, 14, 3]] } }]);
    notes.push("knife line drawn at x=255");
  } catch (error) {
    notes.push(`knife failed: ${String(error).slice(0, 200)}`);
    painPoints.push("Knife needs points on the surface; there is no 'project this curve onto the face, then knife' in one step.");
  }
});

// ---- 8. views and screenshots
await stage("screenshots", async (notes) => {
  // Plasticity's named views look along world axes: "front" shows this X-forward ship from the side
  // and "right" looks at the nose.
  const shots: Array<[string, string]> = [["isometric", "spaceship-iso"], ["top", "spaceship-top"], ["front", "spaceship-side"], ["right", "spaceship-nose-on"]];
  for (const [view, name] of shots) {
    await call("plasticity_set_view", { view, fit: true });
    const path = resolve(outDir, `${name}.png`);
    await rm(path, { force: true }); // the screenshot tool refuses to overwrite
    try { await raw("plasticity_screenshot", { path }); notes.push(path); } catch (error) { notes.push(`${view} screenshot failed: ${String(error).slice(0, 120)}`); }
  }
});

const final = await status();
const summary = {
  builtAt: new Date().toISOString(),
  totalMs: Math.round(performance.now() - startedAt),
  mcpCalls: calls,
  bodies: final.bodies.filter((b: { visible: boolean }) => b.visible).map((b: { id: number; type: string; name: string | null; boundsMm: unknown; faceCount: number }) => ({ id: b.id, type: b.type, name: b.name, boundsMm: b.boundsMm, faces: b.faceCount })),
  undoDepth: final.undoDepth,
  stages,
  painPoints,
};
await writeFile(resolve(outDir, "build-result.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ totalMs: summary.totalMs, mcpCalls: calls, visibleBodies: summary.bodies.length, painPoints }, null, 1));
await s.close();
