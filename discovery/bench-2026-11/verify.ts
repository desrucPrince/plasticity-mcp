// Independent verifiers. Rules: no plasticity_describe_body anywhere; every find_* read carries an explicit limit (1000);
// every check states its tolerance. Exact reads only: find_faces / find_edges, validate_bodies, check_interference,
// measure_solid_properties, measure_face_properties, analyze_surface_continuity, analyze_edge_curvature, face clearance.
import { type Session, type Check, type Face, type Edge, near, r3, facesOf, edgesOf, bnd, sum } from "./common.ts";

export type Box = { min: number[]; max: number[] };
export const unionBounds = (fs: Array<{ boundsMm: Box }>): Box => ({
  min: [0, 1, 2].map((k) => Math.min(...fs.map((f) => f.boundsMm.min[k]!))),
  max: [0, 1, 2].map((k) => Math.max(...fs.map((f) => f.boundsMm.max[k]!))),
});

export async function validateBodies(s: Session, ids: number[]) {
  const rev = await s.rev();
  const r = await s.call("plasticity_validate_bodies", { ids, revision: rev });
  return r.bodies as Array<{ id: number; type: string; closed: boolean; nativeValid: boolean; printableSolid: boolean; boundaryEdgeIds: string[]; nativeCheckCodes: string[] }>;
}
export const validCheck = (label: string, v: Awaited<ReturnType<typeof validateBodies>>[number] | undefined): Check => ({ check: `${label}: valid closed Solid (native B-Rep Check)`, ok: !!v && v.type === "Solid" && v.closed && v.nativeValid, tol: "exact (native Check)", actual: v ? { type: v.type, closed: v.closed, nativeValid: v.nativeValid, codes: v.nativeCheckCodes } : "missing" });

export type ContResult = { edgeId: string; faces: string[]; g0: boolean; g1: boolean; g2: boolean; achieved: string; posMm: number; normalDeg: number; relCurv: number };
// Native continuity along edges shared by exactly two faces. Edges the tool rejects are skipped (reported in `skipped`).
export async function continuity(s: Session, bodyId: number, edgeIds: string[], normalAngleToleranceDeg: number, positionToleranceMm = 0.05): Promise<{ results: ContResult[]; skipped: number }> {
  const results: ContResult[] = []; let skipped = 0;
  for (let i = 0; i < edgeIds.length; i += 40) {
    const chunk = edgeIds.slice(i, i + 40);
    const rev = await s.rev();
    try {
      const r = await s.call("plasticity_analyze_surface_continuity", { edges: chunk.map((e) => ({ bodyId, edgeId: e })), positionToleranceMm, normalAngleToleranceDeg, relativeCurvatureTolerance: 0.05, revision: rev });
      for (const a of r.analyses) results.push({ edgeId: a.edge.edgeId, faces: a.adjacentFaces.map((f: any) => f.faceId), g0: a.passes.G0, g1: a.passes.G1, g2: a.passes.G2, achieved: a.achievedContinuity, posMm: a.maximumPositionDeviationMm, normalDeg: a.maximumNormalAngleDeviationDeg, relCurv: a.maximumRelativeCurvatureDeviation });
    } catch {
      // one bad edge fails the chunk: retry one by one
      for (const e of chunk) {
        try {
          const rev2 = await s.rev();
          const r = await s.call("plasticity_analyze_surface_continuity", { edges: [{ bodyId, edgeId: e }], positionToleranceMm, normalAngleToleranceDeg, relativeCurvatureTolerance: 0.05, revision: rev2 });
          for (const a of r.analyses) results.push({ edgeId: a.edge.edgeId, faces: a.adjacentFaces.map((f: any) => f.faceId), g0: a.passes.G0, g1: a.passes.G1, g2: a.passes.G2, achieved: a.achievedContinuity, posMm: a.maximumPositionDeviationMm, normalDeg: a.maximumNormalAngleDeviationDeg, relCurv: a.maximumRelativeCurvatureDeviation });
        } catch { skipped += 1; }
      }
    }
  }
  return { results, skipped };
}

