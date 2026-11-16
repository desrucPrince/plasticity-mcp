// Suite M: ESP32 dev-board enclosure system. Layout constants (shared by the reference build and the verifier) and the deterministic
// reference assembly. All numbers are derived from the prompt in prompts.json; the verifier never reads the model's own numbers.
import { Steps, added, type Step } from "./reference.ts";

const r3 = (v: number) => Math.round(v * 1000) / 1000;

export const M = {
  // case base outer rectangle (x,y) and height; walls and floor 2; cavity = PCB + 0.5 per side
  bx0: 2003, by0: 3, L: 56.5, W: 33.3, H: 18, wall: 2, floor: 2, clearance: 0.5,
  // PCB 51.5 x 28.3 x 1.6 sitting on 4 mm standoffs: its min corner and z
  pcb: { w: 51.5, d: 28.3, t: 1.6, x0: 2005.5, y0: 5.5, z0: 6, holeD: 3.0, holeIn: 2.6 },
  standoffD: 5, standoffH: 4, pilotD: 2.5, standoffPilotDepth: 3,
  bossD: 6, bossPilotDepth: 8, // corner bosses centred on the outer corner points
  usb: { w: 9.2, h: 3.4, r: 1.2, cy: 19.65, z0: 9.2 }, // opening in the x-min wall, centred on the PCB short edge
  lid: { t: 2, lip: 1.5, lipClear: 0.2, lipWall: 1.2, holeD: 3.4, csD: 6.5, csAngle: 90 },
  vent: { n: 5, w: 1.6, len: 10, zoneW: 20, zoneH: 10, cx: 2046, cy: 19.65 },
  bracket: { w: 30, t: 3, legA: 40, legB: 40, x0: 2016, holesA: [2026, 2046], holeAD: 3.4, holeBD: 4.5, holeBZ: -22, holeBDy: 7, underPilotD: 2.5, underPilotDepth: 1.2 },
  pod: { x0: 2008, y0: 9.65, L: 24, W: 20, H: 12, floor: 1.6, board: { w: 17.8, d: 15.2 }, fit: 0.15, notchW: 10, notchH: 4, floorHoleD: 3.0, pilotD: 2.5, pilotDepth: 1.2, holeXs: [2014, 2026] },
  screw: { shaftD: 3, shaftL: 8, headD: 5.6, headH: 1.7 },
};
export const C = M.bx0 + M.L / 2; // 2031.25
export const CY = M.by0 + M.W / 2; // 19.65
export const corners: Array<[number, number]> = [[M.bx0, M.by0], [M.bx0 + M.L, M.by0], [M.bx0, M.by0 + M.W], [M.bx0 + M.L, M.by0 + M.W]];
export const pcbHoles: Array<[number, number]> = [[M.pcb.holeIn, M.pcb.holeIn], [M.pcb.w - M.pcb.holeIn, M.pcb.holeIn], [M.pcb.holeIn, M.pcb.d - M.pcb.holeIn], [M.pcb.w - M.pcb.holeIn, M.pcb.d - M.pcb.holeIn]].map(([x, y]) => [r3(M.pcb.x0 + x!), r3(M.pcb.y0 + y!)]) as Array<[number, number]>;
export const cavity = { x0: M.bx0 + M.wall, x1: M.bx0 + M.L - M.wall, y0: M.by0 + M.wall, y1: M.by0 + M.W - M.wall, z0: M.floor };
export const ventXs = Array.from({ length: M.vent.n }, (_, i) => r3(M.vent.cx - M.vent.zoneW / 2 + M.vent.w / 2 + i * ((M.vent.zoneW - M.vent.w) / (M.vent.n - 1))));

export type MPart = { name: string; steps: Step[] };
function helpers(s: Steps) {
  const step = (toolName: string, args: Record<string, unknown>) => s.add(toolName, args);
  const cyl = (x: number, y: number, z: number, r: number, h: number, name?: string) => step("plasticity_create_cylinder", { centerMm: [r3(x), r3(y), r3(z)], radiusMm: r, heightMm: h, axis: [0, 0, 1], ...(name ? { name } : {}) });
  const box = (x: number, y: number, z: number, a: number, b: number, c: number, name?: string) => step("plasticity_create_box", { originMm: [r3(x), r3(y), r3(z)], sizeMm: [r3(a), r3(b), r3(c)], ...(name ? { name } : {}) });
  const bool = (target: number, tools: number[], op: "union" | "difference") => step("plasticity_boolean", { targetIds: [added(target)], toolIds: tools.map((t) => added(t)), operation: op });
  return { step, cyl, box, bool };
}

