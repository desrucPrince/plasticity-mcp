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
PLASTICITY_CDP_URL is mandatory: set it to the isolated Plasticity instance. The command never launches Plasticity
(it forces PLASTICITY_AUTO_LAUNCH=0 and PLASTICITY_HUD=0) and refuses to start without the variable.
Live mode takes a baseline, then builds disposable geometry at x >= 2300 mm and checks, by reading
type, topology counts, bounds and control points back through plasticity_status and the tool results:
  - plasticity_xsided_patch: 4, 3 and 5 boundary curves, an open cylinder edge with g0 and g1, and a guide curve.
  - plasticity_convert_reference_mesh_to_polysplines: a 10 mm quad cube OBJ written to the output directory.
    It also converts an open 3 x 3 quad grid (default, interpolateBoundary, mergePatches false) and a triangle cube.
  - plasticity_xsided_patch on Solid edges: a through-hole rim (default and g1) and a face loop with a guide.
  - plasticity_show_face_control_points and plasticity_move_face_control_points on an extruded arc Sheet.
  - a two-face Sheet: per-face show, renumbering, a free second show, a move across both faces, hide, a free
    second hide; Plane and Cylinder faces are refused before any edit; grid shapes and the renumbered flag.
  - a coincident point on the edge two faces share: moved alone it is reported (one Undo step, read-back
    fails and names the separation, the new revision and the undo / re-read / both-cvIds advice); moved together
    with its twin it succeeds; with the twin face's points hidden, the move names that face and says to show it
    first; a delta below the read-back resolution is refused before any edit.
  - a Sheet knife-split at its apex (two faces on one B-Surface): the show is refused before any edit.