// ---------------------------------------------------------------------------------------------------------------
// S2: grip pad with a crowned top
export const S2P = { x0: 2000, y0: 0, L: 90, W: 50, rim: 8, crown: 14, bottomR: 1 };
export async function verifyS2(s: Session, bodyId: number, p = S2P): Promise<Check[]> {
  const out: Check[] = [];
  const cx = p.x0 + p.L / 2, cy = p.y0 + p.W / 2;
  const v = (await validateBodies(s, [bodyId]))[0];
  out.push(validCheck("pad", v));
  const faces = await facesOf(s, bodyId);
  // Body bounds from exact face bounds (the body-level box of a NURBS body is the control-point hull, not exact).
  const ub = unionBounds(faces);
  out.push(bnd("pad (union of exact face bounds)", ub, [p.x0, p.y0, 0], [p.x0 + p.L, p.y0 + p.W, p.crown], 0.2));
  const crown = [...faces].sort((a, b) => b.boundsMm.max[2]! - a.boundsMm.max[2]!)[0]!;
  const nonPlanar = !crown.planar && crown.surfaceType !== "Plane";
  out.push({ check: "top (highest) face is non-planar (BSpline or equivalent)", tol: "surfaceType != Plane", ok: nonPlanar, actual: { surfaceType: crown.surfaceType, planar: crown.planar } });
  // Highest point at the centre: the tool set cannot sample the peak (arbitrary sections fail on BSpline boundaries), so use
  // two exact surface-centre reads: the face centre point and the exact area centroid.
  let areaC: number[] | null = null;
  try { const rev = await s.rev(); const m = await s.call("plasticity_measure_face_properties", { faces: [{ bodyId, faceId: crown.id }], revision: rev }); areaC = m.faces?.[0]?.areaCentroidMm ?? m.totals?.areaWeightedCentroidMm ?? null; } catch { /* ignore */ }
  const centreOk = near(crown.centerMm[0]!, cx, 1) && near(crown.centerMm[1]!, cy, 1) && (areaC == null || (near(areaC[0]!, cx, 1) && near(areaC[1]!, cy, 1)));
  out.push({ check: "crown peak at the plan centre (closest objective: crown face centre point and area centroid; a true peak read is impossible, sections fail on BSpline boundaries)", tol: "+-1 mm in x,y", ok: centreOk, actual: { faceCentre: crown.centerMm.map(r3), areaCentroid: areaC?.map(r3) } });
  out.push({ check: "crown peak height 14 (crown face exact bounds max z)", tol: "+-0.2 mm", ok: near(crown.boundsMm.max[2]!, p.crown, 0.2), actual: r3(crown.boundsMm.max[2]!) });
  // Rim height at the four side midpoints: highest z among non-crown faces whose plan box contains the midpoint (+-1 mm).
  const mids: Array<[string, number, number]> = [["x-", p.x0, cy], ["x+", p.x0 + p.L, cy], ["y-", cx, p.y0], ["y+", cx, p.y0 + p.W]];
  const rim = mids.map(([n, x, y]) => {
    const near4 = faces.filter((f) => f.id !== crown.id && f.boundsMm.min[0]! <= x + 1 && f.boundsMm.max[0]! >= x - 1 && f.boundsMm.min[1]! <= y + 1 && f.boundsMm.max[1]! >= y - 1);
    const wall = near4.filter((f) => f.planar && f.normal && Math.abs(f.normal[2]!) < 0.2);
    return { n, top: near4.length ? Math.max(...near4.map((f) => f.boundsMm.max[2]!)) : NaN, wallTop: wall.length ? Math.max(...wall.map((f) => f.boundsMm.max[2]!)) : NaN };
  });
  out.push({ check: "rim height 8 at the four side midpoints: either the top of the rim blend (highest non-crown face within 1 mm of the midpoint) or the top of the vertical side wall is 8", tol: "+-0.3 mm", ok: rim.every((r) => near(r.top, p.rim, 0.3) || near(r.wallTop, p.rim, 0.3)), actual: rim.map((r) => ({ at: r.n, blendTopZ: r3(r.top), wallTopZ: r3(r.wallTop) })) });
  // Continuity between the crown and everything it touches.
  const ce = await edgesOf(s, bodyId, { adjacentFaceIds: [crown.id] });
  const c = await continuity(s, bodyId, ce.map((e) => e.id), 1.0);
  const worst = c.results.length ? Math.max(...c.results.map((r) => r.normalDeg)) : NaN;
  const g1 = c.results.length > 0 && c.results.length === ce.length && c.results.every((r) => r.g1);
  const g2 = c.results.length > 0 && c.results.every((r) => r.g2);
  out.push({ check: "crown continuity to its neighbours >= G1 (plasticity_analyze_surface_continuity; threshold normal angle <= 1.0 deg, position <= 0.05 mm)", tol: "G1: <=1.0 deg normal, <=0.05 mm position", ok: g1, actual: { edges: ce.length, analysed: c.results.length, worstNormalDeg: r3(worst), found: g2 ? "G2" : g1 ? "G1" : c.results.every((r) => r.g0) ? "G0" : "none" } });
  out.push({ check: "crown reaches G2 (requested level; informational)", soft: true, tol: "relative curvature <= 0.05", ok: g2, actual: { worstRelCurv: c.results.length ? r3(Math.max(...c.results.map((r) => r.relCurv))) : null } });
  // Bottom: flat, edges rounded R1.
  const bottom = faces.filter((f) => f.planar && f.normal && f.normal[2]! < -0.99 && near(f.centerMm[2]!, 0, 0.05));
  out.push({ check: "flat bottom at z=0", tol: "+-0.05 mm", ok: bottom.length >= 1, actual: bottom.length });
  const r1 = faces.filter((f) => !f.planar && f.radiusMm != null && near(f.radiusMm, p.bottomR, 0.05) && f.boundsMm.min[2]! <= 0.05 && f.boundsMm.max[2]! <= 1.1);
  out.push({ check: "bottom edges rounded R1 (cylindrical/toroidal faces r=1 touching z=0, at least 8 for a rounded rectangle: 4 sides + 4 corners)", tol: "radius +-0.05 mm", ok: r1.length >= 8, actual: r1.length });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// S3: N-sided corner patch. holeMid = analytic mid points of the three hole edges (from the harness builder, not from the model).
export const S3_G1_DEG = 1.0; // calibrated on the deterministic reference closure (see reference-s3-selftest.json)
export async function verifyS3(s: Session, bodyId: number, holeMid: number[][]): Promise<Check[]> {
  const out: Check[] = [];
  const edges = await edgesOf(s, bodyId);
  const faces = await facesOf(s, bodyId);
  const found = holeMid.map((m) => edges.find((e) => Math.hypot(e.centerMm[0]! - m[0]!, e.centerMm[1]! - m[1]!, e.centerMm[2]! - m[2]!) <= 0.01));
  out.push({ check: "the three hole edges are still edges of the final body (centres at the analytic hole-edge midpoints)", tol: "+-0.01 mm", ok: found.every(Boolean), actual: found.map((e) => e?.id ?? null) });
  const faceIdsOf = (e?: Edge) => ((e as unknown as { faceIds?: string[] })?.faceIds ?? []);
  const shared = found.every(Boolean) ? found.map((e) => faceIdsOf(e)) : [];
  const allTwo = shared.length === 3 && shared.every((f) => f.length === 2);
  out.push({ check: "every hole edge is shared by exactly two faces (hole closed and joined to the neighbours)", tol: "exact topology", ok: allTwo, actual: shared.map((f) => f.length) });
  // The patch face: the face that touches all three hole edges and is not one of the three sheet faces (sheet faces touch one hole edge each).
  const count = new Map<string, number>(); for (const f of shared) for (const id of f) count.set(id, (count.get(id) ?? 0) + 1);
  const patchId = [...count.entries()].find(([, n]) => n === 3)?.[0];
  const patch = faces.find((f) => f.id === patchId);
  out.push({ check: "one patch face whose boundary is exactly the three hole edges", tol: "+-0.01 mm (edge centres) + edge count 3", ok: !!patch && ((patch as unknown as { edgeIds?: string[] }).edgeIds?.length ?? 0) === 3, actual: patch ? { id: patch.id, surfaceType: patch.surfaceType, edges: (patch as unknown as { edgeIds?: string[] }).edgeIds?.length } : "none" });
  if (found.every(Boolean)) {
    const c = await continuity(s, bodyId, found.map((e) => e!.id), S3_G1_DEG, 0.05);
    out.push({ check: `continuity per hole edge >= G1 (analyze_surface_continuity; normal angle <= ${S3_G1_DEG} deg, position <= 0.05 mm)`, tol: `G1: <=${S3_G1_DEG} deg, <=0.05 mm`, ok: c.results.length === 3 && c.results.every((r) => r.g1), actual: c.results.map((r) => ({ edge: r.edgeId, found: r.achieved, normalDeg: r3(r.normalDeg), posMm: Number(r.posMm.toExponential(2)), relCurv: r3(r.relCurv) })) });
    out.push({ check: "continuity reaches G2 on all hole edges (informational)", soft: true, tol: "relative curvature <= 0.05", ok: c.results.length === 3 && c.results.every((r) => r.g2) });
  } else out.push({ check: `continuity per hole edge >= G1 (threshold ${S3_G1_DEG} deg)`, ok: false, actual: "hole edges missing" });
  const v = (await validateBodies(s, [bodyId]))[0];
  const free = v?.boundaryEdgeIds.length ?? -1;
  out.push({ check: "joined body valid (native Check) and watertight as far as possible: only the 3 outer rim edges are free (or 0 if closed to a solid)", tol: "free edges == 3 or 0", ok: !!v && v.nativeValid && (free === 3 || (free === 0 && v.closed)), actual: v ? { type: v.type, nativeValid: v.nativeValid, closed: v.closed, freeEdges: free } : "missing" });
  out.push({ check: "face count 4 (3 neighbour sheets + 1 patch; informational)", soft: true, tol: "exact", ok: faces.length === 4, actual: faces.length });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// S1: blended nacelle. Sections cannot be read with plasticity_inspect_arbitrary_section when the section boundary is a BSpline
// ("invalid-section-boundary"), so stations are measured by intersecting a verifier-made thin slab with a COPY of the body and reading
// the exact face bounds of the slab piece. The copy and the slab are removed by the harness restore (undo to the baseline depth).
export const S1P = { x0: 2000, len: 120, cy: 0, cz: 30, d0: 40, d1: 20, w: 60, h: 30, wall: 2 };
async function stationExtents(s: Session, bodyId: number, x: number, p = S1P) {
  const dy = 500; // work on a copy far away in y so the original is untouched
  const r = await s.batch([
    { toolName: "plasticity_duplicate_bodies", arguments: { ids: [bodyId], translationMm: [0, dy, 0] } },
    { toolName: "plasticity_create_box", arguments: { originMm: [x - 0.1, p.cy + dy - 60, p.cz - 60], sizeMm: [0.2, 120, 120] } },
    { toolName: "plasticity_boolean", arguments: { targetIds: ["$0.added[0]"], toolIds: ["$1.added[0]"], operation: "intersection" } },
  ], {});
  const copyId = r.steps[0].added[0] as number;
  const fs = await facesOf(s, copyId);
  const planar = fs.filter((f) => f.planar);
  const curved = fs.filter((f) => !f.planar);
  if (!planar.length || curved.length < 1) return null;
  const outer = unionBounds(planar); // slab faces carry the outer section extents
  const ext = (b: Box) => ({ y: b.max[1]! - b.min[1]!, z: b.max[2]! - b.min[2]! });
  const innerCurved = curved.map((f) => ({ f, e: ext(f.boundsMm) })).sort((a, b) => a.e.y - b.e.y)[0]!;
  return { outer: ext(outer), inner: curved.length >= 2 ? innerCurved.e : null };
}
export async function verifyS1(s: Session, bodyId: number, p = S1P): Promise<Check[]> {
  const out: Check[] = [];
  const v = (await validateBodies(s, [bodyId]))[0];
  out.push(validCheck("nacelle", v));
  const faces = await facesOf(s, bodyId);
  const ub = unionBounds(faces);
  out.push({ check: "length 120 along x (union of exact face bounds)", tol: "+-0.5 mm", ok: near(ub.min[0]!, p.x0, 0.5) && near(ub.max[0]!, p.x0 + p.len, 0.5), actual: [r3(ub.min[0]!), r3(ub.max[0]!)] });
  out.push({ check: "section extents: width (y) 60, height (z) 40 (largest sections: mid station and the O40 end)", tol: "+-1.0 mm (loft overshoot allowance)", ok: near(ub.max[1]! - ub.min[1]!, p.w, 1) && near(ub.max[2]! - ub.min[2]!, p.d0, 1), actual: { y: r3(ub.max[1]! - ub.min[1]!), z: r3(ub.max[2]! - ub.min[2]!) } });
  // End openings: annular planar rim faces at the end planes; outer extents from face bounds, inner diameter from the exact face area.
  const rimAt = (x: number) => faces.filter((f) => f.planar && f.normal && Math.abs(f.normal[0]!) > 0.99 && near(f.centerMm[0]!, x, 0.3));
  for (const [x, d, label] of [[p.x0, p.d0, "start"], [p.x0 + p.len, p.d1, "end"]] as Array<[number, number, string]>) {
    const rims = rimAt(x);
    let areaOk = false, area: number | null = null, extOk = false;
    if (rims.length === 1) {
      const rev = await s.rev();
      const m = await s.call("plasticity_measure_face_properties", { faces: [{ bodyId, faceId: rims[0]!.id }], revision: rev });
      area = m.faces?.[0]?.areaMm2 ?? m.totals?.areaMm2 ?? null;
      const want = Math.PI * ((d / 2) ** 2 - (d / 2 - p.wall) ** 2);
      areaOk = area != null && Math.abs(area - want) <= 0.12 * want;
      extOk = near(rims[0]!.boundsMm.max[1]! - rims[0]!.boundsMm.min[1]!, d, 0.5) && near(rims[0]!.boundsMm.max[2]! - rims[0]!.boundsMm.min[2]!, d, 0.5);
    }
    out.push({ check: `${label} end open: one annular rim at x=${x}, outer circle O${d}, inner O${d - 2 * p.wall} (area of the ring = pi*(ro^2-ri^2))`, tol: "diameter +-0.5 mm; ring area +-12% (the 2 mm wall is normal to the sloped skin, so the in-plane ring at the O20 end is about 8% wider)", ok: rims.length === 1 && areaOk && extOk, actual: { rimFaces: rims.length, areaMm2: area == null ? null : r3(area) } });
  }
  // Station sections through a slab copy: width/height at the mid station and wall thickness at three stations.
  const stations = [p.x0 + 30, p.x0 + 60, p.x0 + 90];
  const sec: Array<Awaited<ReturnType<typeof stationExtents>>> = [];
  for (const x of stations) { try { sec.push(await stationExtents(s, bodyId, x, p)); } catch (e) { sec.push(null); } }
  const mid = sec[1];
  out.push({ check: "mid-station (x=2060) section is 60 x 30 (exact bounds of a 0.2 mm slab cut through a copy)", tol: "+-0.5 mm", ok: !!mid && near(mid.outer.y, p.w, 0.5) && near(mid.outer.z, p.h, 0.5), actual: mid ? { y: r3(mid.outer.y), z: r3(mid.outer.z) } : "slab cut failed" });
  const wall = sec.map((e) => (e && e.inner ? { y: (e.outer.y - e.inner.y) / 2, z: (e.outer.z - e.inner.z) / 2 } : null));
  out.push({ check: "wall thickness 2 at three stations (x=2030, 2060, 2090), from outer minus inner slab extents; slope allowance included", tol: "+-0.2 mm (0.1 plus up to 0.1 mm for the surface slope)", ok: wall.every((w) => !!w && near(w.y, p.wall, 0.2) && near(w.z, p.wall, 0.2)), actual: wall.map((w) => (w ? { y: r3(w.y), z: r3(w.z) } : null)) });
  // Mean wall thickness from exact volume / mean lateral area.
  try {
    const rev = await s.rev();
    const sp = await s.call("plasticity_measure_solid_properties", { ids: [bodyId], revision: rev });
    const vol = sp.bodies[0].volumeMm3 as number;
    const lat = faces.filter((f) => !f.planar);
    const m = await s.call("plasticity_measure_face_properties", { faces: lat.map((f) => ({ bodyId, faceId: f.id })), revision: await s.rev() });
    const areas: number[] = (m.faces ?? []).map((f: any) => f.areaMm2);
    const meanA = areas.length ? sum(areas) / areas.length : NaN;
    const t = lat.length === 2 ? vol / meanA : NaN;
    out.push({ check: "mean wall thickness 2 (exact volume / mean of the outer and inner lateral areas; needs exactly 2 lateral faces)", tol: "+-0.1 mm", ok: near(t, p.wall, 0.1), actual: { volumeMm3: r3(vol), lateralFaces: lat.length, meanThickness: r3(t) } });
  } catch (e) { out.push({ check: "mean wall thickness 2 (volume / mean lateral area)", tol: "+-0.1 mm", ok: false, actual: String(e).slice(0, 200) }); }
  // Lateral seams and creases. Edges shared by two NON-planar faces must be G1 (<= 1.0 deg); no planar lateral face may exist.
  const lateralPlanar = faces.filter((f) => f.planar && !(f.normal && Math.abs(f.normal[0]!) > 0.99 && (near(f.centerMm[0]!, p.x0, 0.3) || near(f.centerMm[0]!, p.x0 + p.len, 0.3))));
  out.push({ check: "no planar lateral faces (only the two end rims are planar)", tol: "face type", ok: lateralPlanar.length === 0, actual: lateralPlanar.length });
  const nonPlanar = faces.filter((f) => !f.planar);
  const cnt = new Map<string, number>(); for (const f of nonPlanar) for (const e of ((f as unknown as { edgeIds?: string[] }).edgeIds ?? [])) cnt.set(e, (cnt.get(e) ?? 0) + 1);
  const seams = [...cnt.entries()].filter(([, n]) => n >= 2).map(([e]) => e);
  const c = seams.length ? await continuity(s, bodyId, seams, 1.0) : { results: [] as ContResult[], skipped: 0 };
  const worst = c.results.length ? Math.max(...c.results.map((r) => r.normalDeg)) : 0;
  out.push({ check: "lateral surface is tangent-continuous along its length: every seam between two non-planar faces is G1 (analyze_surface_continuity; normal angle <= 1.0 deg, position <= 0.05 mm); vacuous when the lateral is one face", tol: "<=1.0 deg", ok: c.results.every((r) => r.g1) && c.skipped === 0, actual: { seams: seams.length, analysed: c.results.length, skipped: c.skipped, worstNormalDeg: r3(worst), lateralFaces: nonPlanar.length } });
  return out;
}
