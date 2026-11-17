#!/usr/bin/env node
// Live acceptance for plasticity_create_bracket, plasticity_place_body and plasticity_transfer_holes.
//
// Every check reads the built geometry independently: plasticity_find_faces / plasticity_find_edges (limit 1000),
// plasticity_validate_bodies, plasticity_check_interference, plasticity_measure_parallel_planar_face_clearance and the
// status bounds. plasticity_describe_body is never used. Each case restores the document by Undo to the baseline Undo
// depth and body list, and the script checks that it did. It never saves, opens or closes a document.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { isolatedAcceptanceEnvironment } from "./native-live-environment.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
type Vec = [number, number, number];
type Check = { case: string; check: string; ok: boolean; detail?: unknown };
// 1-4: the original acceptance. d1-d11: one case per defect of the review (d45 covers defects 4 and 5).
// r2b1, r2b2, r2t: round 2 (recessed entries, countersink and counterbore breakout, ray time).
// t1, t2: the final review (the clearance ring and the blind floor; the wall beside the bore at any angle).
const CASES = ["1", "2", "3", "4", "d1", "d2", "d3", "d45", "d6", "d7", "d8", "d9", "d10", "d11", "r2b1", "r2b2", "r2t", "t1", "t2"] as const;
const HAND_BATCH_BYTES = 2_308; // the audit's hand-written L-bracket batch (discovery/speed-2026-11, part b)
const X0 = 2000; // every case builds at x >= 2000 mm, away from the document's own bodies

interface Options { help: boolean; target?: string; output?: string; allowDisposableMutations: boolean; cases: string[] }