It undoes back to the baseline Undo depth, body count and reference-mesh count and never saves the document.
Run it only against an isolated Plasticity instance.`;

async function main(): Promise<void> {
  const options = parsePatchPolysplinesFacepointsArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  if (!process.env.PLASTICITY_CDP_URL) throw new Error("PLASTICITY_CDP_URL is mandatory and must name the isolated Plasticity instance; nothing was created");
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target! };
  const serverStderr: string[] = [];
  let live: LiveMcp | undefined;
  let baseline: any;
  try {
    live = await startMcp(serverStderr);
    const client = live.client;
    const windows = await call(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    await call(client, "plasticity_connect", { targetId: options.target });
    const baselineState = await status(client);
    const baselineMeshes = (await call(client, "plasticity_list_reference_meshes", {})).referenceMeshes.length;
    // The reference-mesh count is part of the baseline before recover() can ever run.
    baseline = { ...baselineState, referenceMeshCount: baselineMeshes };
    evidence.baseline = { ...summary(baseline), referenceMeshCount: baselineMeshes };
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
      for (let count = 0; count < 200; count += 1) {
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
    const g0Default = await patchVariant("cylinder_edge_default", edgeArgs, 1, 1, 1);
    const g0 = await patchVariant("cylinder_edge_g0", { ...edgeArgs, continuity: "g0" }, 1, 1, 1);
    const g1 = await patchVariant("cylinder_edge_g1", { ...edgeArgs, continuity: "g1" }, 1, 1, 1);
    const g2 = await patchVariant("cylinder_edge_g2", { ...edgeArgs, continuity: "g2" }, 1, 1, 1);
    const zRange = (entry: any) => entry.boundsMm.max[2] - entry.boundsMm.min[2];
    requireCondition(zRange(g0) < 0.1 && zRange(g0Default) < 0.1, `g0 and the default must stay flat, z range ${zRange(g0)} and ${zRange(g0Default)}`);
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

    // Edges of a Solid: a through-hole rim (one circular edge, its two faces both on the Solid) and a box's top
    // face loop with an interior guide (guides work with edges too).
    const [plate] = await add("plasticity_create_box", { originMm: [3500, 0, 0], sizeMm: [30, 30, 5] });
    const [holeTool] = await add("plasticity_create_cylinder", { centerMm: [3515, 15, -1], radiusMm: 6, heightMm: 7 });
    await mutate("plasticity_boolean", { targetIds: [plate.id], toolIds: [holeTool.id], operation: "difference" });
    known.delete(holeTool.id);
    const plateInfo = await call(client, "plasticity_body_info", { id: plate.id });
    const holeRims = (plateInfo.body.edges as any[]).filter((edge) => edge.circle && Math.abs(edge.centerMm[2] - 5) < 0.01);
    requireCondition(holeRims.length === 1 && holeRims[0].faceIds.length === 2, `Expected one top hole rim with two faces, got ${holeRims.length}`);
    const holeFlat = await patchVariant("solid_hole_rim_default", { edges: { bodyId: plate.id, edgeIds: [holeRims[0].id] } }, 1, 1, 1);
    const holeG1 = await patchVariant("solid_hole_rim_g1", { edges: { bodyId: plate.id, edgeIds: [holeRims[0].id] }, continuity: "g1" }, 1, 1, 1);
    requireCondition(zRange(holeFlat) < 0.1 && zRange(holeG1) > 3, `Solid hole rim: default must be flat and g1 must bulge (${zRange(holeFlat)}, ${zRange(holeG1)})`);
    const [loopBox] = await add("plasticity_create_box", { originMm: [3700, 0, 0], sizeMm: [20, 20, 10] });
    const loopTop = ((await call(client, "plasticity_body_info", { id: loopBox.id })).body.faces as any[]).find((face) => face.normal[2] > 0.999);
    const [loopGuide] = await add("plasticity_create_nurbs_curve", { pointsMm: [[3700, 10, 10], [3710, 10, 18], [3720, 10, 10]] });
    const loopPlain = await patchVariant("solid_face_loop", { edges: { bodyId: loopBox.id, edgeIds: loopTop.edgeIds } }, 1, 4, 4);
    const loopGuided = await patchVariant("solid_face_loop_with_guide", { edges: { bodyId: loopBox.id, edgeIds: loopTop.edgeIds }, guideIds: [loopGuide.id] }, 1, 4, 4);
    requireCondition(loopGuided.boundsMm.max[2] > loopPlain.boundsMm.max[2] + 5, `The guide must raise the Solid-loop patch: ${loopGuided.boundsMm.max[2]} vs ${loopPlain.boundsMm.max[2]}`);
    checks.xsided_solid_edges = { holeRimZRange: { default: zRange(holeFlat), g1: zRange(holeG1) }, faceLoopMaxZ: { plain: loopPlain.boundsMm.max[2], guided: loopGuided.boundsMm.max[2] } };

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
    // Open 3 x 3 quad grid (interpolateBoundary changes the face count) and a triangle-only cube (it converts).
    const convertFile = async (label: string, file: string, options: Record<string, unknown>) => {
      const checkpoint = (await status(client)).undoDepth;
      await mutate("plasticity_import_reference_mesh", { path: file, sourceUnit: "millimeter" });
      const list = (await call(client, "plasticity_list_reference_meshes", {})).referenceMeshes as Array<{ id: number }>;
      const before = await status(client);
      const after = await mutate("plasticity_convert_reference_mesh_to_polysplines", { referenceMeshId: list[list.length - 1]!.id, ...options });
      const created = after.bodies.filter((body: any) => !before.bodies.some((old: any) => old.id === body.id));
      requireCondition(created.length === 1, `${label}: expected one new body, got ${created.length}`);
      const result = { type: created[0].type, faces: created[0].faceCount, edges: created[0].edgeCount, vertices: created[0].vertexCount, boundsMm: created[0].boundsMm };
      checks[`polysplines_${label}`] = { options, ...result };
      await undoTo(checkpoint);
      return result;
    };
    const gridObj = join(output, "quad-grid-3x3.obj");
    await writeFile(gridObj, gridObjText(3200), { flag: "wx", mode: 0o600 });
    const gridDefault = await convertFile("grid_default", gridObj, {});
    const gridInterpolated = await convertFile("grid_interpolate_boundary", gridObj, { interpolateBoundary: true });
    const gridSeparate = await convertFile("grid_merge_false", gridObj, { mergePatches: false });
    requireCondition(gridDefault.type === "Sheet" && gridDefault.faces === 9, `Open grid default: expected a 9-face Sheet, got ${gridDefault.type} ${gridDefault.faces}F`);
    requireCondition(gridInterpolated.faces === 21, `Open grid interpolateBoundary: expected 21 faces, got ${gridInterpolated.faces}`);
    requireCondition(gridSeparate.faces === gridDefault.faces, `Open grid mergePatches false: expected no change, got ${gridSeparate.faces}F`);
    const triangleObj = join(output, "triangle-cube.obj");
    await writeFile(triangleObj, triangleCubeObjText(3300), { flag: "wx", mode: 0o600 });
    const triangles = await convertFile("triangle_cube", triangleObj, {});
    requireCondition(triangles.type === "Solid" && triangles.faces === 36, `Triangle cube: expected a 36-face Solid, got ${triangles.type} ${triangles.faces}F`);
    requireCondition((await call(client, "plasticity_list_reference_meshes", {})).referenceMeshes.length === baselineMeshes, "Undo did not restore the reference mesh count after the grid and triangle cases");

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
    await rejects("plasticity_move_face_control_points", { bodyId: sheet.id, cvIds: ["0c0"], deltaMm: [0, 0, 1] }, /plasticity_show_face_control_points/, "move before show");
    const showRevision = (await status(client)).revision;
    const shown = await call(client, "plasticity_show_face_control_points", { bodyId: sheet.id, faceIds: [faceId], revision: showRevision });
    requireCondition((await status(client)).undoDepth === faceCheckpoint + 1, "Showing face control points must add exactly one Undo entry");
    const points = shown.controlPoints as Array<{ cvId: string; faceId: string; index: number; positionMm: [number, number, number] }>;
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
    const movedPoints = moved.controlPoints as Array<{ cvId: string; faceId: string; index: number; positionMm: [number, number, number] }>;
    requireCondition(movedPoints.length === moveIds.length && movedPoints[0]!.index === topRow[0]!.index, `The move must return the ${moveIds.length} moved point, got ${movedPoints.length}`);
    requireCondition(movedPoints[0]!.cvId !== moveIds[0], `The move must return the new cvId (versionId), got the old ${movedPoints[0]!.cvId}`);
    for (const point of movedPoints) {
      const original = points.find((candidate) => candidate.index === point.index)!;
      requireNear(point.positionMm[2] - original.positionMm[2], 10, `cv ${point.cvId} z delta`, 0.01);
      requireNear(point.positionMm[0], original.positionMm[0], `cv ${point.cvId} x`, 0.01);
      requireNear(point.positionMm[1], original.positionMm[1], `cv ${point.cvId} y`, 0.01);
    }
    checks.face_points = {
      structure: { u: bSpline.uControlPointCount, v: bSpline.vControlPointCount },
      shown: points.length,
      maxZBefore: sheet.boundsMm.max[2],
      maxZAfter: movedSheet.boundsMm.max[2],
      moved: movedPoints.map((point) => ({ cvIdBefore: moveIds[0], cvId: point.cvId, index: point.index, deltaZ: point.positionMm[2] - points.find((candidate) => candidate.index === point.index)!.positionMm[2] })),
    };
    await rejects("plasticity_move_face_control_points", { bodyId: sheet.id, cvIds: ["9999c9999"], deltaMm: [0, 0, 1] }, /plasticity_show_face_control_points/, "unknown cvId");
    // The pre-move cvId is stale after the move, even at the current revision: rejected, never re-targeted.
    await rejects("plasticity_move_face_control_points", { bodyId: sheet.id, cvIds: [moveIds[0]], deltaMm: [0, 0, 1] }, /Unknown face control point IDs/, "pre-move cvId after the move");
    const staleRevision = (await status(client)).revision;
    await mutate("plasticity_move_face_control_points", { bodyId: sheet.id, cvIds: [movedPoints[0]!.cvId], deltaMm: [0, 0, 1] });
    await rejects("plasticity_move_face_control_points", { bodyId: sheet.id, cvIds: [movedPoints[0]!.cvId], deltaMm: [0, 0, 1], revision: staleRevision }, /stale/i, "stale revision");
    await rejects("plasticity_show_face_control_points", { bodyId: sheet.id, faceIds: ["nope"] }, /face/i, "unknown face");

    // ---- multi-face body: a Sheet joined from two arc Sheets has two BSurf faces. Points of both faces are
    // numbered together, face by face; showing or hiding one face renumbers the other's points.
    {
      const [arcA] = await add("plasticity_create_nurbs_curve", { pointsMm: [[3800, 0, 0], [3810, 0, 8], [3820, 0, 0]] });
      const [arcB] = await add("plasticity_create_nurbs_curve", { pointsMm: [[3820, 0, 0], [3830, 0, 8], [3840, 0, 0]] });
      const sheetA = (await add("plasticity_extrude_curves", { ids: [arcA.id], distanceMm: 20, direction: [0, 1, 0] })).find((body: any) => body.type === "Sheet");
      const sheetB = (await add("plasticity_extrude_curves", { ids: [arcB.id], distanceMm: 20, direction: [0, 1, 0] })).find((body: any) => body.type === "Sheet");
      const [joined] = await add("plasticity_join_sheets", { ids: [sheetA.id, sheetB.id] });
      const two = joined ?? (await status(client)).bodies.find((body: any) => body.type === "Sheet" && body.faceCount === 2 && body.boundsMm.min[0] > 3790);
      requireCondition(two && two.faceCount === 2, `Expected one two-face Sheet, got ${JSON.stringify(two && { type: two.type, faces: two.faceCount })}`);
      const faces = (await call(client, "plasticity_body_info", { id: two.id })).body.faces as any[];
      const faceA = faces.find((face) => face.centerMm[0] < 3820).id;
      const faceB = faces.find((face) => face.centerMm[0] > 3820).id;
      const multiCheckpoint = (await status(client)).undoDepth;
      const showB = await call(client, "plasticity_show_face_control_points", { bodyId: two.id, faceIds: [faceB], revision: (await status(client)).revision });
      requireCondition(showB.undoSteps === 1 && showB.controlPoints.length === 8, `show B: expected 8 points in one step, got ${showB.controlPoints.length}`);
      requireCondition(JSON.stringify(showB.grids) === JSON.stringify([{ faceId: showB.faces[0].faceId, u: 4, v: 2 }]), `show B: expected grids [{ u 4, v 2 }], got ${JSON.stringify(showB.grids)}`);
      requireCondition(showB.renumbered === false, "show B: no other face had shown points, so renumbered must be false");
      const bIdsAlone = showB.controlPoints.map((point: any) => point.cvId);
      const faceBNow = showB.faces[0].faceId;
      requireCondition(faceBNow !== faceB && showB.controlPoints.every((point: any) => point.faceId === faceBNow), "show B: the points must carry B's new face ID");
      const faceANow = (await call(client, "plasticity_body_info", { id: two.id })).body.faces.find((face: any) => face.centerMm[0] < 3820).id;
      const showA = await call(client, "plasticity_show_face_control_points", { bodyId: two.id, faceIds: [faceANow], revision: (await status(client)).revision });
      requireCondition(showA.controlPoints.length === 8 && showA.controlPoints.every((point: any) => point.faceId === showA.faces[0].faceId), "show A: only A's 8 points must be returned");
      requireCondition(showA.renumbered === true && /renumbered/.test(showA.message ?? ""), `show A: B's points were renumbered, expected renumbered true, got ${String(showA.renumbered)}`);
      const both = await call(client, "plasticity_show_face_control_points", { bodyId: two.id, faceIds: [showA.faces[0].faceId], revision: (await status(client)).revision });
      requireCondition(both.undoSteps === 0, "a second show of a shown face must cost no Undo step");
      requireCondition((await status(client)).undoDepth === multiCheckpoint + 2, "show B + show A + second show must be exactly two Undo steps");
      const bodyFaces = (await call(client, "plasticity_body_info", { id: two.id })).body.faces as any[];
      const bNow = bodyFaces.find((face) => face.centerMm[0] > 3820).id;
      const readAll = await call(client, "plasticity_show_face_control_points", { bodyId: two.id, faceIds: [bNow], revision: (await status(client)).revision });
      const bIdsAfter = readAll.controlPoints.map((point: any) => point.cvId);
      const aIds = showA.controlPoints.map((point: any) => point.cvId);
      requireCondition(new Set([...aIds, ...bIdsAfter]).size === 16, `cvIds must be unique across the body: A ${aIds} B ${bIdsAfter}`);
      // B's cvId from before A was shown names a renumbered point; it must be rejected at the current revision.
      await rejects("plasticity_move_face_control_points", { bodyId: two.id, cvIds: [bIdsAlone[2]], deltaMm: [0, 0, 1] }, /Unknown face control point IDs/, "stale cvId of face B after showing A");
      checks.face_points_multi_face = { bIdsAlone, aIds, bIdsAfterA: bIdsAfter, bChanged: JSON.stringify(bIdsAlone) !== JSON.stringify(bIdsAfter) };
      // Move one point of each face in one step; the read-back checks the delta.
      const pickA = showA.controlPoints[2], pickB = readAll.controlPoints[4];
      const movedBoth = await call(client, "plasticity_move_face_control_points", { bodyId: two.id, cvIds: [pickA.cvId, pickB.cvId], deltaMm: [0, 0, 5], revision: (await status(client)).revision });
      requireCondition(movedBoth.undoSteps === 1 && movedBoth.controlPoints.length === 2, "multi-face move: expected two points in one step");
      for (const [point, before] of [[movedBoth.controlPoints[0], pickA], [movedBoth.controlPoints[1], pickB]]) {
        requireNear(point.positionMm[2] - before.positionMm[2], 5, `multi-face move cv ${before.cvId} z delta`, 1e-3);
        requireCondition(point.index === before.index, `multi-face move cv ${before.cvId}: grid index changed`);
      }
      // Hide A: one step; B's points renumber and come back in the result.
      const hideFaceA = (await call(client, "plasticity_body_info", { id: two.id })).body.faces.find((face: any) => face.centerMm[0] < 3820).id;
      const hidden = await call(client, "plasticity_hide_face_control_points", { bodyId: two.id, faceIds: [hideFaceA], revision: (await status(client)).revision });
      requireCondition(hidden.undoSteps === 1 && hidden.faces[0].controlPointCount === 0, "hide A: expected one step and no points left on A");
      requireCondition(hidden.controlPoints.length === 8 && JSON.stringify(hidden.controlPoints.map((point: any) => point.index)) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7]), `hide A: expected B's 8 points, got ${hidden.controlPoints.map((point: any) => point.cvId)}`);
      requireCondition(hidden.controlPoints.every((point: any) => !bIdsAfter.includes(point.cvId)), "hide A: B's cvIds must change with the edit");
      const hiddenAgain = await call(client, "plasticity_hide_face_control_points", { bodyId: two.id, faceIds: [hidden.faces[0].faceId], revision: (await status(client)).revision });
      requireCondition(hiddenAgain.undoSteps === 0, "a hide of a face with no shown points must cost no Undo step");
      checks.face_points_multi_face_move_hide = { moved: movedBoth.controlPoints, hiddenRemaining: hidden.controlPoints.length, hiddenRemainingIds: hidden.controlPoints.map((point: any) => point.cvId), undoDepth: [multiCheckpoint, (await status(client)).undoDepth] };
      // Zero-CV faces are refused before any edit: a Plane face and a Cylinder face.
      const [zeroBox] = await add("plasticity_create_box", { originMm: [3900, 0, 0], sizeMm: [10, 10, 10] });
      const [zeroCylinder] = await add("plasticity_create_cylinder", { centerMm: [3950, 0, 0], radiusMm: 5, heightMm: 10 });
      const planeFace = ((await call(client, "plasticity_body_info", { id: zeroBox.id })).body.faces as any[]).find((face) => face.normal[2] > 0.999).id;
      const cylinderFace = ((await call(client, "plasticity_body_info", { id: zeroCylinder.id })).body.faces as any[]).find((face) => !face.planar).id;
      await rejects("plasticity_show_face_control_points", { bodyId: zeroBox.id, faceIds: [planeFace] }, /no editable control points.*\(Plane\)/, "Plane face");
      await rejects("plasticity_show_face_control_points", { bodyId: zeroCylinder.id, faceIds: [cylinderFace] }, /no editable control points.*\(Cylinder\)/, "Cylinder face");
      console.error(`face_points_multi_face: ok ${JSON.stringify(checks.face_points_multi_face)}`);
    }

    // ---- coincident points on the edge two faces share (probe-coincident-point.json). Moved alone, Plasticity leaves
    // the twin point in place and reshapes the moved face's surface; the body stays valid, the read-back fails and
    // names the separation, and the step stays in the Undo history. Moved together, both points move and read back.
    {
      const [arcA] = await add("plasticity_create_nurbs_curve", { pointsMm: [[4000, 0, 0], [4010, 0, 8], [4020, 0, 0]] });
      const [arcB] = await add("plasticity_create_nurbs_curve", { pointsMm: [[4020, 0, 0], [4030, 0, 8], [4040, 0, 0]] });
      const sheetA = (await add("plasticity_extrude_curves", { ids: [arcA.id], distanceMm: 20, direction: [0, 1, 0] })).find((body: any) => body.type === "Sheet");
      const sheetB = (await add("plasticity_extrude_curves", { ids: [arcB.id], distanceMm: 20, direction: [0, 1, 0] })).find((body: any) => body.type === "Sheet");
      const [joined] = await add("plasticity_join_sheets", { ids: [sheetA.id, sheetB.id] });
      const two = joined ?? (await status(client)).bodies.find((body: any) => body.type === "Sheet" && body.faceCount === 2 && body.boundsMm.min[0] > 3990);
      requireCondition(two && two.faceCount === 2, "coincident: expected one two-face Sheet");
      const faces = (await call(client, "plasticity_body_info", { id: two.id })).body.faces as any[];
      const shownBoth = await call(client, "plasticity_show_face_control_points", { bodyId: two.id, faceIds: faces.map((face) => face.id), revision: (await status(client)).revision });
      const [fa, fb] = shownBoth.faces.map((face: any) => face.faceId);
      const at = (point: any) => point.positionMm.join(",");
      const aEdge = shownBoth.controlPoints.find((point: any) => point.faceId === fa && shownBoth.controlPoints.some((other: any) => other.faceId === fb && at(other) === at(point)));
      const bEdge = shownBoth.controlPoints.find((point: any) => point.faceId === fb && aEdge && at(point) === at(aEdge));
      requireCondition(aEdge && bEdge, "coincident: no shared-edge point pair found");
      const checkpoint = (await status(client)).undoDepth;
      let message = "";
      try {
        await call(client, "plasticity_move_face_control_points", { bodyId: two.id, cvIds: [aEdge.cvId], deltaMm: [0, 0, 5], revision: (await status(client)).revision });
      } catch (error) { message = error instanceof Error ? error.message : String(error); }
      requireCondition(/separated coincident points of two faces/.test(message) && /include both cvIds/.test(message), `coincident: expected the separation to be reported, got "${message.slice(0, 300)}"`);
      const afterLone = await status(client);
      requireCondition(message.includes(`The document is now at revision ${afterLone.revision}; undo with plasticity_undo, re-read the cvIds with plasticity_show_face_control_points`), `coincident: the error must carry the new revision ${afterLone.revision} and the undo advice, got "${message.slice(0, 600)}"`);
      requireCondition((await status(client)).undoDepth === checkpoint + 1, "coincident: the lone move must stay one step in the Undo history");
      requireCondition((await status(client)).bodies.some((body: any) => body.id === two.id && body.faceCount === 2), "coincident: the body must survive the lone move");
      await undoTo(checkpoint);
      const together = await call(client, "plasticity_move_face_control_points", { bodyId: two.id, cvIds: [aEdge.cvId, bEdge.cvId], deltaMm: [0, 0, 5], revision: (await status(client)).revision });
      requireCondition(together.undoSteps === 1 && together.controlPoints.length === 2, "coincident: both points must move in one step");
      for (const point of together.controlPoints) requireNear(point.positionMm[2], aEdge.positionMm[2] + 5, `coincident: cv ${point.cvId} z`, 1e-3);
      await undoTo(checkpoint);
      // A delta below the read-back resolution is refused before any edit.
      await rejects("plasticity_move_face_control_points", { bodyId: two.id, cvIds: [aEdge.cvId], deltaMm: [0, 0, 0.0005] }, /below the verifiable resolution 0\.001 mm at this distance from the origin.*nothing was changed/, "sub-tolerance delta");
      // The twin face's points hidden: the lone move names that face and says to show it first.
      const hideB = await call(client, "plasticity_hide_face_control_points", { bodyId: two.id, faceIds: [fb], revision: (await status(client)).revision });
      const aAlone = hideB.controlPoints.find((point: any) => at(point) === at(aEdge));
      requireCondition(aAlone, "hidden twin: A's shared-edge point not found after hiding B");
      let hiddenMessage = "";
      try {
        const movedAlone = await call(client, "plasticity_move_face_control_points", { bodyId: two.id, cvIds: [aAlone.cvId], deltaMm: [0, 0, 5], revision: (await status(client)).revision });
        hiddenMessage = String(movedAlone.message ?? "");
      } catch (error) { hiddenMessage = error instanceof Error ? error.message : String(error); }
      requireCondition(/whose control points are not shown: .*first/.test(hiddenMessage) && /include both cvIds/.test(hiddenMessage) && hiddenMessage.includes(`${two.id}:${hideB.faces[0].faceId}`), `hidden twin: expected the show-that-face-first hint naming ${two.id}:${hideB.faces[0].faceId}, got "${hiddenMessage.slice(0, 500)}"`);
      await undoTo(checkpoint);
      checks.face_points_coincident = { pair: [aEdge.cvId, bEdge.cvId], positionMm: aEdge.positionMm, aloneError: message.slice(0, 600), together: together.controlPoints, hiddenTwin: hiddenMessage.slice(0, 600) };
      console.error("face_points_coincident: ok");
    }

    // ---- a face split on one B-Surface: a knife cut along y at the apex of an extruded arc gives two faces with
    // identical control grids. Their shown points could never be attributed, so the show is refused before any edit.
    {
      const [arch] = await add("plasticity_create_nurbs_curve", { pointsMm: [[4100, 0, 0], [4120, 0, 10], [4140, 0, 0]] });
      const split = (await add("plasticity_extrude_curves", { ids: [arch.id], distanceMm: 20, direction: [0, 1, 0] })).find((body: any) => body.type === "Sheet");
      const apex = split.boundsMm.max[2];
      await mutate("plasticity_knife_curve", { targetId: split.id, pointsMm: [[4120, -1, apex], [4120, 21, apex]] });
      const halves = (await call(client, "plasticity_body_info", { id: split.id })).body.faces as any[];
      requireCondition(halves.length === 2 && halves.every((face) => face.surfaceType === "BSurf"), `split: expected two BSurf faces, got ${halves.map((face) => face.surfaceType)}`);
      await rejects("plasticity_show_face_control_points", { bodyId: split.id, faceIds: [halves[0].id] }, /share one control grid \(faces split on one B-Surface\).*nothing was changed/, "split face show");
      await rejects("plasticity_show_face_control_points", { bodyId: split.id, faceIds: halves.map((face) => face.id) }, /share one control grid/, "split faces show both");
      checks.face_points_split_face_refused = { faces: halves.map((face) => face.id) };
      console.error("face_points_split_face_refused: ok");
    }

    // ---- restore the baseline
    await undoTo(baseline.undoDepth);
    const restored = await status(client);
    evidence.checks = checks;
    evidence.restored = { ...summary(restored), referenceMeshCount: (await call(client, "plasticity_list_reference_meshes", {})).referenceMeshes.length };
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
    throw error;
  } finally {
    // Recovery runs on every exit path; after a clean run it finds the baseline and does nothing.
    if (live && baseline) evidence.cleanup = await recover(live.client, baseline).catch((cleanupError) => ({ restored: false, reason: boundedError(cleanupError) }));
    if (evidence.failure !== undefined) {
      evidence.serverStderr = serverStderr.join("").slice(-8192);
      await writeExclusive(join(output, "failure.json"), evidence).catch(() => {});
    }
    await live?.client.close().catch(() => {});
  }
}