// One batch per part (plasticity_batch accepts at most 50 steps); step references are local to a batch.
export function mReference(): { parts: MPart[] } {
  const parts: MPart[] = [];
  const part = (name: string, fn: (h: ReturnType<typeof helpers>) => void) => { const s = new Steps(); fn(helpers(s)); parts.push({ name, steps: s.list }); };

  part("pcb", ({ cyl, box, bool }) => {
    const pcb = box(M.pcb.x0, M.pcb.y0, M.pcb.z0, M.pcb.w, M.pcb.d, M.pcb.t, "pcb");
    bool(pcb, pcbHoles.map(([x, y]) => cyl(x, y, M.pcb.z0 - 0.5, M.pcb.holeD / 2, M.pcb.t + 1)), "difference");
  });
  part("case-base", ({ step, cyl, box, bool }) => {
    const base = box(M.bx0, M.by0, 0, M.L, M.W, M.H, "case-base");
    bool(base, [box(cavity.x0, cavity.y0, cavity.z0, M.L - 2 * M.wall, M.W - 2 * M.wall, M.H)], "difference");
    bool(base, corners.map(([x, y]) => cyl(x, y, 0, M.bossD / 2, M.H)), "union");
    bool(base, corners.map(([x, y]) => cyl(x, y, M.H - M.bossPilotDepth, M.pilotD / 2, M.bossPilotDepth + 0.5)), "difference");
    bool(base, pcbHoles.map(([x, y]) => cyl(x, y, M.floor - 0.5, M.standoffD / 2, M.pcb.z0 - M.floor + 0.5)), "union");
    bool(base, pcbHoles.map(([x, y]) => cyl(x, y, M.pcb.z0 - M.standoffPilotDepth, M.pilotD / 2, M.standoffPilotDepth + 0.5)), "difference");
    const usb = box(M.bx0 - 0.5, M.usb.cy - M.usb.w / 2, M.usb.z0, M.wall + 1.5, M.usb.w, M.usb.h);
    const usbEdges = step("plasticity_find_edges", { query: { bodyIds: [added(usb)], line: true, direction: { vector: [1, 0, 0] } }, limit: 20 });
    step("plasticity_fillet", { id: added(usb), edgeIds: `$${usbEdges}.result.matches[*].id`, radiusMm: M.usb.r });
    bool(base, [usb], "difference");
    bool(base, M.bracket.holesA.map((x) => cyl(x, CY, -0.5, M.bracket.underPilotD / 2, M.bracket.underPilotDepth + 0.5)), "difference");
  });
  part("lid", ({ step, cyl, box, bool }) => {
    const lid = box(M.bx0, M.by0, M.H, M.L, M.W, M.lid.t, "lid");
    bool(lid, corners.map(([x, y]) => cyl(x, y, M.H, M.bossD / 2, M.lid.t)), "union");
    const lipX = cavity.x0 + M.lid.lipClear, lipY = cavity.y0 + M.lid.lipClear;
    const lipW = cavity.x1 - cavity.x0 - 2 * M.lid.lipClear, lipD = cavity.y1 - cavity.y0 - 2 * M.lid.lipClear;
    const ring = box(lipX, lipY, M.H - M.lid.lip, lipW, lipD, M.lid.lip);
    bool(ring, [box(lipX + M.lid.lipWall, lipY + M.lid.lipWall, M.H - M.lid.lip - 0.5, lipW - 2 * M.lid.lipWall, lipD - 2 * M.lid.lipWall, M.lid.lip + 1)], "difference");
    bool(lid, [ring], "union");
    step("plasticity_create_countersink_pattern", { targetId: added(lid), entryCentersMm: corners.map(([x, y]) => [x, y, M.H + M.lid.t]), axis: [0, 0, -1], radialDirection: [1, 0, 0], throughDiameterMm: M.lid.holeD, countersinkMajorDiameterMm: M.lid.csD, includedAngleDeg: M.lid.csAngle, throughDepthMm: M.lid.t });
    bool(lid, ventXs.map((x) => box(x - M.vent.w / 2, M.vent.cy - M.vent.len / 2, M.H - 0.1, M.vent.w, M.vent.len, M.lid.t + 0.2)), "difference");
    bool(lid, M.pod.holeXs.map((x) => cyl(x, CY, M.H + M.lid.t - M.pod.pilotDepth, M.pod.pilotD / 2, M.pod.pilotDepth + 0.5)), "difference");
  });
  part("bracket", ({ step, cyl, box, bool }) => {
    const br = M.bracket;
    const bracket = box(br.x0, CY - br.w / 2, -br.t, br.legA, br.w, br.t, "bracket");
    bool(bracket, [box(br.x0 + br.legA - br.t, CY - br.w / 2, -br.legB, br.t, br.w, br.legB)], "union");
    bool(bracket, br.holesA.map((x) => cyl(x, CY, -br.t - 0.5, br.holeAD / 2, br.t + 1)), "difference");
    bool(bracket, [-br.holeBDy, br.holeBDy].map((dy) => step("plasticity_create_cylinder", { centerMm: [r3(br.x0 + br.legA - br.t - 0.5), r3(CY + dy), br.holeBZ], radiusMm: br.holeBD / 2, heightMm: br.t + 1, axis: [1, 0, 0] })), "difference");
  });
  part("sensor-pod", ({ cyl, box, bool }) => {
    const pd = M.pod;
    const pod = box(pd.x0, pd.y0, M.H + M.lid.t, pd.L, pd.W, pd.H, "sensor-pod");
    const pw = pd.board.w + 2 * pd.fit, ph = pd.board.d + 2 * pd.fit;
    const pcx = pd.x0 + pd.L / 2, pcy = pd.y0 + pd.W / 2;
    bool(pod, [box(pcx - pw / 2, pcy - ph / 2, M.H + M.lid.t + pd.floor, pw, ph, pd.H)], "difference");
    bool(pod, pd.holeXs.map((x) => cyl(x, CY, M.H + M.lid.t - 0.5, pd.floorHoleD / 2, pd.floor + 1)), "difference");
    bool(pod, [box(pcx - pd.notchW / 2, pcy + ph / 2 - 0.5, M.H + M.lid.t + pd.H - pd.notchH, pd.notchW, (pd.W - ph) / 2 + 1, pd.notchH + 0.5)], "difference");
  });
  part("screws", ({ cyl, bool }) => {
    const sc = M.screw;
    corners.forEach(([x, y], i) => {
      const shaft = cyl(x, y, M.H + M.lid.t - sc.headH - sc.shaftL, sc.shaftD / 2, sc.shaftL + 0.1, `screw-${i + 1}`);
      bool(shaft, [cyl(x, y, M.H + M.lid.t - sc.headH, sc.headD / 2, sc.headH)], "union");
    });
  });
  return { parts };
}
