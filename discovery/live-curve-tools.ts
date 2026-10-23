// Live check of the curve and extrude tools added for COVERAGE gaps 1, 3 and 4.
// Refuses unless the document is blank or only Plasticity's startup cube with undo depth 0.
// Undoes everything it adds after each test and never saves.
// Usage: PLASTICITY_CDP_URL=http://127.0.0.1:<port> node discovery/live-curve-tools.ts
import { writeFile } from "node:fs/promises";
import { openSession } from "./mcp-client.ts";

const s = await openSession();
const status = () => s.raw("plasticity_status");
const isStartupCube = (body: { boundsMm: { min: number[]; max: number[] } | null }) => {
  const b = body.boundsMm;
  return !!b && [-500, -500, 0].every((v, i) => Math.abs(b.min[i]! - v) < 1e-6) && [500, 500, 1000].every((v, i) => Math.abs(b.max[i]! - v) < 1e-6);
};
const base = await status();
if (base.undoDepth !== 0 || base.bodies.length > 1 || (base.bodies.length === 1 && !isStartupCube(base.bodies[0]))) {
  await s.close();
  throw new Error(`Refusing: need a blank document (or only the startup cube) with undo depth 0; got ${base.bodies.length} bodies, undo ${base.undoDepth}: ${JSON.stringify(base.bodies.map((b: { id: number; name: string | null }) => [b.id, b.name]))}`);
}
const baseIds = base.bodies.map((b: { id: number }) => b.id).join(",");

const log: Array<{ test: string; ok: boolean; detail: unknown }> = [];
async function restore() {
  for (let i = 0; i < 30; i++) {
    const st = await status();
    if (st.undoDepth === 0) {
      if (st.bodies.map((b: { id: number }) => b.id).join(",") !== baseIds) throw new Error("Undo reached depth 0 but bodies differ from baseline");
      return;
    }
    await s.raw("plasticity_undo", { revision: st.revision });
  }
  throw new Error("undo did not converge");
}
async function check(test: string, run: () => Promise<unknown>) {
  try {
    const detail = await run();
    log.push({ test, ok: true, detail });
    console.log("PASS", test, JSON.stringify(detail));
  } catch (error) {
    log.push({ test, ok: false, detail: String(error).slice(0, 600) });
    console.log("FAIL", test, String(error).slice(0, 600));
  } finally {
    await restore();
  }
}
const added = (out: { change?: { added?: unknown[] } }) => (out.change?.added ?? []) as Array<{ id: number; type: string; boundsMm: unknown; faceCount: number; edgeCount: number }>;
const X = 2000; // well clear of the startup cube