// A 10 mm quad cube with outward-facing quads, offset along x so it never touches the disposable test bodies.
function cubeObjText(x: number): string {
  const vertices = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
  const faces = [[1, 4, 3, 2], [5, 6, 7, 8], [1, 2, 6, 5], [3, 4, 8, 7], [1, 5, 8, 4], [2, 3, 7, 6]];
  return `${vertices.map(([vx, vy, vz]) => `v ${x + vx!} ${vy} ${vz}`).join("\n")}\n${faces.map((face) => `f ${face.join(" ")}`).join("\n")}\n`;
}

// An open 4 x 4 vertex, 3 x 3 quad grid, 30 mm square, with the four inner vertices raised 6 mm.
function gridObjText(x: number): string {
  const vertices: string[] = [];
  const faces: string[] = [];
  for (let j = 0; j < 4; j += 1) for (let i = 0; i < 4; i += 1) vertices.push(`v ${x + i * 10} ${j * 10} ${(i === 1 || i === 2) && (j === 1 || j === 2) ? 6 : 0}`);
  for (let j = 0; j < 3; j += 1) for (let i = 0; i < 3; i += 1) { const a = j * 4 + i + 1; faces.push(`f ${a} ${a + 1} ${a + 5} ${a + 4}`); }
  return `${vertices.join("\n")}\n${faces.join("\n")}\n`;
}

