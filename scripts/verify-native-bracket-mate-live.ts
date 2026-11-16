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
const CASES = ["1", "2", "3", "4", "d1", "d2", "d3", "d45", "d6", "d7", "d8", "d9", "d10", "d11"] as const;
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
defect (d45 is defects 4 and 5). Builds at x >= ${X0} mm in an isolated instance, restores the Undo depth and body list
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
  const env = { ...isolatedAcceptanceEnvironment(storeRoot, process.env), PLASTICITY_AUTO_LAUNCH: "0", PLASTICITY_HUD: "0", PLASTICITY_TIMING: "1" };
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
    await live.refusedUnchanged("d2", `${label}: side breakout`, "plasticity_transfer_holes", { sourceId: source, targetId: step, axesMm: [{ pointMm: [x, 20, 30], axis: [0, 0, -1] }], hole: { diameterMm: 5, through: true } }, /the document is unchanged.*axis 0: the bore breaks out of a side wall of the target/);
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
        const review: Record<string, (live: Live) => Promise<void>> = { d1: caseD1, d2: caseD2, d3: caseD3, d45: caseD45, d6: caseD6, d7: caseD7, d8: caseD8, d9: caseD9, d10: caseD10, d11: caseD11 };
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