export function parseBracketMateArgs(argv: string[]): Options {
  const options: Options = { help: argv.length === 0, allowDisposableMutations: false, cases: [...CASES] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--target" || argument === "--output" || argument === "--case") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--target") options.target = value;
      else if (argument === "--output") options.output = value;
      else {
        const picked = value.split(",");
        if (picked.some((item) => !(CASES as readonly string[]).includes(item))) throw new Error(`--case takes ${CASES.join(", ")} (comma-separated)`);
        options.cases = picked;
      }
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live bracket-mate acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live bracket-mate acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live bracket-mate acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  PLASTICITY_CDP_URL=http://127.0.0.1:PORT node scripts/verify-native-bracket-mate-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY [--case 1,2,3,4]

Cases: 1 audit L-bracket in one call; 2 U bracket with a slotted pair and Z bracket with a 2x2 grid; 3 block + bracket
mate chain (direct calls, then one lean batch); 4 live rejections; d1-d11 the review's failing inputs, one case per
defect (d45 is defects 4 and 5); r2b1, r2b2, r2t round 2 (entries, heads, 12-axis timing); t1 the final review's thin
walls: a membrane over a cross hole between the rays, a bore 0.002 mm beside a pocket wall and a void, Ø0.99 up a 1 mm
wall, and 16 rays per ring above Ø10; t2 the wall beside the bore at any angle: Ø4 beside a Ø6 hole with a 0.002, 0.01
and 0.04 mm wall at six angles, a counterbore wall 0.01 mm from that hole, a pocket turned 22.5 degrees, the 1 mm and
0.06 mm controls, and what the exact clearance check costs. Builds at x >= ${X0} mm in an isolated instance, restores the Undo depth and body list
after every case, and writes evidence.json to the new output directory.`;

// ---------- small geometry helpers ----------
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec): Vec => mul(a, 1 / norm(a));
const near = (a: Vec, b: Vec, tolerance = 1e-6) => norm(sub(a, b)) <= tolerance;
/** Distance between two lines when parallel (sine <= 1e-9), else Infinity. */
function coaxial(pointA: Vec, dirA: Vec, pointB: Vec, dirB: Vec): number {
  if (norm(cross(unit(dirA), unit(dirB))) > 1e-9) return Number.POSITIVE_INFINITY;
  return norm(cross(sub(pointB, pointA), unit(dirA)));
}
const boundsNear = (a: { min: Vec; max: Vec }, b: { min: Vec; max: Vec }, tolerance = 1e-6) => near(a.min, b.min, tolerance) && near(a.max, b.max, tolerance);

// ---------- MCP plumbing ----------
async function startMcp(storeRoot: string): Promise<Client> {
  // The server's own state (window ownership) stays in the output directory, or where PLASTICITY_MCP_STATE_DIR says.
  const env = { ...isolatedAcceptanceEnvironment(storeRoot, process.env), PLASTICITY_AUTO_LAUNCH: "0", PLASTICITY_HUD: "0", PLASTICITY_TIMING: "1", PLASTICITY_MCP_STATE_DIR: process.env.PLASTICITY_MCP_STATE_DIR ?? join(storeRoot, "state") };
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env, stderr: "pipe" });
  const client = new Client({ name: "plasticity-bracket-mate-live", version: "1.0.0" });
  await client.connect(transport);
  return client;
}
function toolText(response: unknown): string {
  const content = (response as { content?: Array<{ type: string; text?: string }> }).content;
  const item = content?.find((entry) => entry.type === "text" && typeof entry.text === "string");
  if (!item) throw new Error("MCP tool returned no text result");
  return item.text!;
}

class Live {
  readonly client: Client;
  readonly checks: Check[] = [];
  readonly evidence: Record<string, unknown> = {};
  baseline!: { undoDepth: number; bodyIds: number[]; revision: string };
  constructor(client: Client) { this.client = client; }
  async call(name: string, args: Record<string, unknown>): Promise<any> {
    const response = await this.client.callTool({ name, arguments: args });
    const text = toolText(response);
    if ((response as { isError?: boolean }).isError) throw new Error(text);
    return JSON.parse(text);
  }
  /** A call that must fail: returns its error text. */
  async refused(name: string, args: Record<string, unknown>): Promise<string> {
    const response = await this.client.callTool({ name, arguments: args });
    const text = toolText(response);
    if (!(response as { isError?: boolean }).isError) throw new Error(`${name} was expected to fail but returned ${text.slice(0, 400)}`);
    return text;
  }
  async status(): Promise<any> { return await this.call("plasticity_status", {}); }
  async bodyBounds(id: number): Promise<{ min: Vec; max: Vec } | undefined> {
    const status = await this.status();
    return status.bodies.find((body: { id: number }) => body.id === id)?.boundsMm;
  }
  async faces(query: Record<string, unknown>): Promise<any[]> {
    const status = await this.status();
    return (await this.call("plasticity_find_faces", { revision: status.revision, query, limit: 1000 })).matches;
  }
  async edges(query: Record<string, unknown>): Promise<any[]> {
    const status = await this.status();
    return (await this.call("plasticity_find_edges", { revision: status.revision, query, limit: 1000 })).matches;
  }
  check(caseName: string, check: string, ok: boolean, detail?: unknown): boolean {
    this.checks.push({ case: caseName, check, ok, ...(detail === undefined ? {} : { detail }) });
    return ok;
  }
  /** Runs one mutating call and checks that its undoSteps equals the measured Undo depth change. */
  async mutate(caseName: string, name: string, args: Record<string, unknown>): Promise<{ result: any; ms: number; bytes: number }> {
    const before = await this.status();
    const payload = { ...args, revision: before.revision };
    const started = performance.now();
    const result = await this.call(name, payload);
    const ms = Math.round(performance.now() - started);
    const after = await this.status();
    const measured = after.undoDepth - before.undoDepth;
    if (typeof result?.undoSteps === "number") this.check(caseName, `${name} undoSteps ${result.undoSteps} equals the measured Undo depth change`, result.undoSteps === measured, { reported: result.undoSteps, measured });
    return { result, ms, bytes: Buffer.byteLength(JSON.stringify(args)) };
  }
  /**
   * A call that must be refused with the document unchanged: the error matches the pattern, and the Undo depth and the
   * body list are the same before and after (a rollback changes the revision, so it is not compared).
   */
  async refusedUnchanged(caseName: string, label: string, name: string, args: Record<string, unknown>, pattern: RegExp): Promise<string> {
    const before = await this.status();
    const response = await this.client.callTool({ name, arguments: { ...args, revision: before.revision } });
    const message = toolText(response);
    const isError = (response as { isError?: boolean }).isError === true;
    const after = await this.status();
    const ids = (status: any) => JSON.stringify(status.bodies.map((body: { id: number }) => body.id).sort((a: number, b: number) => a - b));
    this.check(caseName, `${label}: refused (${message.slice(0, 200)}...); Undo depth ${before.undoDepth} -> ${after.undoDepth}, bodies ${before.bodies.length} -> ${after.bodies.length}`,
      isError && pattern.test(message) && after.undoDepth === before.undoDepth && ids(after) === ids(before), { message: message.slice(0, 1200), undoDepth: [before.undoDepth, after.undoDepth], bodies: [before.bodies.length, after.bodies.length] });
    return message;
  }
  /** Bodies added since a status read. */
  async added(before: any): Promise<number[]> {
    const known = new Set(before.bodies.map((body: { id: number }) => body.id));
    return (await this.status()).bodies.map((body: { id: number }) => body.id).filter((id: number) => !known.has(id));
  }
  async undoTo(depth: number): Promise<void> {
    for (let guard = 0; guard < 200; guard += 1) {
      const status = await this.status();
      if (status.undoDepth <= depth) return;
      await this.call("plasticity_undo", { revision: status.revision });
    }
  }
  async restore(caseName: string): Promise<void> {
    for (let guard = 0; guard < 200; guard += 1) {
      const status = await this.status();
      if (status.undoDepth <= this.baseline.undoDepth) break;
      await this.call("plasticity_undo", { revision: status.revision });
    }
    const status = await this.status();
    const ids = status.bodies.map((body: { id: number }) => body.id).sort((a: number, b: number) => a - b);
    this.check(caseName, "document restored: Undo depth and body list equal the baseline", status.undoDepth === this.baseline.undoDepth && JSON.stringify(ids) === JSON.stringify(this.baseline.bodyIds), { undoDepth: status.undoDepth, bodies: ids.length });
  }
}

// ---------- shared verification of a bracket's derived values against the built body ----------
async function verifyBracket(live: Live, caseName: string, label: string, reply: any, input: { widthMm: number; thicknessMm: number }): Promise<void> {
  const id = reply.bodyId as number;
  const derived = reply.derived;
  const W = input.widthMm;
  const t = input.thicknessMm;
  const validation = await live.call("plasticity_validate_bodies", { ids: [id], revision: (await live.status()).revision });
  const body = validation.bodies[0];
  live.check(caseName, `${label}: valid closed Solid (native Check)`, body.type === "Solid" && body.closed && body.nativeValid && body.printableSolid, { faceCount: body.faceCount, nativeCheckCodes: body.nativeCheckCodes });
  const bounds = await live.bodyBounds(id);
  live.check(caseName, `${label}: derived.boundsMm equals the body bounds (1e-6)`, !!bounds && boundsNear(bounds, derived.boundsMm), { derived: derived.boundsMm, read: bounds });

  const planar = await live.faces({ bodyIds: [id], planar: true });
  const lines = await live.edges({ bodyIds: [id], line: true });
  const endpoints = (edge: any): Vec[] => { const half = mul(edge.tangent, edge.lengthMm / 2); return [sub(edge.centerMm, half), add(edge.centerMm, half)]; };
  const parallel = (a: Vec, b: Vec) => norm(cross(unit(a), unit(b))) <= 1e-9;
  for (const [legName, leg] of Object.entries<any>(derived.legs)) {
    const k = leg.planeNormal.findIndex((value: number) => value !== 0);
    const outer = planar.filter((face) => near(face.normal, leg.planeNormal, 1e-9) && Math.abs(face.centerMm[k] - leg.outerFaceOffsetMm) <= 1e-6);
    live.check(caseName, `${label} ${legName}: planeNormal + outerFaceOffsetMm name a planar face of the body`, outer.length >= 1, { planeNormal: leg.planeNormal, outerFaceOffsetMm: leg.outerFaceOffsetMm, faces: outer.map((face) => face.id) });
    const atOrigin = lines.filter((edge) => endpoints(edge).some((point) => near(point, leg.frameOriginMm)));
    live.check(caseName, `${label} ${legName}: frameOriginMm is a body vertex (line edges end there)`, atOrigin.length >= 2, { frameOriginMm: leg.frameOriginMm, edges: atOrigin.length });
    // Signs too: the edge's far end lies at a positive distance along alongAxis, and exactly W along acrossAxis.
    const farEnd = (edge: any): Vec => endpoints(edge).find((point) => !near(point, leg.frameOriginMm))!;
    const alongEdge = atOrigin.find((edge) => { const step = sub(farEnd(edge), leg.frameOriginMm); return parallel(edge.tangent, leg.alongAxis) && dot(step, leg.alongAxis) > 1e-6 && norm(cross(step, leg.alongAxis)) <= 1e-6; });
    live.check(caseName, `${label} ${legName}: alongAxis runs from the frame origin along a line edge, in its sign`, !!alongEdge, { alongAxis: leg.alongAxis, edgeLengthMm: alongEdge?.lengthMm });
    live.check(caseName, `${label} ${legName}: acrossAxis runs from the frame origin to frameOriginMm + ${W} x acrossAxis along a line edge`, atOrigin.some((edge) => near(farEnd(edge), add(leg.frameOriginMm, mul(leg.acrossAxis, W)))), { acrossAxis: leg.acrossAxis });
    // A flat-span end or lengthMm sits on a line edge across the leg (a bend tangent or the free end) on either face.
    const acrossEdgeAt = (along: number) => lines.some((edge) => parallel(edge.tangent, leg.acrossAxis) && [0, t].some((depth) =>
      Math.abs(dot(sub(edge.centerMm, add(add(leg.frameOriginMm, mul(leg.alongAxis, along)), mul(leg.planeNormal, -depth))), leg.alongAxis)) <= 1e-6
      && Math.abs(dot(sub(edge.centerMm, add(add(leg.frameOriginMm, mul(leg.alongAxis, along)), mul(leg.planeNormal, -depth))), leg.planeNormal)) <= 1e-6));
    for (const [index, along] of leg.flatSpanMm.entries()) live.check(caseName, `${label} ${legName}: flatSpanMm[${index}] = ${along} sits on a line edge across the leg`, acrossEdgeAt(along));
    const axisIndex = leg.alongAxis.findIndex((value: number) => value !== 0);
    const spansBounds = bounds && Math.abs((bounds.max[axisIndex]! - bounds.min[axisIndex]!) - leg.lengthMm) <= 1e-6;
    live.check(caseName, `${label} ${legName}: lengthMm = ${leg.lengthMm} (an across edge at its end, or the bounds extent along the leg)`, acrossEdgeAt(leg.lengthMm) || !!spansBounds);
  }
  const cylinders = await live.faces({ bodyIds: [id], surfaceTypes: ["Cylinder"] });
  const cylinderOn = (radius: number, point: Vec, axis: Vec) => cylinders.filter((face) => face.radiusMm !== null && Math.abs(face.radiusMm - radius) <= 1e-6 && face.axisOriginMm && coaxial(point, axis, face.axisOriginMm, face.axisDirection) <= 1e-6);
  for (const [index, hole] of derived.holeAxesMm.entries()) {
    if (hole.slot) {
      const half = (hole.slot.lengthMm - hole.diameterMm) / 2;
      const ends = [-1, 1].map((sign) => cylinderOn(hole.diameterMm / 2, add(hole.pointMm, mul(hole.slot.directionAxis, sign * half)), hole.axis).length);
      live.check(caseName, `${label}: holeAxesMm[${index}] slot ends (r ${hole.diameterMm / 2}) on their axes (1e-6)`, ends.every((count) => count >= 1), { pointMm: hole.pointMm, ends });
    } else {
      const found = cylinderOn(hole.diameterMm / 2, hole.pointMm, hole.axis);
      live.check(caseName, `${label}: holeAxesMm[${index}] Ø${hole.diameterMm} hole coaxial (1e-6)`, found.length >= 1, { pointMm: hole.pointMm, offsetMm: found.map((face) => coaxial(hole.pointMm, hole.axis, face.axisOriginMm, face.axisDirection)) });
      if (hole.countersunk) {
        const cones = await live.faces({ bodyIds: [id], surfaceTypes: ["Cone"] });
        live.check(caseName, `${label}: holeAxesMm[${index}] countersink cone on the axis, opening on the inner face`, cones.some((face) => face.axisOriginMm && coaxial(hole.pointMm, hole.axis, face.axisOriginMm, face.axisDirection) <= 1e-6 && dot(sub(face.centerMm, hole.pointMm), hole.axis) > t / 2));
      }
    }
  }
  for (const [index, bend] of (derived.bendAxesMm ?? []).entries()) {
    const found = cylinderOn(bend.radiusMm, bend.pointMm, bend.axis);
    live.check(caseName, `${label}: bendAxesMm[${index}] inner bend radius ${bend.radiusMm} on its axis (1e-6)`, found.length >= 1 && found.every((face) => Math.abs((face.blendRadiusMm ?? face.radiusMm) - bend.radiusMm) <= 1e-6), { faces: found.length });
  }
  for (const [index, corner] of (derived.cornerAxesMm ?? []).entries()) {
    const found = cylinderOn(corner.radiusMm, corner.pointMm, corner.axis);
    live.check(caseName, `${label}: cornerAxesMm[${index}] corner radius ${corner.radiusMm} on its axis (1e-6)`, found.length === 1, { pointMm: corner.pointMm });
  }
  for (const [index, gusset] of (derived.gussetBoundsMm ?? []).entries()) {
    const sides = [gusset.min[1], gusset.max[1]].map((y: number) => planar.filter((face) => parallel(face.normal, [0, 1, 0]) && Math.abs(face.centerMm[1] - y) <= 1e-6).length);
    const hypotenuse = (gusset.max[0] + gusset.min[2]); // x + z = (x0 + t + size) + (z0 + t) on the slanted face
    const slanted = planar.filter((face) => near(face.normal, unit([1, 0, 1]), 1e-9) && Math.abs(face.centerMm[0] + face.centerMm[2] - hypotenuse) <= 1e-6);
    const centred = Math.abs((gusset.min[1] + gusset.max[1]) / 2 - (derived.boundsMm.min[1] + derived.boundsMm.max[1]) / 2) <= 1e-9;
    live.check(caseName, `${label}: gussetBoundsMm[${index}] side faces at y ${gusset.min[1]} and ${gusset.max[1]}, slanted face x + z = ${hypotenuse}${centred ? ", centred on the width" : ""}`, sides.every((count) => count >= 1) && slanted.length === 1, { sides, slanted: slanted.length, centred });
  }
}

// ---------- cases ----------
const AUDIT_ARGS = {
  originMm: [X0, 0, 0], profile: "L", widthMm: 30, thicknessMm: 4, legs: { baseMm: 40, uprightMm: 40 }, innerBendRadiusMm: 5, cornerRadiusMm: 3,
  holes: [{ leg: "base", diameterMm: 4.5, count: 2, layout: "explicit", positionsMm: [[26, 7.5], [26, 22.5]] }, { leg: "upright", diameterMm: 4.5, count: 2, layout: "explicit", positionsMm: [[26, 7.5], [26, 22.5]] }],
  gussets: { count: 1, thicknessMm: 4, sizeMm: 25 }, name: "audit-l-bracket",
};

async function case1(live: Live): Promise<void> {
  const { result, ms, bytes } = await live.mutate("1", "plasticity_create_bracket", AUDIT_ARGS);
  live.evidence.case1 = { requestBytes: bytes, handBatchBytes: HAND_BATCH_BYTES, clientMs: ms, serverMs: result.timing?.totalMs, timing: result.timing, undoSteps: result.undoSteps, bodyId: result.bodyId, derived: result.derived, faceIds: result.faceIds, steps: result.steps.map((step: { operation: string }) => step.operation) };
  live.check("1", `one create_bracket call: ${bytes} B request vs ${HAND_BATCH_BYTES} B hand batch; ${result.timing?.totalMs} ms server, ${ms} ms round trip`, bytes < HAND_BATCH_BYTES, { bytes, serverMs: result.timing?.totalMs, clientMs: ms });
  await verifyBracket(live, "1", "audit L", result, AUDIT_ARGS);
}

async function case2(live: Live): Promise<void> {
  const uArgs = { originMm: [X0 + 100, 0, 0], profile: "U", widthMm: 30, thicknessMm: 3, legs: { baseMm: 50, leftMm: 30, rightMm: 25 }, innerBendRadiusMm: 2, cornerRadiusMm: 2,
    holes: [{ leg: "base", diameterMm: 4, count: 2, layout: "line-along", pitchMm: 20, slot: { lengthMm: 10, direction: "across" } }], name: "u-bracket" };
  const u = await live.mutate("2", "plasticity_create_bracket", uArgs);
  await verifyBracket(live, "2", "U slotted", u.result, uArgs);
  const zArgs = { originMm: [X0 + 200, 0, 0], profile: "Z", widthMm: 30, thicknessMm: 3, legs: { lowerMm: 30, webMm: 30, upperMm: 30 }, innerBendRadiusMm: 2, cornerRadiusMm: 2,
    holes: [{ leg: "web", diameterMm: 3.4, count: 4, layout: "grid", marginMm: 8 }], name: "z-bracket" };
  const z = await live.mutate("2", "plasticity_create_bracket", zArgs);
  await verifyBracket(live, "2", "Z grid", z.result, zArgs);
  live.evidence.case2 = { u: { bodyId: u.result.bodyId, undoSteps: u.result.undoSteps, holeAxesMm: u.result.derived.holeAxesMm, serverMs: u.result.timing?.totalMs }, z: { bodyId: z.result.bodyId, undoSteps: z.result.undoSteps, holeAxesMm: z.result.derived.holeAxesMm, serverMs: z.result.timing?.totalMs } };
}

const BX = X0 + 300; // the mate block
const PILOTS: Vec[] = [[BX + 22, 12, 0], [BX + 38, 12, 0], [BX + 22, 28, 0], [BX + 38, 28, 0]];
const CHAIN_BRACKET = { originMm: [BX + 100, 0, 0], profile: "L", widthMm: 30, thicknessMm: 4, legs: { baseMm: 40, uprightMm: 40 }, innerBendRadiusMm: 5, cornerRadiusMm: 3, name: "mate-bracket" };
const BLOCK_BOTTOM = { planar: true, normal: { vector: [0, 0, -1], toleranceDeg: 0.000001 }, center: { pointMm: [BX + 30, 20, 0], toleranceMm: 0.000001 } };

async function verifyChain(live: Live, label: string, blockId: number, bracketId: number): Promise<void> {
  const pilots = await live.faces({ bodyIds: [blockId], surfaceTypes: ["Cylinder"], radiusMm: { value: 1.5, tolerance: 1e-6 } });
  const holes = await live.faces({ bodyIds: [bracketId], surfaceTypes: ["Cylinder"], radiusMm: { value: 1.7, tolerance: 1e-6 } });
  const offsets = pilots.map((pilot) => Math.min(...holes.map((hole) => coaxial(pilot.axisOriginMm, pilot.axisDirection, hole.axisOriginMm, hole.axisDirection))));
  live.check("3", `${label}: each of the 4 Ø3 pilots has a coaxial Ø3.4 bracket hole (max offset ${Math.max(...offsets)} mm <= 1e-6)`, pilots.length === 4 && holes.length >= 4 && offsets.every((offset) => offset <= 1e-6), { pilots: pilots.length, holes: holes.length, offsets });
  const revision = (await live.status()).revision;
  const interference = await live.call("plasticity_check_interference", { pairs: [{ firstBodyId: blockId, secondBodyId: bracketId }], revision });
  live.check("3", `${label}: no volumetric interference between block and bracket`, interference.pairs[0].status === "no-volumetric-interference", interference.pairs[0]);
  const bottom = (await live.faces({ bodyIds: [blockId], ...BLOCK_BOTTOM }))[0];
  const top = (await live.faces({ bodyIds: [bracketId], planar: true, normal: { vector: [0, 0, 1], toleranceDeg: 0.000001 } })).filter((face: any) => Math.abs(face.centerMm[2]) <= 1e-6);
  const clearance = top.length === 1 && bottom ? await live.call("plasticity_measure_parallel_planar_face_clearance", { first: { bodyId: blockId, faceId: bottom.id }, second: { bodyId: bracketId, faceId: top[0].id }, revision }) : undefined;
  live.check("3", `${label}: block bottom and bracket top face touch (clearance ${clearance?.minimumDistanceMm} mm, 0 ± 1e-6)`, !!clearance && Math.abs(clearance.minimumDistanceMm) <= 1e-6 && Math.abs(clearance.parallelPlaneGapMm) <= 1e-6, clearance && { minimumDistanceMm: clearance.minimumDistanceMm, parallelPlaneGapMm: clearance.parallelPlaneGapMm, inPlaneClearanceMm: clearance.inPlaneClearanceMm });
  const validation = await live.call("plasticity_validate_bodies", { ids: [blockId, bracketId], revision });
  live.check("3", `${label}: block and bracket are valid closed Solids`, validation.bodies.every((body: any) => body.closed && body.nativeValid && body.printableSolid));
}

async function case3(live: Live): Promise<void> {
  // (a) direct calls
  const block = await live.mutate("3", "plasticity_create_box", { originMm: [BX, 0, 0], sizeMm: [60, 40, 20], name: "mate-block" });
  const blockId = block.result.change.added[0].id as number;
  await live.mutate("3", "plasticity_create_blind_hole_pattern", { targetId: blockId, entryCentersMm: PILOTS, axis: [0, 0, 1], holeDiameterMm: 3, holeDepthMm: 8, materialDepthMm: 20, overshootMm: 0.5 });
  const bracket = await live.mutate("3", "plasticity_create_bracket", CHAIN_BRACKET);
  const bracketId = bracket.result.bodyId as number;
  const bottom = (await live.faces({ bodyIds: [blockId], ...BLOCK_BOTTOM }))[0];
  // The bracket's base outer face, after a half turn about x, is the base leg's top face; the upright then hangs away from the block.
  const place = await live.mutate("3", "plasticity_place_body", { id: bracketId, anchor: { faceId: bracket.result.faceIds.base.outerFaceId }, to: { bodyId: blockId, faceId: bottom.id }, rotate: { axis: "x", quarterTurns: 2 }, gapMm: 0 });
  live.check("3", "place_body: mating faces, half turn about x, anchor on the block bottom centre", place.result.relation === "mating" && near(place.result.anchorMm, bottom.centerMm), { deltaMm: place.result.deltaMm, anchorMm: place.result.anchorMm, boundsMm: place.result.boundsMm, undoSteps: place.result.undoSteps });
  const transfer = await live.mutate("3", "plasticity_transfer_holes", { sourceId: blockId, targetId: bracketId, select: { radiusMm: 1.5, axis: "z", kind: "hole" }, hole: { diameterMm: 3.4, through: true } });
  live.check("3", `transfer_holes: ${transfer.result.targetHoleCount} holes, read-back max coaxial offset ${transfer.result.maxCoaxialOffsetMm} mm`, transfer.result.targetHoleCount === 4 && transfer.result.maxCoaxialOffsetMm <= 1e-6);
  await verifyChain(live, "direct calls", blockId, bracketId);
  live.evidence.case3direct = { place: { deltaMm: place.result.deltaMm, anchorMm: place.result.anchorMm, boundsMm: place.result.boundsMm, ms: place.ms, serverMs: place.result.timing?.totalMs }, transfer: { axesMm: transfer.result.axesMm, ms: transfer.ms, serverMs: transfer.result.timing?.totalMs } };
  await live.restore("3");

  // (b) the same chain as one lean batch with $n references
  const steps = [
    { toolName: "plasticity_create_box", arguments: { originMm: [BX, 0, 0], sizeMm: [60, 40, 20], name: "mate-block" }, return: ["timing.totalMs"] },
    { toolName: "plasticity_create_blind_hole_pattern", arguments: { targetId: "$0.added[0]", entryCentersMm: PILOTS, axis: [0, 0, 1], holeDiameterMm: 3, holeDepthMm: 8, materialDepthMm: 20, overshootMm: 0.5 }, return: ["holeCount", "timing.totalMs"] },
    { toolName: "plasticity_create_bracket", arguments: CHAIN_BRACKET, return: ["bodyId", "timing.totalMs"] },
    { toolName: "plasticity_find_faces", arguments: { query: { bodyIds: ["$0.added[0]"], ...BLOCK_BOTTOM }, limit: 1000 }, return: ["matches[*].id"] },
    { toolName: "plasticity_place_body", arguments: { id: "$2.result.bodyId", anchor: { faceId: "$2.result.faceIds.base.outerFaceId" }, to: { bodyId: "$0.added[0]", faceId: "$3.result.matches[0].id" }, rotate: { axis: "x", quarterTurns: 2 }, gapMm: 0 }, return: ["relation", "deltaMm", "undoSteps", "timing.totalMs"] },
    { toolName: "plasticity_transfer_holes", arguments: { sourceId: "$0.added[0]", targetId: "$2.result.bodyId", select: { radiusMm: 1.5, axis: "z", kind: "hole" }, hole: { diameterMm: 3.4, through: true } }, return: ["targetHoleCount", "maxCoaxialOffsetMm", "undoSteps", "timing.totalMs"] },
  ];
  const before = await live.status();
  const batchArgs = { detail: "lean", steps };
  const started = performance.now();
  const out = await live.call("plasticity_batch", batchArgs);
  const ms = Math.round(performance.now() - started);
  const after = await live.status();
  const bytes = Buffer.byteLength(JSON.stringify(batchArgs));
  const blockAdded = out.summary.added.find((body: { name: string }) => body.name === "mate-block");
  const bracketAdded = out.summary.added.find((body: { name: string }) => body.name === "mate-bracket");
  live.check("3", `one lean batch: ${bytes} B request, ${ms} ms round trip, ${out.summary.undoSteps} Undo steps (measured ${after.undoDepth - before.undoDepth})`, out.summary.undoSteps === after.undoDepth - before.undoDepth && out.steps[5].result.targetHoleCount === 4 && out.steps[4].result.relation === "mating", { steps: out.steps.map((step: any) => step.result) });
  const serverMsSteps = out.steps.map((step: any) => step.result?.["timing.totalMs"]).filter((value: unknown) => typeof value === "number");
  live.evidence.case3batch = { requestBytes: bytes, clientMs: ms, replyBytes: Buffer.byteLength(JSON.stringify(out)), undoSteps: out.summary.undoSteps, stepResults: out.steps.map((step: any) => step.result), serverMsSteps, serverMsSum: Math.round(serverMsSteps.reduce((sum: number, value: number) => sum + value, 0) * 10) / 10, note: "serverMsSum adds the journaled totalMs of the five mutating steps; the find_faces read step has no journal timing" };
  live.check("3", `one lean batch timing: ${serverMsSteps.length} mutating steps carry server timing (sum ${live.evidence.case3batch && (live.evidence.case3batch as any).serverMsSum} ms)`, serverMsSteps.length === 5);
  await verifyChain(live, "one batch", blockAdded.id, bracketAdded.id);
}

async function case4(live: Live): Promise<void> {
  const block = await live.mutate("4", "plasticity_create_box", { originMm: [BX, 0, 0], sizeMm: [60, 40, 20], name: "mate-block" });
  const blockId = block.result.change.added[0].id as number;
  await live.mutate("4", "plasticity_create_blind_hole_pattern", { targetId: blockId, entryCentersMm: PILOTS, axis: [0, 0, 1], holeDiameterMm: 3, holeDepthMm: 8, materialDepthMm: 20, overshootMm: 0.5 });
  const bracket = await live.mutate("4", "plasticity_create_bracket", CHAIN_BRACKET);
  const bracketId = bracket.result.bodyId as number;
  const side = (await live.faces({ bodyIds: [blockId], planar: true, normal: { vector: [1, 0, 0], toleranceDeg: 0.000001 } }))[0];
  const unchanged = async (label: string, run: () => Promise<string>, pattern: RegExp) => {
    const before = await live.status();
    const message = await run();
    const after = await live.status();
    live.check("4", `${label}: refused (${message.slice(0, 160)}...)`, pattern.test(message) && after.revision === before.revision && after.undoDepth === before.undoDepth, { message: message.slice(0, 600) });
  };
  await unchanged("place_body with non-parallel faces", async () => live.refused("plasticity_place_body", { id: bracketId, anchor: { faceId: bracket.result.faceIds.base.outerFaceId }, to: { bodyId: blockId, faceId: side.id }, gapMm: 0, revision: (await live.status()).revision }), /neither mating nor parallel.*\[0,0,-1\].*\[1,0,0\]/);
  await unchanged("transfer_holes select that matches nothing", async () => live.refused("plasticity_transfer_holes", { sourceId: blockId, targetId: bracketId, select: { radiusMm: 9 }, hole: { diameterMm: 3.4, through: true }, revision: (await live.status()).revision }), /matched no full-turn cylinder axis.*"radiusMm":1\.5,"kind":"hole","axes":4/);
  await unchanged("transfer_holes axis that misses the target", async () => live.refused("plasticity_transfer_holes", { sourceId: blockId, targetId: bracketId, axesMm: [{ pointMm: [BX + 900, 0, 0], axis: [0, 0, 1] }], hole: { diameterMm: 3.4, through: true }, revision: (await live.status()).revision }), /axis 0 \(point \[\d+,0,0\], direction \[0,0,1\]\) misses the target body/);

  // The quarter-turn direction, shown by a face anchor (bounds alone cannot show it): after +90 degrees about z (right-hand
  // rule) the upright's outer face (normal -X) faces -Y, so it mates the block's +Y face. A turn the other way would face +Y
  // and the tool's own face read-back would fail.
  const plusY = (await live.faces({ bodyIds: [blockId], planar: true, normal: { vector: [0, 1, 0], toleranceDeg: 0.000001 } }))[0];
  const turn = await live.mutate("4", "plasticity_place_body", { id: bracketId, anchor: { faceId: bracket.result.faceIds.upright.outerFaceId }, to: { bodyId: blockId, faceId: plusY.id }, rotate: { axis: "z", quarterTurns: 1 }, gapMm: 0 });
  const facing = (await live.faces({ bodyIds: [bracketId], planar: true, normal: { vector: [0, -1, 0], toleranceDeg: 0.000001 } })).filter((face: any) => near(face.centerMm, plusY.centerMm));
  const turnedBounds = await live.bodyBounds(bracketId);
  live.check("4", "quarter turn +90 about z: the upright's outer face (was -X) faces -Y on the block's +Y face centre, the bracket lies at y >= 40", turn.result.relation === "mating" && facing.length === 1 && !!turnedBounds && Math.abs(turnedBounds.min[1] - 40) <= 1e-6, { deltaMm: turn.result.deltaMm, boundsMm: turnedBounds, movedFaceId: turn.result.movedFaceId, facing: facing.map((face: any) => face.id) });
  const interference = await live.call("plasticity_check_interference", { pairs: [{ firstBodyId: blockId, secondBodyId: bracketId }], revision: (await live.status()).revision });
  live.check("4", "quarter turn: no volumetric interference with the block", interference.pairs[0].status === "no-volumetric-interference");
  live.evidence.case4turn = { deltaMm: turn.result.deltaMm, boundsMm: turnedBounds, rotation: turn.result.rotation, undoSteps: turn.result.undoSteps };
}

// ---------- review cases: the reviewer's failing inputs, one per defect, measured by independent reads ----------

/** Creates a body with a mutating tool and returns the one new body id. */
async function make(live: Live, caseName: string, name: string, args: Record<string, unknown>): Promise<number> {
  const before = await live.status();
  await live.mutate(caseName, name, args);
  const added = await live.added(before);
  if (added.length !== 1) throw new Error(`${name} added ${added.length} bodies`);
  return added[0]!;
}
async function union(live: Live, targetId: number, toolId: number, name: string): Promise<number> {
  await live.call("plasticity_boolean", { targetIds: [targetId], toolIds: [toolId], operation: "union", revision: (await live.status()).revision });
  return (await live.status()).bodies.find((body: { name: string | null }) => body.name === name)!.id;
}
const cylindersOf = async (live: Live, id: number, radiusMm: number) => await live.faces({ bodyIds: [id], surfaceTypes: ["Cylinder"], radiusMm: { value: radiusMm, tolerance: 1e-6 } });
async function validClosed(live: Live, id: number): Promise<boolean> {
  const body = (await live.call("plasticity_validate_bodies", { ids: [id], revision: (await live.status()).revision })).bodies[0];
  return body.type === "Solid" && body.closed && body.nativeValid;
}
// A 40 x 40 x 5 flange (z 10..15) on a 12 mm stem (x 0..12, z 0..10): the review's stepped target (p7 C1, C2).
async function steppedTarget(live: Live, caseName: string): Promise<number> {
  const flange = await make(live, caseName, "plasticity_create_box", { originMm: [2500, 0, 10], sizeMm: [40, 40, 5], name: "step" });
  const stem = await make(live, caseName, "plasticity_create_box", { originMm: [2500, 0, 0], sizeMm: [12, 40, 10] });
  return await union(live, flange, stem, "step");
}

async function caseD1(live: Live): Promise<void> {
  // p7 B1: a source with a through hole, a blind hole and a boss, all r 2.5, over a plate.
  const plate = await make(live, "d1", "plasticity_create_box", { originMm: [2495, -5, 0], sizeMm: [60, 40, 8], name: "d1-plate" });
  let block = await make(live, "d1", "plasticity_create_box", { originMm: [2500, 0, 8], sizeMm: [40, 30, 6], name: "d1-block" });
  block = (await live.mutate("d1", "plasticity_transfer_holes", { sourceId: plate, targetId: block, axesMm: [{ pointMm: [2510, 15, 30], axis: [0, 0, -1] }], hole: { diameterMm: 5, through: true } })).result.targetId;
  const boss = await make(live, "d1", "plasticity_create_cylinder", { centerMm: [2530, 15, 14], radiusMm: 2.5, heightMm: 5, axis: [0, 0, 1] });
  block = await union(live, block, boss, "d1-block");
  block = (await live.mutate("d1", "plasticity_transfer_holes", { sourceId: plate, targetId: block, axesMm: [{ pointMm: [2520, 8, 0], axis: [0, 0, 1] }], hole: { diameterMm: 5, depthMm: 3 } })).result.targetId;
  const fixture = (await live.status()).undoDepth;
  const transfer = await live.mutate("d1", "plasticity_transfer_holes", { sourceId: block, targetId: plate, select: { radiusMm: 2.5 }, hole: { diameterMm: 5, through: true } });
  const cut = await cylindersOf(live, transfer.result.targetId, 2.5);
  const on = (x: number, y: number) => cut.filter((face: any) => coaxial([x, y, 0], [0, 0, 1], face.axisOriginMm, face.axisDirection) <= 1e-6).length;
  live.check("d1", `select without kind takes holes only: kinds ${JSON.stringify(transfer.result.axesMm.map((axis: any) => axis.kind))}; plate holes under the through hole ${on(2510, 15)}, the blind hole ${on(2520, 8)}, the boss ${on(2530, 15)}`,
    transfer.result.axesMm.every((axis: any) => axis.kind === "hole") && transfer.result.axisCount === 2 && on(2510, 15) === 1 && on(2520, 8) === 1 && on(2530, 15) === 0, { axesMm: transfer.result.axesMm });
  await live.undoTo(fixture);
  const any = await live.mutate("d1", "plasticity_transfer_holes", { sourceId: block, targetId: plate, select: { radiusMm: 2.5, kind: "any" }, hole: { diameterMm: 5, through: true } });
  const kinds = any.result.axesMm.map((axis: any) => axis.kind).sort();
  live.check("d1", `kind "any" takes the boss too and says so: kinds ${JSON.stringify(kinds)}`, JSON.stringify(kinds) === JSON.stringify(["boss", "hole", "hole"]));
}

async function caseD2(live: Live): Promise<void> {
  const step = await steppedTarget(live, "d2");
  const source = await make(live, "d2", "plasticity_create_box", { originMm: [2500, 100, 0], sizeMm: [5, 5, 5], name: "d2-source" });
  // p7 C1: the axis on the stem's side wall; C1b: 2 mm outside it, the rim grazes the stem.
  for (const [label, x] of [["C1 axis on the stem side wall", 2512], ["C1b rim grazing the stem", 2514]] as const) {
    await live.refusedUnchanged("d2", `${label}: side breakout`, "plasticity_transfer_holes", { sourceId: source, targetId: step, axesMm: [{ pointMm: [x, 20, 30], axis: [0, 0, -1] }], hole: { diameterMm: 5, through: true } }, /axis 0( \(point [^)]*\))?: the bore breaks out of a side wall of the target/);
    live.check("d2", `${label}: no Ø5 bore left on the target`, (await cylindersOf(live, step, 2.5)).length === 0);
  }
}

async function caseD3(live: Live): Promise<void> {
  // p9: a rod across a U; the axis meets the rod (curved) before the base (planar).
  const u = await make(live, "d3", "plasticity_create_bracket", { originMm: [2000, 0, 0], profile: "U", widthMm: 30, thicknessMm: 3, legs: { baseMm: 40, leftMm: 30, rightMm: 30 }, name: "ubody" });
  const rod = await make(live, "d3", "plasticity_create_cylinder", { centerMm: [2000, 15, 22], radiusMm: 6, heightMm: 40, axis: [1, 0, 0] });
  const target = await union(live, u, rod, "ubody");
  const source = await make(live, "d3", "plasticity_create_box", { originMm: [2000, 100, 0], sizeMm: [5, 5, 5], name: "d3-source" });
  await live.refusedUnchanged("d3", "drill down through the rod and the base", "plasticity_transfer_holes", { sourceId: source, targetId: target, axesMm: [{ pointMm: [2020, 15, 60], axis: [0, 0, -1] }], hole: { diameterMm: 4, through: true } }, /material precedes the first planar face/);
  live.check("d3", "no Ø4 bore on the target", (await cylindersOf(live, target, 2)).length === 0);
}

async function caseD45(live: Live): Promise<void> {
  const L = { originMm: [2000, 0, 0], profile: "L", widthMm: 30, thicknessMm: 4, legs: { baseMm: 40, uprightMm: 40 } };
  // p3 gmax (defect 4) and gmaxrc (defect 5): refused with the largest size; that size builds clean.
  for (const [label, extra, refused, largest] of [
    ["gmax", { gussets: { count: 1, thicknessMm: 4 } }, 36, 35.45],
    ["gmaxrc", { cornerRadiusMm: 3, gussets: { count: 2, thicknessMm: 4 } }, 33, 32.45],
  ] as const) {
    const input = (sizeMm: number) => ({ ...L, ...extra, gussets: { ...extra.gussets, sizeMm }, name: `d45-${label}` });
    await live.refusedUnchanged("d45", `${label} sizeMm ${refused}`, "plasticity_create_bracket", input(refused), new RegExp(`largest allowed gussets\\.sizeMm here is ${String(largest).replace(".", "\\.")} mm`));
    const built = await live.mutate("d45", "plasticity_create_bracket", input(largest));
    const id = built.result.bodyId;
    const edges = await live.edges({ bodyIds: [id] });
    const shortest = Math.min(...edges.map((edge: any) => edge.lengthMm));
    const bounds = await live.bodyBounds(id);
    live.check("d45", `${label} at the stated largest ${largest}: shortest edge ${shortest} mm >= 0.05, bounds = planned, closed and valid`,
      shortest >= 0.05 && !!bounds && boundsNear(bounds, { min: [2000, 0, 0], max: [2040, 30, 40] }) && await validClosed(live, id), { shortest, bounds });
    await live.undoTo(live.baseline.undoDepth);
  }
}

async function caseD6(live: Live): Promise<void> {
  // p3 unarrow: U base 4.3, t 2 (gap 0.3); a hole in the left leg.
  const built = await live.mutate("d6", "plasticity_create_bracket", { originMm: [2000, 0, 0], profile: "U", widthMm: 20, thicknessMm: 2, legs: { baseMm: 4.3, leftMm: 20, rightMm: 20 }, holes: [{ leg: "left", diameterMm: 4, count: 1, layout: "line-along" }], name: "d6-narrow" });
  const id = built.result.bodyId;
  const rightInner = await live.faces({ bodyIds: [id], planar: true, normal: { vector: [-1, 0, 0], toleranceDeg: 0.000001 }, center: { pointMm: [2002.3, 10, 11], toleranceMm: 10 } });
  const atRight = rightInner.filter((face: any) => Math.abs(face.centerMm[0] - 2002.3) <= 1e-6);
  const bores = await cylindersOf(live, id, 2);
  live.check("d6", `the right leg's inner face is untouched (one face, ${atRight[0]?.edgeIds?.length} edges); the bore stays in x 2000..2002 (face bounds within 1e-3, the gap is 0.3: ${JSON.stringify(bores.map((face: any) => [face.boundsMm.min[0], face.boundsMm.max[0]]))})`,
    atRight.length === 1 && atRight[0].edgeIds.length === 4 && bores.length === 1 && bores[0].boundsMm.max[0] <= 2002 + 1e-3 && await validClosed(live, id), { faces: atRight.map((face: any) => ({ id: face.id, edges: face.edgeIds.length })) });
}

