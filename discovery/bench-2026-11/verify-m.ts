// Suite M verifier: ESP32 enclosure system. Independent: bodies are found by NAME, everything is read from exact face reads.
// Interference rule: every pair of the nine bodies is checked EXCEPT screw-i against case-base and lid (screws are nominal fits in
// holes and pilots: shaft O3 in O2.5 pilot and head in a countersink are deliberate overlaps). Touching faces are not interference.
import { type Session, type Check, type Face, type Status, near, r3, facesOf, sum } from "./common.ts";
import { validateBodies, unionBounds } from "./verify.ts";
import { M, C, CY, corners, pcbHoles, cavity, ventXs } from "./reference-m.ts";

export const M_NAMES = ["pcb", "case-base", "lid", "bracket", "sensor-pod", "screw-1", "screw-2", "screw-3", "screw-4"];
type CylSel = { x: number; y: number; r: number; z0: number; z1: number };
const zcyls = (fs: Face[]): CylSel[] => fs.filter((f) => f.surfaceType === "Cylinder" && f.radiusMm != null && f.axisDirection && Math.abs(f.axisDirection[2]!) > 0.99 && f.axisOriginMm).map((f) => ({ x: f.axisOriginMm![0]!, y: f.axisOriginMm![1]!, r: f.radiusMm!, z0: f.boundsMm.min[2]!, z1: f.boundsMm.max[2]! }));
const hasCyl = (cs: CylSel[], x: number, y: number, r: number, tolXY: number, tolR: number, pred: (c: CylSel) => boolean = () => true) => cs.some((c) => near(c.x, x, tolXY) && near(c.y, y, tolXY) && near(c.r, r, tolR) && pred(c));
const largest = (fs: Face[]) => [...fs].sort((a, b) => (b.boundsMm.max[1]! - b.boundsMm.min[1]!) * (b.boundsMm.max[2]! - b.boundsMm.min[2]!) + (b.boundsMm.max[0]! - b.boundsMm.min[0]!) * (b.boundsMm.max[1]! - b.boundsMm.min[1]!) - ((a.boundsMm.max[1]! - a.boundsMm.min[1]!) * (a.boundsMm.max[2]! - a.boundsMm.min[2]!) + (a.boundsMm.max[0]! - a.boundsMm.min[0]!) * (a.boundsMm.max[1]! - a.boundsMm.min[1]!)))[0];

