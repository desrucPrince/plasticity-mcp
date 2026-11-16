// Deterministic reference builds (harness-written, no model): S2 grip pad, S1 nacelle (verifier proof), S3 neighbour sheets, M assembly.
// A reference build must pass 100% of its own verifier checks, otherwise the verifier is wrong.

export type Step = { toolName: string; arguments: Record<string, unknown> };
export class Steps { list: Step[] = []; add(toolName: string, args: Record<string, unknown>) { this.list.push({ toolName, arguments: args }); return this.list.length - 1; } }
export const added = (i: number, k = 0) => `$${i}.added[${k}]`;
export const matchIds = (i: number) => `$${i}.result.matches[*].id`;

// ---------------- S2 grip pad: 90 x 50 rr R12, 8 mm rim, 14 mm crown, flat bottom, bottom edges R1 ----------------
export const S2 = { x0: 2000, y0: 0, L: 90, W: 50, rimH: 8, crownH: 14, corner: 12, topRound: 2, bottomR: 1 };
export function s2Reference(p = S2) {
  const s = new Steps();
  const cx = p.x0 + p.L / 2, cy = p.y0 + p.W / 2;
  const pad = s.add("plasticity_create_box", { originMm: [p.x0, p.y0, 0], sizeMm: [p.L, p.W, p.rimH], name: "grip-pad" });
  const v = s.add("plasticity_find_edges", { query: { bodyIds: [added(pad)], line: true, direction: { vector: [0, 0, 1] } }, limit: 50 });
  s.add("plasticity_fillet", { id: added(pad), edgeIds: matchIds(v), radiusMm: p.corner });
  const top1 = s.add("plasticity_find_faces", { query: { bodyIds: [added(pad)], planar: true, normal: { vector: [0, 0, 1] } }, sortBy: "z", order: "desc", limit: 1 });
  s.add("plasticity_fillet", { id: added(pad), edgeIds: `$${top1}.result.matches[0].edgeIds`, radiusMm: p.topRound });
  const top2 = s.add("plasticity_find_faces", { query: { bodyIds: [added(pad)], planar: true, normal: { vector: [0, 0, 1] } }, sortBy: "z", order: "desc", limit: 1 });
  const guide = s.add("plasticity_create_nurbs_curve", { pointsMm: [[p.x0 + 12, cy, p.rimH], [p.x0 + 28, cy, 12.5], [cx, cy, p.crownH], [p.x0 + p.L - 28, cy, 12.5], [p.x0 + p.L - 12, cy, p.rimH]] });
  const patch = s.add("plasticity_xsided_patch", { edges: { bodyId: added(pad), edgeIds: `$${top2}.result.matches[0].edgeIds` }, continuity: "g1", guideIds: [added(guide)] });
  s.add("plasticity_delete_faces", { faces: [{ bodyId: added(pad), faceId: `$${top2}.result.matches[0].id` }] });
  s.add("plasticity_join_sheets", { ids: [added(pad), added(patch)] });
  const bot = s.add("plasticity_find_faces", { query: { bodyIds: [added(pad)], planar: true, normal: { vector: [0, 0, -1] } }, sortBy: "z", order: "asc", limit: 1 });
  s.add("plasticity_fillet", { id: added(pad), edgeIds: `$${bot}.result.matches[0].edgeIds`, radiusMm: p.bottomR });
  s.add("plasticity_delete", { ids: [added(guide)] });
  return { steps: s.list, padStep: pad };
}