async function caseD7(live: Live): Promise<void> {
  const step = await steppedTarget(live, "d7");
  const source = await make(live, "d7", "plasticity_create_box", { originMm: [2500, 100, 0], sizeMm: [5, 5, 5], name: "d7-source" });
  // p7 C2: blind 7 deep where the flange is 5 (the bounds are 15).
  await live.refusedUnchanged("d7", "C2 blind 7 into the 5 mm flange", "plasticity_transfer_holes", { sourceId: source, targetId: step, axesMm: [{ pointMm: [2530, 20, 30], axis: [0, 0, -1] }], hole: { diameterMm: 5, depthMm: 7 } }, /depthMm 7 reaches the far side of the wall: the next target face on the axis is 5\.0000 mm/);
  const blind = await live.mutate("d7", "plasticity_transfer_holes", { sourceId: source, targetId: step, axesMm: [{ pointMm: [2530, 20, 30], axis: [0, 0, -1] }], hole: { diameterMm: 5, depthMm: 3 } });
  const floor = await live.faces({ bodyIds: [blind.result.targetId], planar: true, normal: { vector: [0, 0, 1], toleranceDeg: 0.000001 }, center: { pointMm: [2530, 20, 12], toleranceMm: 1e-6 } });
  live.check("d7", "blind 3 in the 5 mm flange: a flat floor at z 12, closed and valid", floor.length === 1 && await validClosed(live, blind.result.targetId));
  // p7 C8: blind 10 into a 3 mm wall of a U (the bounds are 40).
  const u = await make(live, "d7", "plasticity_create_bracket", { originMm: [2600, 0, 0], profile: "U", widthMm: 30, thicknessMm: 3, legs: { baseMm: 40, leftMm: 30, rightMm: 30 }, name: "d7-u" });
  await live.refusedUnchanged("d7", "C8 blind 10 into the 3 mm U wall", "plasticity_transfer_holes", { sourceId: source, targetId: u, axesMm: [{ pointMm: [2590, 15, 20], axis: [1, 0, 0] }], hole: { diameterMm: 4, depthMm: 10 } }, /depthMm 10 reaches the far side of the wall: the next target face on the axis is 3\.0000 mm/);
}

