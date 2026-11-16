#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface PatchPolysplinesFacepointsOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parsePatchPolysplinesFacepointsArgs(argv: string[]): PatchPolysplinesFacepointsOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: PatchPolysplinesFacepointsOptions = { help: false, allowDisposableMutations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--target") {
      const value = argv[++index];
      if (!value) throw new Error("--target requires an explicit Plasticity window ID");
      options.target = value;
    } else if (argument === "--output") {
      const value = argv[++index];
      if (!value) throw new Error("--output requires a new directory path");
      options.output = value;
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live patch/polysplines/face-points acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live patch/polysplines/face-points acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live patch/polysplines/face-points acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-patch-polysplines-facepoints-live.ts --help
  node scripts/verify-native-patch-polysplines-facepoints-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode takes a baseline, then builds disposable geometry at x >= 2300 mm and checks, by reading
type, topology counts, bounds and control points back through plasticity_status and the tool results:
  - plasticity_xsided_patch: 4, 3 and 5 boundary curves, an open cylinder edge with g0 and g1, and a guide curve.
  - plasticity_convert_reference_mesh_to_polysplines: a 10 mm quad cube OBJ written to the output directory.
  - plasticity_show_face_control_points and plasticity_move_face_control_points on an extruded arc Sheet.
It undoes back to the baseline Undo depth, body count and reference-mesh count and never saves the document.
Run it only against an isolated Plasticity instance.`;

async function main(): Promise<void> {
  const options = parsePatchPolysplinesFacepointsArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target! };
  let live: LiveMcp | undefined;
  let baseline: any;
  try {
    live = await startMcp();
    const client = live.client;
    const windows = await call(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    await call(client, "plasticity_connect", { targetId: options.target });
    baseline = await status(client);
    evidence.baseline = summary(baseline);
    const baselineMeshes = (await call(client, "plasticity_list_reference_meshes", {})).referenceMeshes.length;
    const known = new Set<number>(baseline.bodies.map((body: { id: number }) => body.id));
    const checks: Record<string, unknown> = {};

    const mutate = async (tool: string, args: Record<string, unknown>): Promise<any> => {
      const before = await status(client);
      await call(client, tool, { ...args, revision: before.revision });
      return await status(client);
    };
    // Adds geometry with one tool call and returns the bodies that appeared.
    const add = async (tool: string, args: Record<string, unknown>): Promise<any[]> => {
      const before = await status(client);
      await mutate(tool, args);
      const after = await status(client);
      const added = after.bodies.filter((body: { id: number }) => !known.has(body.id) && !before.bodies.some((old: { id: number }) => old.id === body.id));
      for (const body of added) known.add(body.id);
      return added;
    };
    const undoTo = async (depth: number): Promise<void> => {
      for (let count = 0; count < 40; count += 1) {
        const current = await status(client);
        if (current.undoDepth <= depth) return;
        await call(client, "plasticity_undo", { intent: "Return to the acceptance checkpoint", revision: current.revision });
      }
      throw new Error(`Undo did not reach the checkpoint ${depth}; depth is ${(await status(client)).undoDepth}`);
    };
    const rejects = async (tool: string, args: Record<string, unknown>, pattern: RegExp, label: string): Promise<void> => {
      const before = await status(client);
      let message = "";
      try { await call(client, tool, { revision: before.revision, ...args }); } catch (error) { message = error instanceof Error ? error.message : String(error); }
      requireCondition(pattern.test(message), `${label}: expected rejection ${String(pattern)}, got "${message.slice(0, 200)}"`);
      const after = await status(client);
      requireCondition(after.undoDepth === before.undoDepth, `${label}: a rejected call changed the Undo history`);
    };
    const polyline = async (a: number[], b: number[]) => (await add("plasticity_create_polyline", { pointsMm: [a, b], closed: false }))[0];

    // ---- plasticity_xsided_patch (FINDINGS gaps 2 and 6)
    // Runs one patch, checks the new body by type and topology counts, then undoes the patch.
    const patchCheckpoint = async () => (await status(client)).undoDepth;
    const patchVariant = async (label: string, args: Record<string, unknown>, faces: number, edges: number, vertices: number): Promise<any> => {
      const checkpoint = await patchCheckpoint();
      const before = await status(client);
      const current = await mutate("plasticity_xsided_patch", args);
      const created = current.bodies.filter((body: any) => !before.bodies.some((old: any) => old.id === body.id));
      requireCondition(created.length === 1 && created[0].type === "Sheet", `${label}: expected one new Sheet, got ${created.map((body: any) => body.type).join(",")}`);
      const sheet = created[0];
      const counts = { type: sheet.type, faces: sheet.faceCount, edges: sheet.edgeCount, vertices: sheet.vertexCount, boundsMm: sheet.boundsMm };
      checks[`xsided_${label}`] = counts;
      requireCondition(counts.faces === faces && counts.edges === edges && counts.vertices === vertices, `${label}: expected ${faces}F/${edges}E/${vertices}V, got ${counts.faces}F/${counts.edges}E/${counts.vertices}V`);
      requireCondition(current.undoDepth === checkpoint + 1, `${label}: the patch must add exactly one Undo entry`);
      requireCondition(before.bodies.every((old: any) => current.bodies.some((body: any) => body.id === old.id)), `${label}: a source body disappeared`);
      await undoTo(checkpoint);
      return counts;
    };

    const quadPoints = [[2300, 0, 0], [2340, 0, 10], [2340, 40, 0], [2300, 40, 10]];
    const quad: any[] = [];
    for (let index = 0; index < 4; index += 1) quad.push(await polyline(quadPoints[index]!, quadPoints[(index + 1) % 4]!));
    await patchVariant("quad_4_curves", { curveIds: quad.map((curve) => curve.id) }, 1, 4, 4);

    const triPoints = [[2300, 100, 0], [2340, 100, 0], [2320, 135, 0]];
    const mid = (a: number[], b: number[]) => a.map((value, axis) => (value + b[axis]!) / 2 + (axis === 2 ? 8 : 0));
    const tri: any[] = [];
    for (let index = 0; index < 3; index += 1) {
      tri.push((await add("plasticity_create_nurbs_curve", { pointsMm: [triPoints[index], mid(triPoints[index]!, triPoints[(index + 1) % 3]!), triPoints[(index + 1) % 3]] }))[0]);
    }
    await patchVariant("triangle_3_curves", { curveIds: tri.map((curve) => curve.id) }, 1, 3, 3);

    const pentPoints = [0, 1, 2, 3, 4].map((k) => [2320 + 20 * Math.cos((2 * Math.PI * k) / 5), 220 + 20 * Math.sin((2 * Math.PI * k) / 5), k % 2 ? 4 : 0]);
    const pent: any[] = [];
    for (let index = 0; index < 5; index += 1) pent.push(await polyline(pentPoints[index]!, pentPoints[(index + 1) % 5]!));
    await patchVariant("pentagon_5_curves", { curveIds: pent.map((curve) => curve.id) }, 1, 5, 5);

    // Open cylinder: delete the top cap, then patch the top circle edge with g0 and g1.
    const [cylinder] = await add("plasticity_create_cylinder", { centerMm: [2400, 0, 0], radiusMm: 10, heightMm: 20 });
    const cylinderInfo = await call(client, "plasticity_body_info", { id: cylinder.id });
    const topFace = (cylinderInfo.body.faces as any[]).find((face) => face.normal?.[2] > 0.999 && Math.abs((face.centerMm ?? face.centroidMm ?? face.center)?.[2] - 20) < 0.01);
    requireCondition(topFace, "The cylinder top face was not found");
    const afterDelete = await mutate("plasticity_delete_faces", { faces: [{ bodyId: cylinder.id, faceId: topFace.id }] });
    const openSheet = afterDelete.bodies.find((body: any) => body.type === "Sheet" && body.boundsMm && body.boundsMm.min[0] > 2380 && body.boundsMm.max[0] < 2420);
    requireCondition(openSheet, "The open cylinder Sheet was not found after deleting the top face");
    known.add(openSheet.id);
    const sheetInfo = await call(client, "plasticity_body_info", { id: openSheet.id });
    const rim = (sheetInfo.body.edges as any[]).find((edge) => edge.faceIds.length === 1);
    requireCondition(rim, "The open rim edge of the cylinder Sheet was not found");
    const edgeArgs = { edges: { bodyId: openSheet.id, edgeIds: [rim.id] } };
    const g0 = await patchVariant("cylinder_edge_g0", edgeArgs, 1, 1, 1);
    const g0Default = await patchVariant("cylinder_edge_default", { ...edgeArgs, continuity: "g0" }, 1, 1, 1);
    const g1 = await patchVariant("cylinder_edge_g1", { ...edgeArgs, continuity: "g1" }, 1, 1, 1);
    const g2 = await patchVariant("cylinder_edge_g2", { ...edgeArgs, continuity: "g2" }, 1, 1, 1);
    const zRange = (entry: any) => entry.boundsMm.max[2] - entry.boundsMm.min[2];
    requireCondition(zRange(g0) < 0.1 && zRange(g0Default) < 0.1, `g0 must stay flat, z range ${zRange(g0)}`);
    requireCondition(zRange(g1) > 3, `g1 must bulge off the rim, z range ${zRange(g1)}`);
    requireCondition(zRange(g2) > 3, `g2 must bulge off the rim, z range ${zRange(g2)}`);
    checks.xsided_continuity_z_range = { g0: zRange(g0), g1: zRange(g1), g2: zRange(g2) };

    // Interior guide: the same quad gets a guide curve that pulls the surface up.
    const guideQuadPoints = [[3000, 0, 0], [3040, 0, 10], [3040, 40, 0], [3000, 40, 10]];
    const guideQuad: any[] = [];
    for (let index = 0; index < 4; index += 1) guideQuad.push(await polyline(guideQuadPoints[index]!, guideQuadPoints[(index + 1) % 4]!));
    const [guide] = await add("plasticity_create_nurbs_curve", { pointsMm: [[3000, 20, 5], [3020, 20, 20], [3040, 20, 5]] });
    const plainPatch = await patchVariant("guide_quad_no_guide", { curveIds: guideQuad.map((curve) => curve.id) }, 1, 4, 4);
    const guided = await patchVariant("guide_quad_with_guide", { curveIds: guideQuad.map((curve) => curve.id), guideIds: [guide.id] }, 1, 4, 4);
    requireCondition(guided.boundsMm.max[2] > plainPatch.boundsMm.max[2] + 5, `The guide must raise the patch: ${guided.boundsMm.max[2]} vs ${plainPatch.boundsMm.max[2]}`);

    const rejectCheckpoint = (await status(client)).undoDepth;
    await rejects("plasticity_xsided_patch", { curveIds: quad.map((curve) => curve.id), edges: edgeArgs.edges }, /exactly one/i, "curveIds and edges together");
    await rejects("plasticity_xsided_patch", {}, /exactly one/i, "neither curveIds nor edges");
    await rejects("plasticity_xsided_patch", { guideIds: [guide.id] }, /exactly one|boundary/i, "a guide without a boundary");
    await rejects("plasticity_xsided_patch", { curveIds: quad.map((curve) => curve.id), continuity: "g1" }, /edges/i, "continuity with curves");
    await rejects("plasticity_xsided_patch", { curveIds: [quad[0].id, quad[1].id] }, /3|least/i, "two curves");
    requireCondition((await status(client)).undoDepth === rejectCheckpoint, "The patch checks left Undo entries behind");

    // ---- plasticity_convert_reference_mesh_to_polysplines (FINDINGS gap 7)
    const cubeObj = join(output, "quad-cube.obj");
    await writeFile(cubeObj, cubeObjText(3100), { flag: "wx", mode: 0o600 });
    const polyCheckpoint = (await status(client)).undoDepth;
    await mutate("plasticity_import_reference_mesh", { path: cubeObj, sourceUnit: "millimeter" });
    const meshes = (await call(client, "plasticity_list_reference_meshes", {})).referenceMeshes as Array<{ id: number }>;
    requireCondition(meshes.length === baselineMeshes + 1, `Expected one imported reference mesh, got ${meshes.length - baselineMeshes}`);
    const mesh = meshes[meshes.length - 1]!;
    await rejects("plasticity_convert_reference_mesh_to_polysplines", { referenceMeshId: 987654 }, /reference mesh/i, "unknown reference mesh");
    const beforeConvert = await status(client);
    const converted = await mutate("plasticity_convert_reference_mesh_to_polysplines", { referenceMeshId: mesh.id });
    const solid = converted.bodies.find((body: any) => !beforeConvert.bodies.some((old: any) => old.id === body.id));
    requireCondition(solid && solid.type === "Solid", `PolySplines conversion must create a Solid, got ${solid?.type}`);
    requireCondition(solid.faceCount === 6 && solid.edgeCount === 12 && solid.vertexCount === 8, `PolySplines cube must be 6F/12E/8V, got ${solid.faceCount}F/${solid.edgeCount}E/${solid.vertexCount}V`);
    for (let axis = 0; axis < 3; axis += 1) {
      const low = axis === 0 ? 3100 : 0;
      const high = axis === 0 ? 3110 : 10;
      requireCondition(solid.boundsMm.min[axis] >= low - 0.001 && solid.boundsMm.max[axis] <= high + 0.001, `PolySplines bounds must stay inside the cube on axis ${axis}: ${solid.boundsMm.min[axis]}..${solid.boundsMm.max[axis]}`);
      requireCondition(solid.boundsMm.max[axis] - solid.boundsMm.min[axis] < 9.5, `PolySplines limit surface must shrink the cube on axis ${axis}`);
    }
    const meshesAfter = (await call(client, "plasticity_list_reference_meshes", {})).referenceMeshes as Array<{ id: number }>;
    requireCondition(meshesAfter.length === baselineMeshes && !meshesAfter.some((entry) => entry.id === mesh.id), "The reference mesh must be consumed by the conversion");
    checks.polysplines_cube = { type: solid.type, faces: solid.faceCount, edges: solid.edgeCount, vertices: solid.vertexCount, boundsMm: solid.boundsMm, referenceMeshesAfter: meshesAfter.length };
    await undoTo(polyCheckpoint);
    requireCondition((await call(client, "plasticity_list_reference_meshes", {})).referenceMeshes.length === baselineMeshes, "Undo did not restore the reference mesh count");

    // ---- plasticity_show_face_control_points and plasticity_move_face_control_points (FINDINGS gap 5)
    const [arch] = await add("plasticity_create_nurbs_curve", { pointsMm: [[2900, 0, 0], [2920, 0, 10], [2940, 0, 0]] });
    const archSheets = await add("plasticity_extrude_curves", { ids: [arch.id], distanceMm: 20, direction: [0, 1, 0] });
    const sheet = archSheets.find((body: any) => body.type === "Sheet");
    requireCondition(sheet, "The extruded arc Sheet was not created");
    requireNear(sheet.boundsMm.max[2], 13.333, "Sheet max z before the move", 0.01);
    const faceId = (await call(client, "plasticity_body_info", { id: sheet.id })).body.faces[0].id;
    const structure = await call(client, "plasticity_inspect_surface_structure", { faces: [{ bodyId: sheet.id, faceId }], revision: (await status(client)).revision });
    const bSpline = structure.surfaces[0].bSpline;
    const structureCount = bSpline.uControlPointCount * bSpline.vControlPointCount;
    const faceCheckpoint = (await status(client)).undoDepth;
    await rejects("plasticity_move_face_control_points", { bodyId: sheet.id, cvIds: [0], deltaMm: [0, 0, 1] }, /plasticity_show_face_control_points/, "move before show");
    const showRevision = (await status(client)).revision;
    const shown = await call(client, "plasticity_show_face_control_points", { bodyId: sheet.id, faceIds: [faceId], revision: showRevision });
    requireCondition((await status(client)).undoDepth === faceCheckpoint + 1, "Showing face control points must add exactly one Undo entry");
    const points = shown.controlPoints as Array<{ cvId: number; positionMm: [number, number, number] }>;
    requireCondition(points.length === 8 && points.length === structureCount, `Expected 8 control points matching the 4x2 structure (${structureCount}), got ${points.length}`);
    requireCondition(bSpline.uControlPointCount === 4 && bSpline.vControlPointCount === 2, `Surface structure must be 4x2, got ${bSpline.uControlPointCount}x${bSpline.vControlPointCount}`);
    const highest = Math.max(...points.map((point) => point.positionMm[2]));
    const topRow = points.filter((point) => point.positionMm[2] > highest - 0.01);
    requireCondition(topRow.length === 4, `Expected four control points at the top row z ${highest}, got ${topRow.length}`);
    const moveIds = [topRow[0]!.cvId];
    const moveRevision = (await status(client)).revision;
    const moved = await call(client, "plasticity_move_face_control_points", { bodyId: sheet.id, cvIds: moveIds, deltaMm: [0, 0, 10], revision: moveRevision });
    const after = await status(client);
    requireCondition(after.undoDepth === faceCheckpoint + 2, "Moving face control points must add exactly one Undo entry");
    const movedSheet = after.bodies.find((body: any) => body.id === sheet.id) ?? after.bodies.find((body: any) => body.type === "Sheet" && body.boundsMm.min[0] > 2890 && body.boundsMm.max[0] < 2950);
    requireCondition(movedSheet, "The moved Sheet was not found");
    requireNear(movedSheet.boundsMm.max[2], 15, "Sheet max z after moving the top control point 10 mm", 0.1);
    const movedPoints = moved.controlPoints as Array<{ cvId: number; positionMm: [number, number, number] }>;
    requireCondition(movedPoints.length === moveIds.length && movedPoints[0]!.cvId === moveIds[0], `The move must return the ${moveIds.length} moved point, got ${movedPoints.length}`);
    for (const point of movedPoints) {
      const original = points.find((candidate) => candidate.cvId === point.cvId)!;
      requireNear(point.positionMm[2] - original.positionMm[2], 10, `cv ${point.cvId} z delta`, 0.01);
      requireNear(point.positionMm[0], original.positionMm[0], `cv ${point.cvId} x`, 0.01);
      requireNear(point.positionMm[1], original.positionMm[1], `cv ${point.cvId} y`, 0.01);
    }
    checks.face_points = {
      structure: { u: bSpline.uControlPointCount, v: bSpline.vControlPointCount },
      shown: points.length,
      maxZBefore: sheet.boundsMm.max[2],
      maxZAfter: movedSheet.boundsMm.max[2],
      moved: movedPoints.map((point) => ({ cvId: point.cvId, deltaZ: point.positionMm[2] - points.find((candidate) => candidate.cvId === point.cvId)!.positionMm[2] })),
    };
    await rejects("plasticity_move_face_control_points", { bodyId: sheet.id, cvIds: [9999], deltaMm: [0, 0, 1] }, /plasticity_show_face_control_points/, "unknown cvId");
    const staleRevision = (await status(client)).revision;
    await mutate("plasticity_move_face_control_points", { bodyId: sheet.id, cvIds: [topRow[0]!.cvId], deltaMm: [0, 0, 1] });
    await rejects("plasticity_move_face_control_points", { bodyId: sheet.id, cvIds: [topRow[0]!.cvId], deltaMm: [0, 0, 1], revision: staleRevision }, /stale/i, "stale revision");
    await rejects("plasticity_show_face_control_points", { bodyId: sheet.id, faceIds: ["nope"] }, /face/i, "unknown face");

    // ---- restore the baseline
    await undoTo(baseline.undoDepth);
    const restored = await status(client);
    evidence.checks = checks;
    evidence.restored = summary(restored);
    requireCondition(restored.documentToken === baseline.documentToken, "The document changed during acceptance");
    requireCondition(restored.undoDepth === baseline.undoDepth, `Undo depth is ${restored.undoDepth}, baseline was ${baseline.undoDepth}`);
    requireCondition(restored.bodies.length === baseline.bodies.length, `Body count is ${restored.bodies.length}, baseline was ${baseline.bodies.length}`);
    requireCondition(JSON.stringify(restored.bodies.map((body: { id: number }) => body.id)) === JSON.stringify(baseline.bodies.map((body: { id: number }) => body.id)), "Undo did not restore the baseline bodies");
    requireCondition((await call(client, "plasticity_list_reference_meshes", {})).referenceMeshes.length === baselineMeshes, "Undo did not restore the baseline reference meshes");
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), evidence);
    console.log(JSON.stringify({ ok: true, output, baseline: evidence.baseline, restored: evidence.restored, checks }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    if (live && baseline) evidence.cleanup = await recover(live.client, baseline).catch((cleanupError) => ({ restored: false, reason: boundedError(cleanupError) }));
    await writeExclusive(join(output, "failure.json"), evidence).catch(() => {});
    throw error;
  } finally {
    await live?.client.close().catch(() => {});
  }
}

// A 10 mm quad cube with outward-facing quads, offset along x so it never touches the disposable test bodies.
function cubeObjText(x: number): string {
  const vertices = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
  const faces = [[1, 4, 3, 2], [5, 6, 7, 8], [1, 2, 6, 5], [3, 4, 8, 7], [1, 5, 8, 4], [2, 3, 7, 6]];
  return `${vertices.map(([vx, vy, vz]) => `v ${x + vx!} ${vy} ${vz}`).join("\n")}\n${faces.map((face) => `f ${face.join(" ")}`).join("\n")}\n`;
}

async function startMcp(): Promise<LiveMcp> {
  const endpoint = process.env.PLASTICITY_CDP_URL;
  if (!endpoint) throw new Error("PLASTICITY_CDP_URL must name the isolated Plasticity instance");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "scripts", "run-server.ts")],
    cwd: projectRoot,
    env: selectedEnvironment(process.env),
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-patch-polysplines-facepoints-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const text = toolText(response);
  if ("isError" in response && response.isError) throw new Error(text);
  return JSON.parse(text);
}

async function status(client: Client): Promise<any> {
  const state = await call(client, "plasticity_status", { bodyLimit: 200 });
  requireCondition(!state.bodyPagination?.nextOffset, "The acceptance document has more than 200 bodies");
  return state;
}

function toolText(response: unknown): string {
  if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content");
  const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string");
  if (!item) throw new Error("MCP tool returned no text content");
  return item.text;
}

async function recover(client: Client, initial: any): Promise<Record<string, unknown>> {
  for (let count = 0; count < 40; count += 1) {
    const current = await status(client);
    if (current.documentToken !== initial.documentToken) return { restored: false, reason: "document-changed" };
    if (current.undoDepth <= initial.undoDepth) return { restored: current.bodies.length === initial.bodies.length };
    await call(client, "plasticity_undo", { intent: "Recover patch/polysplines/face-points acceptance", revision: current.revision });
  }
  return { restored: false, reason: "undo-limit" };
}

function summary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length }; }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function requireNear(actual: number, expected: number, label: string, tolerance = 0.05): void {
  requireCondition(typeof actual === "number" && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} within ${tolerance}, got ${actual}`);
}
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL", "PLASTICITY_AUTO_LAUNCH", "PLASTICITY_HUD", "PLASTICITY_MCP_STATE_DIR", "PLASTICITY_CONSTRUCTION_HISTORY_ROOT"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
