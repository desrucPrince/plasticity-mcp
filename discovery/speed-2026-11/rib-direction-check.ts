// Rib direction proof: does a positive thickness run along the right-hand normal of the profile point order?
// Builds a 3 mm base plate at x >= 2000, makes ribs from three profiles (the benchmark triangle, the same triangle with
// reversed point order, and a triangle in a plane tilted 30 degrees about x) for side positive, negative and centered, and
// compares ribBoundsMm with the bounds predicted from the right-hand normal. Restores the starting undo depth and bodies.
// Usage: SPEED_CDP_URL=http://127.0.0.1:<port> SPEED_TARGET=<id> node discovery/speed-2026-11/rib-direction-check.ts
import { openInProcess, restore, save, status } from "./lib.ts";

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => { const n = Math.hypot(...a); return [a[0] / n, a[1] / n, a[2] / n]; };
const r4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0;

const O: V3 = [2010, 200, 1.5]; // the tilted profile's bottom edge sits inside the 3 mm plate, so both sides of it overlap the plate
const t30 = Math.PI / 6;
const profiles: Record<string, V3[]> = {
  triangle: [[2010, 200, 3], [2030, 200, 3], [2010, 200, 14]],
  triangleReversed: [[2010, 200, 3], [2010, 200, 14], [2030, 200, 3]],
  tilted30: [O, [O[0] + 20, O[1], O[2]], [O[0], O[1] - 11 * Math.sin(t30), O[2] + 11 * Math.cos(t30)]],
};
const THICKNESS = 4;

function predicted(points: V3[], side: string): { normal: V3; min: V3; max: V3 } {
  const normal = unit(cross(sub(points[1]!, points[0]!), sub(points[2]!, points[0]!)));
  const [from, to] = side === "positive" ? [0, THICKNESS] : side === "negative" ? [-THICKNESS, 0] : [-THICKNESS / 2, THICKNESS / 2];
  const corners = points.flatMap((p) => [from, to].map((s) => [0, 1, 2].map((i) => p[i]! + s * normal[i]!)));
  return { normal: normal.map(r4) as V3, min: [0, 1, 2].map((i) => r4(Math.min(...corners.map((c) => c[i]!)))) as V3, max: [0, 1, 2].map((i) => r4(Math.max(...corners.map((c) => c[i]!)))) as V3 };
}

const h = await openInProcess();
const cases: unknown[] = [];
let allMatch = true;
try {
  const start = await status(h);
  console.error(`start: undoDepth ${start.undoDepth}, bodies ${start.bodies.length}`);
  for (const [name, points] of Object.entries(profiles)) {
    for (const side of ["positive", "negative", "centered"]) {
      const before = await status(h);
      const made = JSON.parse(((await h.client.callTool({ name: "plasticity_create_box", arguments: { originMm: [2000, 190, 0], sizeMm: [40, 20, 3], revision: before.revision } })).content as Array<{ text: string }>)[0]!.text);
      const targetId = made.change?.added?.[0]?.id ?? made.added?.[0];
      const current = await status(h);
      const response = await h.client.callTool({ name: "plasticity_create_rib", arguments: { targetId, profilePointsMm: points, thicknessMm: THICKNESS, side, keepProfile: false, revision: current.revision } });
      const text = (response.content as Array<{ text: string }>)[0]!.text;
      let reply: { ribBoundsMm?: { min: V3; max: V3 } } = {};
      try { reply = JSON.parse(text); } catch { /* an error reply is plain text: recorded below */ }
      const want = predicted(points, side);
      const got = reply.ribBoundsMm as { min: V3; max: V3 } | undefined;
      const tol = name === "tilted30" ? 0.05 : 0.01;
      const match = response.isError !== true && got !== undefined && [0, 1, 2].every((i) => Math.abs(got.min[i]! - want.min[i]!) <= tol && Math.abs(got.max[i]! - want.max[i]!) <= tol);
      allMatch &&= match;
      cases.push({ profile: name, pointsMm: points.map((p) => p.map(r4)), side, thicknessMm: THICKNESS, rightHandNormal: want.normal, predictedBoundsMm: { min: want.min, max: want.max }, ribBoundsMm: got ?? null, matches: match, ...(response.isError ? { error: text.slice(0, 600) } : {}) });
      console.error(name, side, match ? "match" : "MISMATCH", JSON.stringify(got), JSON.stringify(want));
      const restored = await restore(h, start);
      if (!restored.ok) throw new Error(`document not restored: ${JSON.stringify(restored)}`);
    }
  }
  const end = await status(h);
  save("rib-direction-check.json", {
    measuredAt: new Date().toISOString(),
    claim: "positive thickness extrudes along the right-hand normal of the profile point order (counter-clockwise seen from the normal); negative the opposite way; centered splits it about the plane",
    allMatch, cases, startUndoDepth: start.undoDepth, endUndoDepth: end.undoDepth, startBodies: start.bodies.length, endBodies: end.bodies.length,
  });
  console.error(`allMatch ${allMatch}; end: undoDepth ${end.undoDepth}, bodies ${end.bodies.length}`);
} finally {
  await h.close();
}