async function caseD8(live: Live): Promise<void> {
  // p5: a plate and a block.
  const plate = (await live.mutate("d8", "plasticity_create_bracket", { originMm: [2000, 0, 0], profile: "flat", widthMm: 60, thicknessMm: 5, legs: { lengthMm: 100 }, name: "d8-plate" })).result;
  const block = (await live.mutate("d8", "plasticity_create_bracket", { originMm: [2200, 0, 0], profile: "flat", widthMm: 20, thicknessMm: 10, legs: { lengthMm: 30 }, name: "d8-block" })).result;
  const pTop = plate.faceIds.flat.innerFaceId, qTop = block.faceIds.flat.innerFaceId, qBottom = block.faceIds.flat.outerFaceId;
  const fixture = (await live.status()).undoDepth;
  await live.refusedUnchanged("d8", "p5 #3 same-facing top onto top", "plasticity_place_body", { id: block.bodyId, anchor: { faceId: qTop }, to: { bodyId: plate.bodyId, faceId: pTop } }, /face the same way.*Flip the body.*relation: "aligned"/);
  await live.refusedUnchanged("d8", "p5 #2b gapMm -1", "plasticity_place_body", { id: block.bodyId, anchor: { faceId: qBottom }, to: { bodyId: plate.bodyId, faceId: pTop }, gapMm: -1 }, /gapMm -1 pushes the faces 1 mm into each other.*allowOverlap: true/);
  const mate = await live.mutate("d8", "plasticity_place_body", { id: block.bodyId, anchor: { faceId: qBottom }, to: { bodyId: plate.bodyId, faceId: pTop } });
  const interference = await live.call("plasticity_check_interference", { pairs: [{ firstBodyId: plate.bodyId, secondBodyId: block.bodyId }], revision: (await live.status()).revision });
  live.check("d8", `a real mate (bottom onto top): relation ${mate.result.relation}, ${interference.pairs[0].status}`, mate.result.relation === "mating" && interference.pairs[0].status === "no-volumetric-interference");
  await live.undoTo(fixture);
  // p5 6e: a block turned 1e-5 degrees about x (sine 1.7e-7) now mates.
  await live.call("plasticity_rotate", { ids: [block.bodyId], pivotMm: [2215, 10, 5], axis: [1, 0, 0], degrees: 0.00001, revision: (await live.status()).revision });
  const bottom = (await live.faces({ bodyIds: [block.bodyId], planar: true, normal: { vector: [0, 0, -1], toleranceDeg: 0.001 } }))[0];
  const near = await live.mutate("d8", "plasticity_place_body", { id: block.bodyId, anchor: { faceId: bottom.id }, to: { bodyId: plate.bodyId, faceId: pTop } });
  live.check("d8", `1e-5 degrees off parallel mates (was refused at sine 1e-9): relation ${near.result.relation}`, near.result.relation === "mating");
}