// A 10 mm cube of 12 triangles (each quad split along a diagonal).
function triangleCubeObjText(x: number): string {
  const vertices = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
  const quads = [[1, 4, 3, 2], [5, 6, 7, 8], [1, 2, 6, 5], [3, 4, 8, 7], [1, 5, 8, 4], [2, 3, 7, 6]];
  const faces = quads.flatMap(([a, b, c, d]) => [`f ${a} ${b} ${c}`, `f ${a} ${c} ${d}`]);
  return `${vertices.map(([vx, vy, vz]) => `v ${x + vx!} ${vy} ${vz}`).join("\n")}\n${faces.join("\n")}\n`;
}

async function startMcp(stderr: string[]): Promise<LiveMcp> {
  const endpoint = process.env.PLASTICITY_CDP_URL;
  if (!endpoint) throw new Error("PLASTICITY_CDP_URL must name the isolated Plasticity instance");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "scripts", "run-server.ts")],
    cwd: projectRoot,
    env: { ...selectedEnvironment(process.env), PLASTICITY_CDP_URL: endpoint, PLASTICITY_AUTO_LAUNCH: "0", PLASTICITY_HUD: "0" },
    stderr: "pipe",
  });
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
  for (let count = 0; count < 200; count += 1) {
    const current = await status(client);
    if (current.documentToken !== initial.documentToken) return { restored: false, reason: "document-changed" };
    if (current.undoDepth <= initial.undoDepth) {
      const referenceMeshCount = (await call(client, "plasticity_list_reference_meshes", {})).referenceMeshes.length;
      const bodiesRestored = current.bodies.length === initial.bodies.length;
      const meshesRestored = referenceMeshCount === initial.referenceMeshCount;
      return { restored: bodiesRestored && meshesRestored, ...(meshesRestored ? {} : { reason: "reference-mesh-count" }), bodyCount: current.bodies.length, referenceMeshCount, baselineReferenceMeshCount: initial.referenceMeshCount };
    }
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