// ---------------- S3: three lofted neighbour sheets around a 3-sided hole at the summit of a fairing ----------------
// Hole vertices V_i sit on a circle (radius r, height h, angles 90/210/330 deg). Each sheet i spans from its hole edge e_i (V_i -> V_i+1,
// a cubic Bezier with horizontal end tangents) to an outer edge o_i (U_i -> U_i+1), U_i = V_i + L * rho_i, rho_i = outward*cos(phi) - z*sin(phi).
// Every sheet is therefore tangent to the plane span(tau_i, rho_i) at V_i: the three sheets agree at the hole vertices, so a G1 patch exists.
export const S3 = { cx: 2040, cy: 30, h: 28, r: 12, L: 30, phiDeg: 20, angles: [90, 210, 330] };
export type V3 = [number, number, number];
export function s3Geometry(p = S3) {
  const phi = (p.phiDeg * Math.PI) / 180;
  const out = p.angles.map((a) => [Math.cos((a * Math.PI) / 180), Math.sin((a * Math.PI) / 180)] as [number, number]);
  const tau = out.map(([ox, oy]) => [-oy, ox, 0] as V3); // counter-clockwise horizontal tangent
  const V = out.map(([ox, oy]) => [p.cx + p.r * ox, p.cy + p.r * oy, p.h] as V3);
  const rho = out.map(([ox, oy]) => [ox * Math.cos(phi), oy * Math.cos(phi), -Math.sin(phi)] as V3);
  const U = V.map((v, i) => [v[0] + p.L * rho[i]![0], v[1] + p.L * rho[i]![1], v[2] + p.L * rho[i]![2]] as V3);
  const add = (a: V3, b: V3, k: number): V3 => [a[0] + k * b[0], a[1] + k * b[1], a[2] + k * b[2]];
  const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const edgeCtrl = (A: V3, B: V3, tA: V3, tB: V3): V3[] => { const k = dist(A, B) / 3; return [A, add(A, tA, k), add(B, tB, -k), B]; };
  const hole = [0, 1, 2].map((i) => edgeCtrl(V[i]!, V[(i + 1) % 3]!, tau[i]!, tau[(i + 1) % 3]!));
  const outer = [0, 1, 2].map((i) => edgeCtrl(U[i]!, U[(i + 1) % 3]!, tau[i]!, tau[(i + 1) % 3]!));
  const mid = (c: V3[]): V3 => [0, 1, 2].map((k) => (c[0]![k]! + 3 * c[1]![k]! + 3 * c[2]![k]! + c[3]![k]!) / 8) as V3; // Bezier(0.5)
  return { V, U, hole, outer, holeMid: hole.map(mid), outerMid: outer.map(mid) };
}
export function s3Builder(p = S3) {
  const g = s3Geometry(p);
  const s = new Steps();
  const holeCurves = g.hole.map((c, i) => s.add("plasticity_create_control_point_curve", { pointsMm: c }));
  const outerCurves = g.outer.map((c) => s.add("plasticity_create_control_point_curve", { pointsMm: c }));
  const sheets = [0, 1, 2].map((i) => s.add("plasticity_loft_curves", { profileIds: [added(holeCurves[i]!), added(outerCurves[i]!)], curvature: "natural" }));
  sheets.forEach((st, i) => s.add("plasticity_rename", { id: added(st), name: `s3-sheet-${i + 1}` }));
  s.add("plasticity_delete", { ids: [...holeCurves, ...outerCurves].map((i) => added(i)) }); // keep only the three sheets in the document
  return { steps: s.list, sheets, holeCurves, outerCurves, geometry: g };
}
// Reference closure of the hole: join the three sheets, X-sided patch G1 on the three hole edges, join the patch in.
export function s3Reference(p = S3) {
  const b = s3Builder(p);
  const s = new Steps(); s.list = b.steps;
  const first = b.sheets[0]!;
  s.add("plasticity_join_sheets", { ids: b.sheets.map((i) => added(i)) });
  const q = b.geometry.holeMid.map((m) => s.add("plasticity_find_edges", { query: { bodyIds: [added(first)], center: { pointMm: m, toleranceMm: 0.2 } }, limit: 1 }));
  const patch = s.add("plasticity_xsided_patch", { edges: { bodyId: added(first), edgeIds: q.map((i) => `$${i}.result.matches[0].id`) }, continuity: "g1" });
  s.add("plasticity_join_sheets", { ids: [added(first), added(patch)] });
  return { steps: s.list, bodyStep: first, geometry: b.geometry };
}

// ---------------- S1 blended nacelle (verifier proof build): O40 circle -> 60x30 R8 rounded rectangle -> O20 circle ----------------
export const S1 = { x0: 2000, len: 120, cy: 0, cz: 30, d0: 40, d1: 20, w: 60, h: 30, rr: 8, wall: 2 };
function rrPoints(w: number, h: number, r: number, n = 4): Array<[number, number]> {
  // closed rounded rectangle sampled counter-clockwise: each corner arc sampled with n+1 points
  const pts: Array<[number, number]> = [];
  const hx = w / 2, hy = h / 2;
  const corners: Array<[number, number, number]> = [[hx - r, hy - r, 0], [-(hx - r), hy - r, 90], [-(hx - r), -(hy - r), 180], [hx - r, -(hy - r), 270]];
  for (const [cx, cy, a0] of corners) for (let k = 0; k <= n; k++) { const a = ((a0 + (90 * k) / n) * Math.PI) / 180; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return pts;
}
function circPoints(d: number, n = 16): Array<[number, number]> { return Array.from({ length: n }, (_, k) => [(d / 2) * Math.cos((2 * Math.PI * k) / n), (d / 2) * Math.sin((2 * Math.PI * k) / n)]); }
export function s1Reference(p = S1) {
  const s = new Steps();
  const sec = (x: number, pts: Array<[number, number]>) => s.add("plasticity_create_nurbs_curve", { pointsMm: pts.map(([y, z]) => [x, p.cy + y, p.cz + z]), closed: true });
  const a = sec(p.x0, circPoints(p.d0, 20));
  const b = sec(p.x0 + p.len / 2, rrPoints(p.w, p.h, p.rr, 4));
  const c = sec(p.x0 + p.len, circPoints(p.d1, 20));
  const loft = s.add("plasticity_loft_curves", { profileIds: [added(a), added(b), added(c)], curvature: "natural" });
  s.add("plasticity_cap_sheet_holes", { ids: [added(loft)] });
  const solid = loft; // cap_sheet_holes already closes the loft into a Solid
  const endA = s.add("plasticity_find_faces", { query: { bodyIds: [added(solid)], planar: true, normal: { vector: [-1, 0, 0] } }, limit: 5 });
  const endB = s.add("plasticity_find_faces", { query: { bodyIds: [added(solid)], planar: true, normal: { vector: [1, 0, 0] } }, limit: 5 });
  s.add("plasticity_hollow_faces", { id: added(solid), faceIds: [`$${endA}.result.matches[0].id`, `$${endB}.result.matches[0].id`], wallThicknessMm: p.wall, direction: "inward" });
  return { steps: s.list, solidStep: solid, curveSteps: [a, b, c], loftStep: loft };
}