async function caseD9(live: Live): Promise<void> {
  // p6 A8: two holes 14 mm apart, a Ø16 transfer.
  const source = (await live.mutate("d9", "plasticity_create_bracket", { originMm: [2000, 0, 8], profile: "L", widthMm: 30, thicknessMm: 4, legs: { baseMm: 40, uprightMm: 40 }, innerBendRadiusMm: 2.5, cornerRadiusMm: 2.5, holes: [{ leg: "base", diameterMm: 5, count: 2, layout: "line-across", marginMm: 8 }], name: "d9-source" })).result;
  const plate = (await live.mutate("d9", "plasticity_create_bracket", { originMm: [1980, -15, 0], profile: "flat", widthMm: 60, thicknessMm: 8, legs: { lengthMm: 100 }, name: "d9-plate" })).result;
  await live.refusedUnchanged("d9", "A8 Ø16 on axes 14 apart", "plasticity_transfer_holes", { sourceId: source.bodyId, targetId: plate.bodyId, select: { radiusMm: 2.5, axis: "z" }, hole: { diameterMm: 16, through: true } }, /are 14\.0000 mm apart, closer than the Ø16 mm hole: the holes would overlap/);
  live.check("d9", "no Ø16 bore on the plate", (await cylindersOf(live, plate.bodyId, 8)).length === 0);
}

async function caseD10(live: Live): Promise<void> {
  // p7 C6: one axis through both walls of a U.
  const u = (await live.mutate("d10", "plasticity_create_bracket", { originMm: [2600, 0, 0], profile: "U", widthMm: 30, thicknessMm: 3, legs: { baseMm: 40, leftMm: 30, rightMm: 30 }, name: "d10-u" })).result;
  const source = await make(live, "d10", "plasticity_create_box", { originMm: [2500, 100, 0], sizeMm: [5, 5, 5], name: "d10-source" });
  const transfer = await live.mutate("d10", "plasticity_transfer_holes", { sourceId: source, targetId: u.bodyId, axesMm: [{ pointMm: [2590, 15, 20], axis: [1, 0, 0] }], hole: { diameterMm: 4, through: true } });
  const bores = (await cylindersOf(live, transfer.result.targetId, 2)).filter((face: any) => coaxial([2590, 15, 20], [1, 0, 0], face.axisOriginMm, face.axisDirection) <= 1e-6);
  live.check("d10", `axisCount ${transfer.result.axisCount}, holeCount ${transfer.result.holeCount}, targetHoleCount ${transfer.result.targetHoleCount}; ${bores.length} coaxial Ø4 faces read independently`,
    transfer.result.axisCount === 1 && transfer.result.holeCount === 2 && transfer.result.targetHoleCount === 2 && bores.length === 2 && await validClosed(live, transfer.result.targetId));
}

async function caseD11(live: Live): Promise<void> {
  const L = { originMm: [2000, 0, 0], profile: "L", widthMm: 30, thicknessMm: 4, legs: { baseMm: 40, uprightMm: 40 } };
  // p4: the giant leg and the "mid-way" tiny inputs are refused before any native call.
  await live.refusedUnchanged("d11", "p4 MID giant 2e6 mm leg", "plasticity_create_bracket", { ...L, legs: { baseMm: 2e6, uprightMm: 40 } }, /legs\.baseMm 2000000 mm is above the 10000 mm limit/);
  await live.refusedUnchanged("d11", "p4 MID gusset thickness 1e-7", "plasticity_create_bracket", { ...L, gussets: { count: 1, thicknessMm: 1e-7, sizeMm: 10 } }, /gussets\.thicknessMm 1e-7 mm is below 0\.05 mm/);
  await live.refusedUnchanged("d11", "p4 MID hole diameter 1e-7", "plasticity_create_bracket", { ...L, holes: [{ leg: "base", diameterMm: 1e-7, count: 1, layout: "line-along" }] }, /diameterMm 1e-7 mm is below 0\.05 mm/);
  await live.refusedUnchanged("d11", "p4 MID bend radius 1e-7", "plasticity_create_bracket", { ...L, innerBendRadiusMm: 1e-7 }, /innerBendRadiusMm 1e-7 mm is below 0\.05 mm/);
  await live.refusedUnchanged("d11", "p4 MID thickness and width 1e-6", "plasticity_create_bracket", { ...L, widthMm: 1e-6, thicknessMm: 1e-6 }, /below 0\.05 mm/);
  // Every build and transfer passes the native Check before it reports completed; read it independently.
  const built = await live.mutate("d11", "plasticity_create_bracket", { ...L, innerBendRadiusMm: 3, cornerRadiusMm: 3, holes: [{ leg: "base", diameterMm: 4.5, count: 2, layout: "line-across", marginMm: 8 }], name: "d11-bracket" });
  const plate = await make(live, "d11", "plasticity_create_box", { originMm: [1990, -10, -6], sizeMm: [60, 50, 6], name: "d11-plate" });
  const transfer = await live.mutate("d11", "plasticity_transfer_holes", { sourceId: built.result.bodyId, targetId: plate, select: { radiusMm: 2.25, axis: "z" }, hole: { diameterMm: 3.3, through: true } });
  live.check("d11", "the completed bracket and the transferred plate are closed, natively valid Solids", await validClosed(live, built.result.bodyId) && await validClosed(live, transfer.result.targetId) && transfer.result.holeCount === 2);
}

// ---------- round 2: entry, wall and breakout from exact rays ----------

/** Every Ø(2r) bore face on the axis, measured independently: coaxial within 1e-6, every circle edge a full turn, no other edge on another face. */
async function boresOn(live: Live, id: number, radius: number, point: Vec, axis: Vec): Promise<{ count: number; whole: boolean }> {
  const faces = (await cylindersOf(live, id, radius)).filter((face: any) => coaxial(point, axis, face.axisOriginMm, face.axisDirection) <= 1e-6);
  const edges = new Map((await live.edges({ bodyIds: [id] })).map((edge: any) => [edge.id, edge]));
  const whole = faces.every((face: any) => face.edgeIds.every((edgeId: string) => {
    const edge: any = edges.get(edgeId);
    if (!edge) return false;
    if (edge.circle) return Math.abs(edge.lengthMm - 2 * Math.PI * radius) <= 1e-6;
    return edge.faceIds.every((other: string) => other === face.id);
  }));
  return { count: faces.length, whole };
}
async function difference(live: Live, caseName: string, target: number, tool: number, name: string): Promise<number> {
  await live.call("plasticity_boolean", { targetIds: [target], toolIds: [tool], operation: "difference", revision: (await live.status()).revision });
  return (await live.status()).bodies.find((body: { name: string | null }) => body.name === name)!.id;
}
/** One transfer that must cut: completed, then measured; undone afterwards. */
async function cutAndMeasure(live: Live, caseName: string, label: string, sourceId: number, targetId: number, axes: Array<{ pointMm: Vec; axis: Vec }> | undefined, select: Record<string, unknown> | undefined, hole: Record<string, unknown>, radius: number): Promise<void> {
  const before = (await live.status()).undoDepth;
  const response = await live.client.callTool({ name: "plasticity_transfer_holes", arguments: { sourceId, targetId, ...(axes ? { axesMm: axes } : { select }), hole, revision: (await live.status()).revision } });
  const text = toolText(response);
  if ((response as { isError?: boolean }).isError) { live.check(caseName, `${label}: cut`, false, text.slice(0, 1200)); return; }
  const result = JSON.parse(text);
  const measured = await Promise.all(result.axesMm.map((entry: any) => boresOn(live, result.targetId, radius, entry.entryPointMm, entry.axis)));
  live.check(caseName, `${label}: cut at ${JSON.stringify(result.axesMm.map((entry: any) => entry.entryPointMm))}; each axis has ${JSON.stringify(measured.map((entry) => entry.count))} coaxial Ø${2 * radius} bore face(s), every one with full circles; closed and valid (probe ${result.probe.rays} rays, ${result.probe.ms} ms)`,
    measured.every((entry) => entry.count >= 1 && entry.whole) && await validClosed(live, result.targetId), { axesMm: result.axesMm, measured });
  await live.undoTo(before);
}