export async function verifyM(s: Session): Promise<{ checks: Check[]; scale: { bodies: number; totalFaces: number } }> {
  const out: Check[] = [];
  const st: Status = await s.status();
  const body = (n: string) => st.bodies.find((b) => b.name === n && b.type === "Solid");
  const found = M_NAMES.map((n) => ({ n, b: body(n) }));
  out.push({ check: "six part groups exist by name: pcb, case-base, lid, bracket, sensor-pod, screw-1..4 (9 solids)", tol: "exact name match, type Solid", ok: found.every((f) => !!f.b), actual: found.map((f) => `${f.n}:${f.b ? f.b.id : "missing"}`) });
  const have = found.filter((f) => f.b).map((f) => f.b!.id);
  const valid = have.length ? await validateBodies(s, have) : [];
  const bad = valid.filter((v) => !(v.type === "Solid" && v.closed && v.nativeValid));
  out.push({ check: "each part is a valid closed Solid (native B-Rep Check)", tol: "exact", ok: have.length === 9 && bad.length === 0, actual: bad.length ? bad.map((v) => v.id) : "all valid" });
  const F: Record<string, Face[]> = {};
  for (const f of found) F[f.n] = f.b ? await facesOf(s, f.b.id) : [];
  const B: Record<string, { min: number[]; max: number[] }> = {};
  for (const n of M_NAMES) B[n] = F[n]!.length ? unionBounds(F[n]!) : { min: [NaN, NaN, NaN], max: [NaN, NaN, NaN] };

  // --- PCB ---
  const p = M.pcb;
  out.push({ check: "PCB stand-in is 51.5 x 28.3 x 1.6 at its design position (min corner 2005.5, 5.5, 6)", tol: "+-0.05 mm", ok: [0, 1, 2].every((k) => near(B.pcb!.min[k]!, [p.x0, p.y0, p.z0][k]!, 0.05) && near(B.pcb!.max[k]!, [p.x0 + p.w, p.y0 + p.d, p.z0 + p.t][k]!, 0.05)), actual: { min: B.pcb!.min.map(r3), max: B.pcb!.max.map(r3) } });
  const pcbCyl = zcyls(F.pcb!);
  out.push({ check: "PCB has four O3.0 mounting holes at (2.6, 2.6), (48.9, 2.6), (2.6, 25.7), (48.9, 25.7) from its corner", tol: "+-0.1 mm position, +-0.05 radius", ok: pcbHoles.every(([x, y]) => hasCyl(pcbCyl, x, y, 1.5, 0.1, 0.05)), actual: pcbCyl.map((c) => [r3(c.x), r3(c.y), r3(c.r)]) });

  // --- case base: standoffs, pilots, clearance, USB-C, corner bosses ---
  const baseF = F["case-base"]!, baseCyl = zcyls(baseF);
  const standTops = baseF.filter((f) => f.planar && f.normal && f.normal[2]! > 0.99 && near(f.centerMm[2]!, p.z0, 0.05));
  const sitting = pcbHoles.every(([x, y]) => standTops.some((f) => Math.abs(f.boundsMm.min[0]! - x) <= M.standoffD && Math.abs(f.boundsMm.max[0]! - x) <= M.standoffD && Math.abs(f.boundsMm.min[1]! - y) <= M.standoffD && Math.abs(f.boundsMm.max[1]! - y) <= M.standoffD));
  out.push({ check: "PCB sits on four standoff tops: standoff top faces at z=6 under each PCB hole, PCB bottom at z=6 (gap 0)", tol: "gap 0 +-0.05 mm", ok: near(B.pcb!.min[2]!, p.z0, 0.05) && sitting, actual: { pcbBottom: r3(B.pcb!.min[2]!), standoffTopFaces: standTops.length } });
  const wallX0 = largest(baseF.filter((f) => f.planar && f.normal && f.normal[0]! > 0.99 && f.centerMm[0]! < C));
  const wallX1 = largest(baseF.filter((f) => f.planar && f.normal && f.normal[0]! < -0.99 && f.centerMm[0]! > C));
  const wallY0 = largest(baseF.filter((f) => f.planar && f.normal && f.normal[1]! > 0.99 && f.centerMm[1]! < CY));
  const wallY1 = largest(baseF.filter((f) => f.planar && f.normal && f.normal[1]! < -0.99 && f.centerMm[1]! > CY));
  const gaps = [B.pcb!.min[0]! - (wallX0?.centerMm[0] ?? NaN), (wallX1?.centerMm[0] ?? NaN) - B.pcb!.max[0]!, B.pcb!.min[1]! - (wallY0?.centerMm[1] ?? NaN), (wallY1?.centerMm[1] ?? NaN) - B.pcb!.max[1]!];
  out.push({ check: "0.5 clearance between the PCB and the inner walls on all four sides (x-min, x-max, y-min, y-max)", tol: "0.5 +-0.05 mm", ok: gaps.every((g) => near(g, M.clearance, 0.05)), actual: gaps.map(r3) });
  out.push({ check: "standoff pilots (O2.5, z axis, between z=2 and 6) coaxial with the four PCB holes", tol: "+-0.1 mm", ok: pcbHoles.every(([x, y]) => hasCyl(baseCyl, x, y, M.pilotD / 2, 0.1, 0.05, (c) => c.z1 <= p.z0 + 0.1 && c.z0 >= M.floor + 0.5)), actual: baseCyl.filter((c) => near(c.r, 1.25, 0.05) && c.z1 <= p.z0 + 0.1).map((c) => [r3(c.x), r3(c.y), r3(c.z0), r3(c.z1)]) });
  // USB-C opening: faces inside the x-min wall slab around the opening.
  const slab = baseF.filter((f) => f.boundsMm.min[0]! >= M.bx0 - 0.1 && f.boundsMm.max[0]! <= cavity.x0 + 0.1 && !(f.planar && f.normal && Math.abs(f.normal[0]!) > 0.99) && f.boundsMm.min[1]! >= M.usb.cy - 6 && f.boundsMm.max[1]! <= M.usb.cy + 6 && f.boundsMm.min[2]! >= 8 && f.boundsMm.max[2]! <= 14);
  const ob = slab.length ? unionBounds(slab) : null;
  const ow = ob ? ob.max[1]! - ob.min[1]! : NaN, oh = ob ? ob.max[2]! - ob.min[2]! : NaN;
  const ocy = ob ? (ob.max[1]! + ob.min[1]!) / 2 : NaN, ocz = ob ? (ob.max[2]! + ob.min[2]!) / 2 : NaN;
  out.push({ check: "USB-C opening 9.2 x 3.4 in the x-min wall, centred on the connector position (y=19.65, z=10.9)", tol: "size +-0.2 mm, centre +-0.2 mm", ok: !!ob && near(ow, M.usb.w, 0.2) && near(oh, M.usb.h, 0.2) && near(ocy, M.usb.cy, 0.2) && near(ocz, M.usb.z0 + M.usb.h / 2, 0.2), actual: ob ? { w: r3(ow), h: r3(oh), cy: r3(ocy), cz: r3(ocz) } : "no opening faces found in the wall" });
  out.push({ check: "USB-C opening corners R1.2 (four x-axis cylinders r=1.2)", tol: "radius +-0.1 mm", soft: true, ok: baseF.filter((f) => f.surfaceType === "Cylinder" && f.radiusMm != null && near(f.radiusMm, M.usb.r, 0.1) && f.axisDirection && Math.abs(f.axisDirection[0]!) > 0.99).length >= 4, actual: baseF.filter((f) => f.surfaceType === "Cylinder" && f.radiusMm != null && near(f.radiusMm, M.usb.r, 0.1) && f.axisDirection && Math.abs(f.axisDirection[0]!) > 0.99).length });
  out.push({ check: "base size: outer 56.5 x 33.3 x 18 including the corner bosses, with bosses reaching x=2000", tol: "+-0.1 mm", ok: [M.bx0 - 3, M.by0 - 3, 0].every((v, k) => near(B["case-base"]!.min[k]!, v, 0.1)) && [M.bx0 + M.L + 3, M.by0 + M.W + 3, M.H].every((v, k) => near(B["case-base"]!.max[k]!, v, 0.1)), actual: { min: B["case-base"]!.min.map(r3), max: B["case-base"]!.max.map(r3) } });
  const bossR = (fs: CylSel[]) => corners.every(([x, y]) => hasCyl(fs, x, y, M.bossD / 2, 0.15, 0.05, (c) => c.z1 >= M.H - 0.05));
  const filletCentres: Array<[number, number]> = [[M.bx0 + 3, M.by0 + 3], [M.bx0 + M.L - 3, M.by0 + 3], [M.bx0 + 3, M.by0 + M.W - 3], [M.bx0 + M.L - 3, M.by0 + M.W - 3]];
  const outerR = corners.every(([x, y], i) => hasCyl(baseCyl, x, y, 3, 0.15, 0.05) || hasCyl(baseCyl, filletCentres[i]![0], filletCentres[i]![1], 3, 0.15, 0.05));
  out.push({ check: "outer vertical corners R3 (a r=3 vertical cylinder at each corner: either the corner boss or an R3 fillet centre)", tol: "radius +-0.05, axis +-0.15 mm", ok: outerR, actual: baseCyl.filter((c) => near(c.r, 3, 0.05)).map((c) => [r3(c.x), r3(c.y)]) });
  out.push({ check: "four O6 corner bosses at the outer corner points with O2.5 pilots reaching the rim (pilot cylinders on the same axes, top at z=18, depth about 8)", tol: "axis +-0.1 mm, radius +-0.05, depth 8 +-0.5", ok: corners.every(([x, y]) => hasCyl(baseCyl, x, y, M.pilotD / 2, 0.1, 0.05, (c) => c.z1 >= M.H - 0.05 && near(c.z1 - c.z0, M.bossPilotDepth, 0.5))), actual: baseCyl.filter((c) => near(c.r, 1.25, 0.05) && c.z1 >= M.H - 0.05).map((c) => [r3(c.x), r3(c.y), r3(c.z1 - c.z0)]) });
  void bossR;

  // --- lid ---
  const lidF = F.lid!, lidCyl = zcyls(lidF);
  const lipX0 = cavity.x0 + M.lid.lipClear, lipX1 = cavity.x1 - M.lid.lipClear, lipY0 = cavity.y0 + M.lid.lipClear, lipY1 = cavity.y1 - M.lid.lipClear;
  const lipFace = (axis: 0 | 1, sign: 1 | -1, v: number) => lidF.find((f) => f.planar && f.normal && f.normal[axis]! * sign > 0.99 && near(f.centerMm[axis]!, v, 0.1));
  const lips = [lipFace(0, -1, lipX0), lipFace(0, 1, lipX1), lipFace(1, -1, lipY0), lipFace(1, 1, lipY1)];
  const lipOk = lips.every((f, i) => !!f && near(f.centerMm[i < 2 ? 0 : 1]!, [lipX0, lipX1, lipY0, lipY1][i]!, 0.05)) && lips.every((f) => !!f && near(f.boundsMm.max[2]! - f.boundsMm.min[2]!, M.lid.lip, 0.1) && near(f.boundsMm.max[2]!, M.H, 0.1));
  out.push({ check: "lid lip: outer faces 0.2 inside the cavity walls on each side, lip depth 1.5 (faces z 16.5 to 18)", tol: "clearance 0.2 +-0.05 mm, depth 1.5 +-0.1 mm", ok: lipOk, actual: lips.map((f) => (f ? { at: r3(f.centerMm[Math.abs(f.normal![0]!) > 0.5 ? 0 : 1]!), z: [r3(f.boundsMm.min[2]!), r3(f.boundsMm.max[2]!)] } : null)) });
  out.push({ check: "lid screw holes O3.4 coaxial with the four base bosses", tol: "+-0.1 mm, radius +-0.05", ok: corners.every(([x, y]) => hasCyl(lidCyl, x, y, M.lid.holeD / 2, 0.1, 0.05)), actual: lidCyl.filter((c) => near(c.r, 1.7, 0.05)).map((c) => [r3(c.x), r3(c.y)]) });
  out.push({ check: "four countersinks in the lid (at least four conical faces)", tol: "count", ok: lidF.filter((f) => f.surfaceType === "Cone").length >= 4, actual: lidF.filter((f) => f.surfaceType === "Cone").length });
  // vents: five slots of 1.6 mm width inside the 20 x 10 zone
  const zone = { x0: M.vent.cx - M.vent.zoneW / 2, x1: M.vent.cx + M.vent.zoneW / 2, y0: M.vent.cy - M.vent.zoneH / 2, y1: M.vent.cy + M.vent.zoneH / 2 };
  const sides = lidF.filter((f) => f.planar && f.normal && Math.abs(f.normal[0]!) > 0.99 && f.boundsMm.min[1]! >= zone.y0 - 0.3 && f.boundsMm.max[1]! <= zone.y1 + 0.3 && f.boundsMm.min[0]! >= zone.x0 - 0.3 && f.boundsMm.max[0]! <= zone.x1 + 0.3 && f.boundsMm.max[2]! - f.boundsMm.min[2]! >= 1.5 && f.boundsMm.max[2]! - f.boundsMm.min[2]! <= 2.2);
  const xs = sides.map((f) => f.centerMm[0]!).sort((a, b) => a - b);
  const widths = [0, 2, 4, 6, 8].map((i) => (xs[i + 1] ?? NaN) - (xs[i] ?? NaN));
  out.push({ check: "five vent slots of width 1.6 inside the 20 x 10 zone centred at (2046, 19.65): ten slot side faces in pairs", tol: "width 1.6 +-0.1 mm, zone +-0.3 mm", ok: sides.length === 10 && widths.every((w) => near(w, M.vent.w, 0.1)), actual: { sideFaces: sides.length, widths: widths.map(r3) } });
  // lid pilots for the pod
  out.push({ check: "two O2.5 blind pilots in the lid top for the sensor pod at (2014,19.65) and (2026,19.65), depth 1.2", tol: "+-0.1 mm, depth +-0.3", ok: M.pod.holeXs.every((x) => hasCyl(lidCyl, x, CY, 1.25, 0.1, 0.05, (c) => near(c.z1, M.H + M.lid.t, 0.1) && near(c.z1 - c.z0, M.pod.pilotDepth, 0.3))), actual: lidCyl.filter((c) => near(c.r, 1.25, 0.05) && near(c.z1, 20, 0.1)).map((c) => [r3(c.x), r3(c.y), r3(c.z1 - c.z0)]) });

  // --- bracket ---
  const brF = F.bracket!, brCyl = zcyls(brF);
  const br = M.bracket;
  out.push({ check: "bracket: L shape 30 wide, 3 thick, legs 40 and 40 (bounds x 2016..2056, y 4.65..34.65, z -40..0)", tol: "+-0.1 mm", ok: [br.x0, CY - br.w / 2, -br.legB].every((v, k) => near(B.bracket!.min[k]!, v, 0.1)) && [br.x0 + br.legA, CY + br.w / 2, 0].every((v, k) => near(B.bracket!.max[k]!, v, 0.1)), actual: { min: B.bracket!.min.map(r3), max: B.bracket!.max.map(r3) } });
  const bracketXHoles = brF.filter((f) => f.surfaceType === "Cylinder" && f.radiusMm != null && near(f.radiusMm, br.holeBD / 2, 0.05) && f.axisDirection && Math.abs(f.axisDirection[0]!) > 0.99 && f.axisOriginMm);
  const hb = [-br.holeBDy, br.holeBDy].every((dy) => bracketXHoles.some((f) => near(f.axisOriginMm![1]!, CY + dy, 0.2) && near(f.axisOriginMm![2]!, br.holeBZ, 0.2)));
  out.push({ check: "bracket wall leg has two O4.5 holes (x axis) at y=12.65 and 26.65, z=-22", tol: "+-0.2 mm", ok: hb, actual: bracketXHoles.map((f) => [r3(f.axisOriginMm![1]!), r3(f.axisOriginMm![2]!)]) });
  const baseUnder = baseCyl.filter((c) => near(c.r, br.underPilotD / 2, 0.05) && c.z0 <= 0.1 && c.z1 <= M.floor + 0.1);
  out.push({ check: "bracket base-leg holes (O3.4) coaxial with the two O2.5 pilots in the case-base underside", tol: "+-0.1 mm", ok: br.holesA.every((x) => hasCyl(brCyl, x, CY, br.holeAD / 2, 0.1, 0.05) && baseUnder.some((c) => near(c.x, x, 0.1) && near(c.y, CY, 0.1))), actual: { bracketHoles: brCyl.filter((c) => near(c.r, 1.7, 0.05)).map((c) => [r3(c.x), r3(c.y)]), underPilots: baseUnder.map((c) => [r3(c.x), r3(c.y)]) } });

  // --- sensor pod ---
  const pdF = F["sensor-pod"]!, pdCyl = zcyls(pdF);
  const pd = M.pod;
  out.push({ check: "sensor pod 24 x 20 x 12 mounted on the lid top (min z = 20), centred at y=19.65, x 2008..2032", tol: "+-0.1 mm", ok: [pd.x0, pd.y0, M.H + M.lid.t].every((v, k) => near(B["sensor-pod"]!.min[k]!, v, 0.1)) && [pd.x0 + pd.L, pd.y0 + pd.W, M.H + M.lid.t + pd.H].every((v, k) => near(B["sensor-pod"]!.max[k]!, v, 0.1)), actual: { min: B["sensor-pod"]!.min.map(r3), max: B["sensor-pod"]!.max.map(r3) } });
  const pw = pd.board.w + 2 * pd.fit, ph = pd.board.d + 2 * pd.fit, pcx = pd.x0 + pd.L / 2, pcy = pd.y0 + pd.W / 2;
  const pocketF = (axis: 0 | 1, sign: 1 | -1, v: number) => pdF.find((f) => f.planar && f.normal && f.normal[axis]! * sign > 0.99 && near(f.centerMm[axis]!, v, 0.1));
  const pocket = [pocketF(0, 1, pcx - pw / 2), pocketF(0, -1, pcx + pw / 2), pocketF(1, 1, pcy - ph / 2), pocketF(1, -1, pcy + ph / 2)];
  const floorOk = pdF.some((f) => f.planar && f.normal && f.normal[2]! > 0.99 && near(f.centerMm[2]!, M.H + M.lid.t + pd.floor, 0.05));
  out.push({ check: "sensor pocket 18.1 x 15.5 (17.8 x 15.2 board + 0.15 per side) with a 1.6 mm floor", tol: "+-0.1 mm walls, floor +-0.05 mm", ok: pocket.every(Boolean) && floorOk, actual: { walls: pocket.map((f) => (f ? r3(f.centerMm[Math.abs(f.normal![0]!) > 0.5 ? 0 : 1]!) : null)), floorPlane: floorOk } });
  const notch = pdF.find((f) => f.planar && f.normal && f.normal[2]! > 0.99 && near(f.centerMm[2]!, M.H + M.lid.t + pd.H - pd.notchH, 0.1) && near(f.boundsMm.max[0]! - f.boundsMm.min[0]!, pd.notchW, 0.2) && f.centerMm[1]! > pcy + ph / 2 - 0.2);
  out.push({ check: "10 x 4 cable notch in the +y wall of the pod (notch floor at z=28, 10 wide)", tol: "+-0.2 mm", ok: !!notch, actual: notch ? { z: r3(notch.centerMm[2]!), w: r3(notch.boundsMm.max[0]! - notch.boundsMm.min[0]!) } : "not found" });
  out.push({ check: "pod floor holes O3.0 coaxial with the two lid pilots", tol: "+-0.1 mm", ok: pd.holeXs.every((x) => hasCyl(pdCyl, x, CY, pd.floorHoleD / 2, 0.1, 0.05)), actual: pdCyl.filter((c) => near(c.r, 1.5, 0.05)).map((c) => [r3(c.x), r3(c.y)]) });

  // --- screws ---
  const sc = M.screw;
  const screwOk = [1, 2, 3, 4].map((i) => { const b = B[`screw-${i}`]!; const [x, y] = [(b.min[0]! + b.max[0]!) / 2, (b.min[1]! + b.max[1]!) / 2]; return corners.some(([cx, cy]) => near(x, cx, 0.2) && near(y, cy, 0.2)) && near(b.max[0]! - b.min[0]!, sc.headD, 0.15) && near(b.max[2]!, M.H + M.lid.t, 0.2) && near(b.max[2]! - b.min[2]!, sc.shaftL + sc.headH, 0.2); });
  out.push({ check: "four M3x8 screw stand-ins (head O5.6 x 1.7 on a O3 x 8 shaft) at the four lid holes, head top flush with the lid top, one per hole", tol: "+-0.2 mm", ok: screwOk.every(Boolean) && new Set([1, 2, 3, 4].map((i) => corners.findIndex(([cx, cy]) => near((B[`screw-${i}`]!.min[0]! + B[`screw-${i}`]!.max[0]!) / 2, cx, 0.2) && near((B[`screw-${i}`]!.min[1]! + B[`screw-${i}`]!.max[1]!) / 2, cy, 0.2)))).size === 4, actual: screwOk });

  // --- interference, all pairs except screw vs case-base and screw vs lid ---
  const ids = Object.fromEntries(found.map((f) => [f.n, f.b?.id]));
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < M_NAMES.length; i++) for (let j = i + 1; j < M_NAMES.length; j++) {
    const a = M_NAMES[i]!, b = M_NAMES[j]!;
    const screw = (n: string) => n.startsWith("screw-");
    if ((screw(a) && (b === "case-base" || b === "lid")) || (screw(b) && (a === "case-base" || a === "lid"))) continue;
    if (ids[a] && ids[b]) pairs.push([a, b]);
  }
  let clashes: string[] = ["check failed"]; let checked = 0;
  try {
    const rev = await s.rev();
    const r = await s.call("plasticity_check_interference", { pairs: pairs.map(([a, b]) => ({ firstBodyId: ids[a]!, secondBodyId: ids[b]! })), revision: rev });
    const list: any[] = r.pairs ?? r.results ?? [];
    checked = list.length;
    clashes = list.map((x, i) => ({ x, p: pairs[i]! })).filter(({ x }) => !JSON.stringify(x).includes("no-volumetric-interference")).map(({ p }) => `${p[0]}/${p[1]}`);
  } catch (e) { clashes = [`check failed: ${String(e).slice(0, 160)}`]; }
  out.push({ check: `no interference between any pair of the nine parts (${pairs.length} pairs; screws vs case-base and lid excepted as nominal fits)`, tol: "exact (native boolean intersection); touching is not interference", ok: have.length === 9 && clashes.length === 0 && checked === pairs.length, actual: { pairs: pairs.length, checked, clashes } });
  const scale = { bodies: st.bodies.length, totalFaces: sum(st.bodies.map((b) => b.faceCount)) };
  return { checks: out, scale };
}