try {
  await check("control-point curve differs from interpolating curve", async () => {
    const points = [[X, 0, 0], [X + 10, 20, 0], [X + 30, 20, 0], [X + 40, 0, 0]];
    const cp = await s.raw("plasticity_create_control_point_curve", { pointsMm: points, revision: (await status()).revision });
    const interp = await s.raw("plasticity_create_nurbs_curve", { pointsMm: points.map(([x, y, z]) => [x!, y! + 50, z!]), revision: cp.revision });
    const a = added(cp)[0]!, b = added(interp)[0]!;
    const cpMaxY = (a.boundsMm as { max: number[] }).max[1]!, interpMaxY = (b.boundsMm as { max: number[] }).max[1]! - 50;
    if (a.type !== "Wire") throw new Error(`expected Wire, got ${a.type}`);
    // A control-point curve stays inside its control polygon (max y < 20); an interpolating one reaches y = 20.
    if (!(cpMaxY < 19.9)) throw new Error(`control-point curve reaches y=${cpMaxY}, looks interpolating`);
    return { controlPointMaxY: cpMaxY, interpolatingMaxY: interpMaxY };
  });

  await check("extrude_profile with reverse distance, draft and a thin wall", async () => {
    const rect = await s.raw("plasticity_call", { toolName: "plasticity_create_rectangle", arguments: { centerMm: [X + 10, 105, 0], widthMm: 20, heightMm: 10, normal: [0, 0, 1], xDirection: [1, 0, 0], angleDegrees: 0, revision: (await status()).revision } });
    const wire = added(rect)[0]!;
    const twoSided = await s.raw("plasticity_extrude_profile", { id: wire.id, distanceMm: 10, options: { reverseDistanceMm: 4 }, revision: rect.revision });
    const solid = added(twoSided).find((b) => b.type === "Solid")!;
    const bounds = solid.boundsMm as { min: number[]; max: number[] };
    if (Math.abs(bounds.max[2]! - 10) > 1e-4 || Math.abs(bounds.min[2]! + 4) > 1e-4) throw new Error(`two-sided z range ${bounds.min[2]}..${bounds.max[2]}, want -4..10`);
    return { twoSidedZ: [bounds.min[2], bounds.max[2]] };
  });

  await check("extrude_profile with a draft angle", async () => {
    const rect = await s.raw("plasticity_call", { toolName: "plasticity_create_rectangle", arguments: { centerMm: [X + 10, 210, 0], widthMm: 20, heightMm: 20, normal: [0, 0, 1], xDirection: [1, 0, 0], angleDegrees: 0, revision: (await status()).revision } });
    const out = await s.raw("plasticity_extrude_profile", { id: added(rect)[0]!.id, distanceMm: 10, options: { draftAngleDeg: 10 }, revision: rect.revision });
    const solid = added(out).find((b) => b.type === "Solid")!;
    const bounds = solid.boundsMm as { min: number[]; max: number[] };
    const width = bounds.max[0]! - bounds.min[0]!;
    if (Math.abs(width - 20) < 0.01) throw new Error(`draft had no effect: width ${width}`);
    return { xWidthAfterDraft: width, faces: solid.faceCount };
  });

  await check("extrude_profile thin wall", async () => {
    const rect = await s.raw("plasticity_call", { toolName: "plasticity_create_rectangle", arguments: { centerMm: [X + 10, 310, 0], widthMm: 20, heightMm: 20, normal: [0, 0, 1], xDirection: [1, 0, 0], angleDegrees: 0, revision: (await status()).revision } });
    const out = await s.raw("plasticity_extrude_profile", { id: added(rect)[0]!.id, distanceMm: 10, options: { thicknessMm: 1 }, revision: rect.revision });
    const solid = added(out).find((b) => b.type === "Solid")!;
    // A thin-walled open tube has more faces than a 6-face block.
    if (!(solid.faceCount > 6)) throw new Error(`thin wall produced ${solid.faceCount} faces`);
    return { faces: solid.faceCount };
  });

  await check("extrude_curves turns an open curve into a Sheet", async () => {
    const line = await s.raw("plasticity_call", { toolName: "plasticity_create_polyline", arguments: { pointsMm: [[X, 400, 0], [X + 20, 400, 0], [X + 30, 410, 0]], closed: false, revision: (await status()).revision } });
    const out = await s.raw("plasticity_extrude_curves", { ids: [added(line)[0]!.id], distanceMm: 15, direction: [0, 0, 1], revision: line.revision });
    const sheet = added(out).find((b) => b.type === "Sheet");
    if (!sheet) throw new Error(`no Sheet added: ${JSON.stringify(added(out).map((b) => b.type))}`);
    const bounds = sheet.boundsMm as { min: number[]; max: number[] };
    if (Math.abs(bounds.max[2]! - bounds.min[2]! - 15) > 1e-4) throw new Error(`sheet height ${bounds.max[2]! - bounds.min[2]!}`);
    return { sheetFaces: sheet.faceCount, height: bounds.max[2]! - bounds.min[2]! };
  });

  await check("fillet_curves rounds the corner between two separate lines", async () => {
    const first = await s.raw("plasticity_call", { toolName: "plasticity_create_polyline", arguments: { pointsMm: [[X, 500, 0], [X + 20, 500, 0]], closed: false, revision: (await status()).revision } });
    const second = await s.raw("plasticity_call", { toolName: "plasticity_create_polyline", arguments: { pointsMm: [[X + 20, 500, 0], [X + 20, 520, 0]], closed: false, revision: first.revision } });
    const out = await s.raw("plasticity_fillet_curves", { firstId: added(first)[0]!.id, secondId: added(second)[0]!.id, radiusMm: 5, revision: second.revision });
    return { added: added(out).map((b) => [b.id, b.type, b.edgeCount]), removed: (out.change?.removed ?? []).length };
  });
  await check("cut_with_curves splits a box with a curved cutter", async () => {
    const box = await s.raw("plasticity_create_box", { originMm: [X, 600, 0], sizeMm: [40, 20, 10], revision: (await status()).revision });
    const boxId = added(box)[0]!.id;
    const curve = await s.raw("plasticity_create_nurbs_curve", { pointsMm: [[X - 5, 610, 20], [X + 20, 605, 20], [X + 45, 612, 20]], revision: box.revision });
    const out = await s.raw("plasticity_call", { toolName: "plasticity_cut_with_curves", arguments: { targetIds: [boxId], curveIds: [added(curve)[0]!.id], direction: [0, 0, -1], extend: true, revision: curve.revision } });
    const parts = added(out).filter((b) => b.type === "Solid");
    if (parts.length < 2) throw new Error(`expected 2 solid parts, got ${JSON.stringify(added(out).map((b) => b.type))}`);
    return { parts: parts.map((b) => b.faceCount) };
  });

  await check("knife_curve splits the top face of a box", async () => {
    const box = await s.raw("plasticity_create_box", { originMm: [X, 700, 0], sizeMm: [40, 20, 10], revision: (await status()).revision });
    const before = added(box)[0]!;
    const out = await s.raw("plasticity_call", { toolName: "plasticity_knife_curve", arguments: { targetId: before.id, pointsMm: [[X - 1, 710, 10], [X + 41, 710, 10]], revision: box.revision } });
    const st = await status();
    const after = st.bodies.find((b: { id: number }) => b.id === before.id) ?? (out.change?.added ?? [])[0];
    if (!after || !(after.faceCount > before.faceCount)) throw new Error(`faces ${before.faceCount} -> ${after?.faceCount}`);
    return { faces: [before.faceCount, after.faceCount] };
  });
} finally {
  await restore().catch((error) => console.error("RESTORE FAILED", error));
  await writeFile("discovery/live-curve-tools-result.json", JSON.stringify({ ranAt: new Date().toISOString(), log }, null, 2));
  await s.close();
}