async function caseR2B1(live: Live): Promise<void> {
  const source = await make(live, "r2b1", "plasticity_create_box", { originMm: [2000, 300, 0], sizeMm: [5, 5, 5], name: "r2-source" });
  const T3 = { diameterMm: 3, through: true };
  // q5 pocket: 60 x 40 x 15 with a 40 x 24 pocket, floor 5.
  const block = await make(live, "r2b1", "plasticity_create_box", { originMm: [2000, 0, 0], sizeMm: [60, 40, 15], name: "r2-pocket" });
  const pocket = await make(live, "r2b1", "plasticity_create_box", { originMm: [2010, 8, 5], sizeMm: [40, 24, 20] });
  let target = await difference(live, "r2b1", block, pocket, "r2-pocket");
  await cutAndMeasure(live, "r2b1", "pocket centre, Ø3 through the floor", source, target, [{ pointMm: [2030, 20, 50], axis: [0, 0, -1] }], undefined, T3, 1.5);
  await cutAndMeasure(live, "r2b1", "pocket floor, blind Ø3 x 4", source, target, [{ pointMm: [2030, 20, 50], axis: [0, 0, -1] }], undefined, { diameterMm: 3, depthMm: 4 }, 1.5);
  // The pocket with its four vertical corners filleted r5: a hole on a fillet's axis (the fillet ends at the floor).
  const filleted = (await live.mutate("r2b1", "plasticity_fillet", { id: target, edgeIds: (await live.edges({ bodyIds: [target], line: true })).filter((edge: any) => Math.abs(edge.tangent[2]) > 0.99 && Math.abs(edge.centerMm[2] - 10) < 1e-6 && edge.centerMm[0] > 2005 && edge.centerMm[0] < 2055 && edge.centerMm[1] > 5 && edge.centerMm[1] < 35).map((edge: any) => edge.id), radiusMm: 5 }));
  const pocketId = (await live.status()).bodies.find((body: { name: string | null }) => body.name === "r2-pocket")!.id;
  live.check("r2b1", "pocket corners filleted", !!filleted && pocketId > 0);
  await cutAndMeasure(live, "r2b1", "Ø3 on the axis of a pocket-corner fillet r5", source, pocketId, [{ pointMm: [2015, 13, 50], axis: [0, 0, -1] }], undefined, T3, 1.5);
  await live.undoTo((await live.status()).undoDepth - 1);
  await live.call("plasticity_rotate", { ids: [target], pivotMm: [2030, 20, 0], axis: [0, 0, 1], degrees: 30, revision: (await live.status()).revision });
  const c = Math.cos(Math.PI / 6), sn = Math.sin(Math.PI / 6);
  for (const [u, v] of [[0, 0], [15, 8]] as const) await cutAndMeasure(live, "r2b1", `pocket turned 30 degrees, offset [${u},${v}]`, source, target, [{ pointMm: [2030 + u * c - v * sn, 20 + u * sn + v * c, 50], axis: [0, 0, -1] }], undefined, T3, 1.5);
  await live.undoTo(live.baseline.undoDepth + 1);
  // q6 enclosure: an L bracket on the floor of an open 80 x 60 x 30 box, select its base holes.
  const outer = await make(live, "r2b1", "plasticity_create_box", { originMm: [2000, 0, 0], sizeMm: [80, 60, 30], name: "r2-enclosure" });
  const inner = await make(live, "r2b1", "plasticity_create_box", { originMm: [2003, 3, 3], sizeMm: [74, 54, 40] });
  target = await difference(live, "r2b1", outer, inner, "r2-enclosure");
  const bracket = (await live.mutate("r2b1", "plasticity_create_bracket", { originMm: [2020, 15, 3], profile: "L", widthMm: 30, thicknessMm: 3, legs: { baseMm: 30, uprightMm: 20 }, holes: [{ leg: "base", diameterMm: 3.4, count: 2, layout: "line-across", marginMm: 7 }], name: "r2-bracket" })).result;
  await cutAndMeasure(live, "r2b1", "enclosure floor, select the bracket's base holes, blind Ø2.5 x 2", bracket.bodyId, target, undefined, { radiusMm: 1.7, axis: "z" }, { diameterMm: 2.5, depthMm: 2 }, 1.25);
  await cutAndMeasure(live, "r2b1", "enclosure floor, select, through Ø3.4", bracket.bodyId, target, undefined, { radiusMm: 1.7, axis: "z" }, { diameterMm: 3.4, through: true }, 1.7);
  // A bracket upright against an inside wall: the far wall lies past the other end of its holes; select drills the near one.
  const upright = (await live.mutate("r2b1", "plasticity_create_bracket", { originMm: [2003, 15, 3], profile: "L", widthMm: 30, thicknessMm: 3, legs: { baseMm: 30, uprightMm: 20 }, holes: [{ leg: "upright", diameterMm: 3.4, count: 2, layout: "line-across", marginMm: 7 }], name: "r2-upright" })).result;
  await cutAndMeasure(live, "r2b1", "upright against the enclosure's inside wall, select, blind Ø2.5 x 2 into the near wall", upright.bodyId, target, undefined, { radiusMm: 1.7, axis: "x" }, { diameterMm: 2.5, depthMm: 2 }, 1.25);
  await live.undoTo(live.baseline.undoDepth + 1);
  // q7 tray with a 5 mm lip.
  const tray = await make(live, "r2b1", "plasticity_create_box", { originMm: [2900, 0, 0], sizeMm: [60, 40, 8], name: "r2-tray" });
  const well = await make(live, "r2b1", "plasticity_create_box", { originMm: [2902, 2, 3], sizeMm: [56, 36, 10] });
  target = await difference(live, "r2b1", tray, well, "r2-tray");
  await cutAndMeasure(live, "r2b1", "tray floor centre, Ø3 through", source, target, [{ pointMm: [2930, 20, 50], axis: [0, 0, -1] }], undefined, T3, 1.5);
  await live.undoTo(live.baseline.undoDepth + 1);
  // q5 round recess Ø12 x 3 in a plate, and a cup.
  const plate = await make(live, "r2b1", "plasticity_create_box", { originMm: [2100, 0, 0], sizeMm: [80, 60, 6], name: "r2-plate" });
  const recess = await make(live, "r2b1", "plasticity_create_cylinder", { centerMm: [2120, 30, 3], radiusMm: 6, heightMm: 10 });
  target = await difference(live, "r2b1", plate, recess, "r2-plate");
  await cutAndMeasure(live, "r2b1", "pilot Ø3 at the centre of a Ø12 recess", source, target, [{ pointMm: [2120, 30, 50], axis: [0, 0, -1] }], undefined, T3, 1.5);
  await cutAndMeasure(live, "r2b1", "Ø3 in the Ø12 recess floor, 2.5 mm off centre", source, target, [{ pointMm: [2122.5, 30, 50], axis: [0, 0, -1] }], undefined, T3, 1.5);
  const cup = await make(live, "r2b1", "plasticity_create_cylinder", { centerMm: [2030, 30, 0], radiusMm: 30, heightMm: 20, name: "r2-cup" });
  const hollow = await make(live, "r2b1", "plasticity_create_cylinder", { centerMm: [2030, 30, 5], radiusMm: 25, heightMm: 30 });
  const cupId = await difference(live, "r2b1", cup, hollow, "r2-cup");
  await cutAndMeasure(live, "r2b1", "cup floor centre, Ø3 through", source, cupId, [{ pointMm: [2030, 30, 50], axis: [0, 0, -1] }], undefined, T3, 1.5);
  await cutAndMeasure(live, "r2b1", "cup floor 10 mm off centre, Ø3 through", source, cupId, [{ pointMm: [2040, 30, 50], axis: [0, 0, -1] }], undefined, T3, 1.5);
  await live.undoTo(live.baseline.undoDepth + 1);
  // q5 a 45 degree rib on a plate: a Ø5 hole 15 mm from it.
  const ribPlate = await make(live, "r2b1", "plasticity_create_box", { originMm: [2000, 0, 0], sizeMm: [80, 80, 5], name: "r2-ribplate" });
  const rib = await make(live, "r2b1", "plasticity_create_box", { originMm: [2010, 38.5, 5], sizeMm: [60, 3, 10] });
  await live.call("plasticity_rotate", { ids: [rib], pivotMm: [2040, 40, 5], axis: [0, 0, 1], degrees: 45, revision: (await live.status()).revision });
  target = await union(live, ribPlate, rib, "r2-ribplate");
  await cutAndMeasure(live, "r2b1", "Ø5 through 15 mm from a 45 degree rib", source, target, [{ pointMm: [2050.607, 29.393, 50], axis: [0, 0, -1] }], undefined, { diameterMm: 5, through: true }, 2.5);
}

async function caseR2B2(live: Live): Promise<void> {
  // q5 thin step: a 2 mm flange over a 12 mm stem; the axis 3.5 mm inside the stem wall.
  const flange = await make(live, "r2b2", "plasticity_create_box", { originMm: [2300, 0, 10], sizeMm: [40, 40, 2], name: "r2-thinstep" });
  const stem = await make(live, "r2b2", "plasticity_create_box", { originMm: [2300, 0, 0], sizeMm: [12, 40, 10] });
  const target = await union(live, flange, stem, "r2-thinstep");
  const source = await make(live, "r2b2", "plasticity_create_box", { originMm: [2300, 300, 0], sizeMm: [5, 5, 5], name: "r2-source" });
  const axis = [{ pointMm: [2308.5, 20, 30], axis: [0, 0, -1] }];
  await live.refusedUnchanged("r2b2", "countersink Ø12 head, the cone leaves the 2 mm flange", "plasticity_transfer_holes", { sourceId: source, targetId: target, axesMm: axis, hole: { diameterMm: 4, through: true, countersunk: { headDiameterMm: 12 } } }, /the countersink cone (breaks out of a side wall|exits through an oblique face|crosses a curved face) of the target.*|the document is unchanged.*the countersink cone/);
  await live.refusedUnchanged("r2b2", "counterbore Ø12 x 4 through the 2 mm flange", "plasticity_transfer_holes", { sourceId: source, targetId: target, axesMm: axis, hole: { diameterMm: 4, through: true, counterbore: { diameterMm: 12, depthMm: 4 } } }, /counterbore depth 4 reaches the far side of the wall/);
  live.check("r2b2", "no cone or Ø4 bore left on the thin step", (await live.faces({ bodyIds: [target], surfaceTypes: ["Cone"] })).length === 0 && (await cylindersOf(live, target, 2)).length === 0);
}

async function caseR2T(live: Live): Promise<void> {
  // 12 axes: a flat plate with a 2 x 6 grid of Ø3.4 holes over a plate.
  const holes = (await live.mutate("r2t", "plasticity_create_bracket", { originMm: [2000, 0, 6], profile: "flat", widthMm: 40, thicknessMm: 4, legs: { lengthMm: 120 }, holes: [{ leg: "flat", diameterMm: 3.4, count: 12, layout: "grid", marginMm: 8 }], name: "r2-grid" })).result;
  const plate = await make(live, "r2t", "plasticity_create_box", { originMm: [1990, -10, 0], sizeMm: [140, 60, 6], name: "r2-plate" });
  const transfer = await live.mutate("r2t", "plasticity_transfer_holes", { sourceId: holes.bodyId, targetId: plate, select: { radiusMm: 1.7, axis: "z" }, hole: { diameterMm: 3.4, through: true } });
  const probe = transfer.result.probe;
  live.evidence.r2t = { axes: transfer.result.axisCount, probe, clientMs: transfer.ms, serverMs: transfer.result.timing?.totalMs, perAxisMs: Math.round((probe.ms / transfer.result.axisCount) * 100) / 100 };
  live.check("r2t", `12-axis transfer: the ray probe took ${probe.ms} ms (${probe.rays} rays, ${probe.calls} calls; ${Math.round((probe.ms / 12) * 100) / 100} ms per axis), ${transfer.ms} ms round trip; 12 holes`, transfer.result.axisCount === 12 && transfer.result.holeCount === 12 && probe.ms < 2000, live.evidence.r2t);
}

// ---------- final review T1: the clearance ring, 16 rays above Ø10, the blind-floor rule ----------

async function caseT1(live: Live): Promise<void> {
  const source = await make(live, "t1", "plasticity_create_box", { originMm: [2000, 300, 0], sizeMm: [5, 5, 5], name: "t1-source" });
  const down: Vec = [0, 0, -1];
  const transfer = (targetId: number, pointMm: Vec, axis: Vec, hole: Record<string, unknown>) => ({ sourceId: source, targetId, axesMm: [{ pointMm, axis }], hole });
  const thin = /axis 0 \(point [^)]*\): the hole leaves a wall thinner than 0\.05 mm beside the bore: the ray at radius [\d.]+ mm, [\d.]+ degrees \(0\.05 mm outside the bore\)/;

  // 1: a Ø1 cross hole along x, 0.7 mm off the axis of a Ø4 bore: it lies between the planning rays. Blind 9.48 leaves
  // 0.02 mm over it (floor z 10.52, cross hole top z 10.5): the floor rays find it after the cut and the cut is undone.
  const block = await make(live, "t1", "plasticity_create_box", { originMm: [2100, 0, 0], sizeMm: [40, 40, 20], name: "t1-crossed" });
  const rod = await make(live, "t1", "plasticity_create_cylinder", { centerMm: [2090, 20.7, 10], radiusMm: 0.5, heightMm: 60, axis: [1, 0, 0] });
  const crossed = await difference(live, "t1", block, rod, "t1-crossed");
  await live.refusedUnchanged("t1", "input 1: Ø4 blind 9.48, a 0.02 mm membrane over a Ø1 cross hole between the rays: rolled back", "plasticity_transfer_holes", transfer(crossed, [2120, 20, 50], down, { diameterMm: 4, depthMm: 9.48 }),
    /2 Undo step\(s\) were undone and the document is unchanged[\s\S]*axis 0: the blind hole leaves a membrane thinner than 0\.05 mm under its floor: face \S+ \(Cylinder\) lies 0\.02\d+ mm behind the floor/);
  live.check("t1", "input 1: no Ø4 bore left on the block", (await cylindersOf(live, crossed, 2)).length === 0);
  await cutAndMeasure(live, "t1", "control: Ø4 blind 9.4 (0.1 mm stays over the cross hole)", source, crossed, [{ pointMm: [2120, 20, 50], axis: down }], undefined, { diameterMm: 4, depthMm: 9.4 }, 2);

  // 2a: a bore 0.002 mm (and 0.04 mm) beside a pocket wall; 0.06 mm away it is cut.
  const pocketBlock = await make(live, "t1", "plasticity_create_box", { originMm: [2000, 0, 0], sizeMm: [60, 40, 15], name: "t1-pocketed" });
  const pocketTool = await make(live, "t1", "plasticity_create_box", { originMm: [2010, 8, 5], sizeMm: [40, 24, 20] });
  const pocketed = await difference(live, "t1", pocketBlock, pocketTool, "t1-pocketed");
  for (const gap of [0.002, 0.04]) await live.refusedUnchanged("t1", `input 2: Ø3 through, rim ${gap} mm from the pocket wall`, "plasticity_transfer_holes", transfer(pocketed, [2011.5 + gap, 20, 50], down, { diameterMm: 3, through: true }), thin);
  live.check("t1", "input 2: no Ø3 bore left on the pocketed block", (await cylindersOf(live, pocketed, 1.5)).length === 0);
  await cutAndMeasure(live, "t1", "control: Ø3 through, rim 0.06 mm from the pocket wall", source, pocketed, [{ pointMm: [2011.56, 20, 50], axis: down }], undefined, { diameterMm: 3, through: true }, 1.5);

  // 2b: a bore 0.002 mm beside an internal void; 1 mm beside it is cut.
  const voidBlock = await make(live, "t1", "plasticity_create_box", { originMm: [2200, 0, 0], sizeMm: [40, 40, 20], name: "t1-voided" });
  const voidTool = await make(live, "t1", "plasticity_create_box", { originMm: [2215, 15, 7], sizeMm: [10, 10, 6] });
  const voided = await difference(live, "t1", voidBlock, voidTool, "t1-voided");
  await live.refusedUnchanged("t1", "input 2: Ø4 through 0.002 mm beside an internal void", "plasticity_transfer_holes", transfer(voided, [2212.998, 20, 60], down, { diameterMm: 4, through: true }), thin);
  live.check("t1", "input 2: no Ø4 bore left on the voided block", (await cylindersOf(live, voided, 2)).length === 0);
  await cutAndMeasure(live, "t1", "control: Ø4 through 1 mm beside the void", source, voided, [{ pointMm: [2212, 20, 60], axis: down }], undefined, { diameterMm: 4, through: true }, 2);

  // 3: Ø0.99 up the middle of a 1 mm wall between two pockets (0.005 mm left on each side); Ø0.8 (0.1 mm left) is cut.
  const twinBlock = await make(live, "t1", "plasticity_create_box", { originMm: [2300, 0, 0], sizeMm: [60, 40, 15], name: "t1-twin" });
  let twin = await difference(live, "t1", twinBlock, await make(live, "t1", "plasticity_create_box", { originMm: [2305, 5, 5], sizeMm: [24.5, 30, 20] }), "t1-twin");
  twin = await difference(live, "t1", twin, await make(live, "t1", "plasticity_create_box", { originMm: [2330.5, 5, 5], sizeMm: [24.5, 30, 20] }), "t1-twin");
  await live.refusedUnchanged("t1", "input 3: Ø0.99 from below up the 1 mm wall", "plasticity_transfer_holes", transfer(twin, [2330, 20, -30], [0, 0, 1], { diameterMm: 0.99, through: true }), thin);
  live.check("t1", "input 3: no Ø0.99 bore left on the twin-pocket block", (await cylindersOf(live, twin, 0.495)).length === 0);
  await cutAndMeasure(live, "t1", "control: Ø0.8 up the 1 mm wall (0.1 mm left on each side)", source, twin, [{ pointMm: [2330, 20, -30], axis: [0, 0, 1] }], undefined, { diameterMm: 0.8, through: true }, 0.4);

  // Guard 2: 8 rays per ring up to Ø10, 16 above it (two sides x (the axis + the bore ring + the clearance ring)).
  const plate = await make(live, "t1", "plasticity_create_box", { originMm: [2400, 0, 0], sizeMm: [60, 60, 6], name: "t1-plate" });
  const rays: Record<string, unknown> = {};
  for (const [diameterMm, expected] of [[10, 34], [12, 66]] as const) {
    const before = (await live.status()).undoDepth;
    const cut = await live.mutate("t1", "plasticity_transfer_holes", transfer(plate, [2430, 30, 50], down, { diameterMm, through: true }));
    rays[`Ø${diameterMm}`] = cut.result.probe;
    live.check("t1", `Ø${diameterMm} through: ${cut.result.probe.rays} probe rays (${expected} expected), ${cut.result.probe.ms} ms`, cut.result.probe.rays === expected, cut.result.probe);
    await live.undoTo(before);
  }
  const blind = await live.mutate("t1", "plasticity_transfer_holes", transfer(plate, [2430, 30, 50], down, { diameterMm: 4, depthMm: 3 }));
  live.check("t1", `Ø4 blind 3: ${blind.result.floorProbe?.rays} floor rays after the cut (9 expected), ${blind.result.floorProbe?.ms} ms`, blind.result.floorProbe?.rays === 9 && blind.result.floorProbe?.calls === 1, blind.result.floorProbe);
  live.evidence.t1 = { rays, floorProbe: blind.result.floorProbe };
}

// ---------- final review T2: the wall beside the bore at any angle (the exact clearance check) ----------

async function caseT2(live: Live): Promise<void> {
  const source = await make(live, "t2", "plasticity_create_box", { originMm: [2600, 300, 0], sizeMm: [5, 5, 5], name: "t2-source" });
  const down: Vec = [0, 0, -1];
  const transfer = (targetId: number, pointMm: Vec, hole: Record<string, unknown>) => ({ sourceId: source, targetId, axesMm: [{ pointMm, axis: down }], hole });
  // Either guard may speak first (a ray of the ring where the wall lies on one, the kernel's distance where it lies between
  // two); both refuse before the edit, so the document has no Undo step to take back.
  const thin = /axis 0 \(point [^)]*\): the hole leaves a wall thinner than 0\.05 mm beside the bore: (the ray at radius [\d.]+ mm, [\d.]+ degrees|target face \S+ \((Cylinder|Plane)\) lies 0\.0\d+ mm from the cut surface)/;
  const unit = (degrees: number): [number, number] => [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)];
  const said: Record<string, string> = {};

  // 1: a Ø4 through hole beside a Ø6 hole; the wall between them is 0.002, 0.01 and 0.04 mm, and the line of centres
  // lies at 0, 10, 22.5, 45, 67.5 and 90 degrees to the ring's first ray (18 inputs).
  const block = await make(live, "t2", "plasticity_create_box", { originMm: [2600, 0, 0], sizeMm: [40, 40, 20], name: "t2-holed" });
  const rod = await make(live, "t2", "plasticity_create_cylinder", { centerMm: [2620, 20, -1], radiusMm: 3, heightMm: 22 });
  const holed = await difference(live, "t2", block, rod, "t2-holed");
  for (const gap of [0.002, 0.01, 0.04]) for (const degrees of [0, 10, 22.5, 45, 67.5, 90]) {
    const [x, y] = unit(degrees);
    const distance = 3 + 2 + gap;
    const message = await live.refusedUnchanged("t2", `Ø4 through, a ${gap} mm wall to a Ø6 hole, line of centres at ${degrees} degrees`, "plasticity_transfer_holes", transfer(holed, [2620 + distance * x, 20 + distance * y, 60], { diameterMm: 4, through: true }), thin);
    said[`hole ${gap} mm at ${degrees} deg`] = /the ray at radius/.test(message) ? "ray" : "kernel distance";
  }
  live.check("t2", "no Ø4 bore left on the holed block", (await cylindersOf(live, holed, 2)).length === 0);
  for (const wall of [1, 0.06]) { const [x, y] = unit(22.5);
    await cutAndMeasure(live, "t2", `control: Ø4 through, a ${wall} mm wall to the Ø6 hole at 22.5 degrees`, source, holed, [{ pointMm: [2620 + (5 + wall) * x, 20 + (5 + wall) * y, 60], axis: down }], undefined, { diameterMm: 4, through: true }, 2); }

  // 1b: the wall of a counterbore (Ø6 x 2 on a Ø3 through hole) 0.01 mm from the Ø6 hole, on a ray of the head's ring
  // and between two of them. The head's own ring saw it only at 0 and 45 degrees.
  const headThin = /axis 0 \(point [^)]*\): the hole leaves a wall thinner than 0\.05 mm beside the bore's head: (the ray at radius [\d.]+ mm, [\d.]+ degrees|target face \S+ \(Cylinder\) lies 0\.0\d+ mm from the cut surface)/;
  const counterbored = { diameterMm: 3, through: true, counterbore: { diameterMm: 6, depthMm: 2 } };
  for (const degrees of [0, 22.5, 45]) {
    const [x, y] = unit(degrees);
    const message = await live.refusedUnchanged("t2", `counterbore Ø6 x 2, its wall 0.01 mm from the Ø6 hole, line of centres at ${degrees} degrees`, "plasticity_transfer_holes", transfer(holed, [2620 + 6.01 * x, 20 + 6.01 * y, 60], counterbored), headThin);
    said[`counterbore 0.01 mm at ${degrees} deg`] = /the ray at radius/.test(message) ? "ray" : "kernel distance";
  }
  live.check("t2", "no Ø3 bore left on the holed block", (await cylindersOf(live, holed, 1.5)).length === 0);
  for (const wall of [1, 0.06]) { const [x, y] = unit(22.5);
    await cutAndMeasure(live, "t2", `control: counterbore Ø6 x 2, its wall ${wall} mm from the Ø6 hole at 22.5 degrees`, source, holed, [{ pointMm: [2620 + (6 + wall) * x, 20 + (6 + wall) * y, 60], axis: down }], undefined, counterbored, 1.5); }

  // 2: the pocketed block of T1, turned 22.5 degrees about z; the rim of a Ø3 through hole 0.002, 0.01 and 0.04 mm from
  // the pocket wall (3 inputs). The wall now lies between two rays of the ring.
  const pocketBlock = await make(live, "t2", "plasticity_create_box", { originMm: [2700, 0, 0], sizeMm: [60, 40, 15], name: "t2-pocketed" });
  const pocketTool = await make(live, "t2", "plasticity_create_box", { originMm: [2710, 8, 5], sizeMm: [40, 24, 20] });
  const pocketed = await difference(live, "t2", pocketBlock, pocketTool, "t2-pocketed");
  await live.mutate("t2", "plasticity_rotate", { ids: [pocketed], pivotMm: [2710, 20, 0], axis: [0, 0, 1], degrees: 22.5 });
  const [nx, ny] = unit(22.5);
  for (const gap of [0.002, 0.01, 0.04]) {
    const message = await live.refusedUnchanged("t2", `pocket turned 22.5 degrees: Ø3 through, rim ${gap} mm from the pocket wall`, "plasticity_transfer_holes", transfer(pocketed, [2710 + nx * (1.5 + gap), 20 + ny * (1.5 + gap), 60], { diameterMm: 3, through: true }), thin);
    said[`pocket ${gap} mm`] = /the ray at radius/.test(message) ? "ray" : "kernel distance";
  }
  live.check("t2", "no Ø3 bore left on the turned pocketed block", (await cylindersOf(live, pocketed, 1.5)).length === 0);
  for (const wall of [1, 0.06]) await cutAndMeasure(live, "t2", `control: pocket turned 22.5 degrees, rim ${wall} mm from the wall`, source, pocketed, [{ pointMm: [2710 + nx * (1.5 + wall), 20 + ny * (1.5 + wall), 60], axis: down }], undefined, { diameterMm: 3, through: true }, 1.5);

  // 3: what the check costs. One axis beside a wall (the costly case: the search has to prove 0.06 mm) and 12 axes in a
  // plate (the common case: nothing near, one read per axis).
  const near = await live.mutate("t2", "plasticity_transfer_holes", transfer(holed, [2620 + 5.06 * unit(22.5)[0], 20 + 5.06 * unit(22.5)[1], 60], { diameterMm: 4, through: true }));
  await live.undoTo((await live.status()).undoDepth - (near.result.undoSteps ?? 1));
  const plate = await make(live, "t2", "plasticity_create_box", { originMm: [2800, 0, 0], sizeMm: [60, 40, 6], name: "t2-plate" });
  const twelve = await live.mutate("t2", "plasticity_transfer_holes", { sourceId: source, targetId: plate, axesMm: Array.from({ length: 12 }, (_, index) => ({ pointMm: [2806 + 9 * (index % 6), 10 + 20 * Math.floor(index / 6), 60], axis: down })), hole: { diameterMm: 3.2, through: true } });
  const clearance = twelve.result.clearance;
  await live.undoTo((await live.status()).undoDepth - twelve.result.undoSteps);
  // The worst 12: every rim 0.06 mm from the plate's edge face, so every axis pays for the full search.
  const edged = await live.mutate("t2", "plasticity_transfer_holes", { sourceId: source, targetId: plate, axesMm: Array.from({ length: 12 }, (_, index) => ({ pointMm: [2805 + 4.5 * index, 1.56, 60], axis: down })), hole: { diameterMm: 3, through: true } });
  live.evidence.t2 = { firstToRefuse: said, nearWall: { clearance: near.result.clearance, clientMs: near.ms }, twelveAxes: { clearance, probe: twelve.result.probe, clientMs: twelve.ms, serverMs: twelve.result.timing?.totalMs },
    twelveAxesNearAnEdge: { clearance: edged.result.clearance, probe: edged.result.probe, clientMs: edged.ms, serverMs: edged.result.timing?.totalMs } };
  live.check("t2", `12-axis transfer, every rim 0.06 mm from the plate edge: the clearance check read ${edged.result.clearance?.points} point(s) in ${edged.result.clearance?.calls} call(s), ${edged.result.clearance?.ms} ms (${Math.round(((edged.result.clearance?.ms ?? 0) / 12) * 100) / 100} ms per axis); ${edged.ms} ms round trip; 12 holes`,
    edged.result.axisCount === 12 && edged.result.holeCount === 12 && typeof edged.result.clearance?.ms === "number" && edged.result.clearance.ms < 500 && edged.ms < 1500, { clearance: edged.result.clearance, ms: edged.ms });
  live.check("t2", `a 0.06 mm wall: the clearance check read ${near.result.clearance?.points} point(s) in ${near.result.clearance?.calls} call(s), ${near.result.clearance?.ms} ms`, typeof near.result.clearance?.ms === "number" && near.result.clearance.ms < 250, near.result.clearance);
  live.check("t2", `12-axis transfer: the clearance check read ${clearance?.points} point(s) in ${clearance?.calls} call(s), ${clearance?.ms} ms (${Math.round(((clearance?.ms ?? 0) / 12) * 100) / 100} ms per axis); ${twelve.ms} ms round trip; 12 holes`,
    twelve.result.axisCount === 12 && twelve.result.holeCount === 12 && typeof clearance?.ms === "number" && clearance.ms < 250 && twelve.ms < 1500, { clearance, ms: twelve.ms });
}

async function main(): Promise<void> {
  const options = parseBracketMateArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const endpoint = process.env.PLASTICITY_CDP_URL;
  if (!endpoint) throw new Error("PLASTICITY_CDP_URL is required (an isolated instance, e.g. from npm run start:plasticity-isolated); refusing to create anything");
  const host = new URL(endpoint).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") throw new Error(`PLASTICITY_CDP_URL must be loopback, not ${host}`);
  const output = resolve(options.output!);
  await mkdir(output, { recursive: false, mode: 0o700 });
  const client = await startMcp(join(output, "store"));
  const live = new Live(client);
  live.evidence.startedAt = new Date().toISOString();
  live.evidence.endpoint = endpoint;
  live.evidence.targetId = options.target;
  try {
    const windows = await live.call("plasticity_list_windows", {});
    if (!windows.some((window: { targetId: string }) => window.targetId === options.target)) throw new Error("The explicit Plasticity target was not found");
    await live.call("plasticity_connect", { targetId: options.target });
    const status = await live.status();
    live.baseline = { undoDepth: status.undoDepth, bodyIds: status.bodies.map((body: { id: number }) => body.id).sort((a: number, b: number) => a - b), revision: status.revision };
    live.evidence.baseline = live.baseline;
    for (const name of options.cases) {
      try {
        if (name === "1") await case1(live);
        if (name === "2") await case2(live);
        if (name === "3") await case3(live);
        if (name === "4") await case4(live);
        const review: Record<string, (live: Live) => Promise<void>> = { d1: caseD1, d2: caseD2, d3: caseD3, d45: caseD45, d6: caseD6, d7: caseD7, d8: caseD8, d9: caseD9, d10: caseD10, d11: caseD11, r2b1: caseR2B1, r2b2: caseR2B2, r2t: caseR2T, t1: caseT1, t2: caseT2 };
        if (review[name]) await review[name]!(live);
      } catch (error) {
        live.check(name, "case ran to the end", false, error instanceof Error ? error.message.slice(0, 2000) : String(error));
      } finally {
        await live.restore(name);
      }
    }
  } finally {
    try { await live.restore("final"); } catch (error) { live.check("final", "final restore", false, String(error)); }
    try {
      const end = await live.status();
      live.evidence.end = { undoDepth: end.undoDepth, bodies: end.bodies.length, bodyIds: end.bodies.map((body: { id: number }) => body.id).sort((a: number, b: number) => a - b) };
    } catch (error) { live.evidence.end = { error: String(error) }; }
    live.evidence.checks = live.checks;
    live.evidence.finishedAt = new Date().toISOString();
    await writeFile(join(output, "evidence.json"), `${JSON.stringify(live.evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await client.close();
  }
  const failed = live.checks.filter((check) => !check.ok);
  for (const check of live.checks) console.log(`${check.ok ? "PASS" : "FAIL"}  [${check.case}] ${check.check}`);
  console.log(`\n${live.checks.length - failed.length}/${live.checks.length} checks passed; evidence: ${join(output, "evidence.json")}`);
  const end = live.evidence.end as { undoDepth?: number; bodies?: number; bodyIds?: number[] } | undefined;
  const restored = !!end && end.undoDepth === live.baseline?.undoDepth && JSON.stringify(end.bodyIds) === JSON.stringify(live.baseline?.bodyIds);
  console.log(`baseline ${restored ? "restored" : "NOT restored"}: Undo depth ${end?.undoDepth}, ${end?.bodies} bodies (start: Undo depth ${live.baseline?.undoDepth}, ${live.baseline?.bodyIds.length} bodies)`);
  if (failed.length > 0 || !restored) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
