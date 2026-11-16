#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { discoverPlasticityTargets } from "../src/cdp/discovery.ts";
import { nativeFunction } from "../src/plasticity/native-function.ts";
import { PlasticityRuntime } from "../src/plasticity/runtime.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface DrivingDistanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

type Vector = [number, number, number];

export function parseDrivingDistanceArgs(argv: string[]): DrivingDistanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: DrivingDistanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live driving-distance acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live driving-distance acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live driving-distance acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-driving-distance-live.ts --help
  node scripts/verify-native-driving-distance-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
PLASTICITY_CDP_URL is mandatory: set it to the isolated Plasticity instance. The command never launches Plasticity
(it forces PLASTICITY_AUTO_LAUNCH=0 and PLASTICITY_HUD=0) and refuses to start without the variable.
Live mode takes a baseline, then builds disposable geometry at x >= 2400 mm and checks plasticity_set_driving_distance:
  - box 20 x 10 x 5: +x face to 30 mm (-x plane fixed), -x face to 30 mm (+x plane fixed), y to 18 mm,
    a single +z face without a reference (Plasticity finds the opposite face), each one Undo step that undo restores;
  - cylinder cap height 10 -> 16 mm with the bottom cap fixed;
  - an equal distance is a no-op with no Undo entry, in pair mode and in single-face mode;
  - a washer plate (centred through hole, so the top face midpoint lies in the hole): single-face and pair mode;
  - a stepped block: two +z faces that face the same way, the upper one set 8 mm above the lower one;
  - the same stepped block reversed: the UPPER face is the reference and the lower face moves (5 -> 8 mm below it);
  - the step-deleted case: the lower face set 12 mm below the upper one goes past the bottom and Plasticity removes
    the low part: a certain "committed but does not match" error naming the removed face and the Undo step, after
    which one plasticity_undo (no reconcile) restores the body;
  - slot walls that face each other: the slot width 10 -> 14 mm (one wall fixed) and single-face mode on a wall;
  - an island pad inside a ring-shaped coplanar face (its top coplanar with the surrounding top face, whose bounds box
    covers it): the pad's top is set to 14 mm above the bottom; the call must succeed (verified, or ambiguous with a note
    naming the sibling) and an independent face read must show the ring at 10 mm and the island top at 14 mm;
  - single-face mode on the flat face of a half cylinder (a cylinder, not a parallel plane, lies behind it):
    Plasticity rejects it, no Undo entry;
  - every commit is read back: movedFaceId and planeOffsetMm must match the moved plane;
  - a non-parallel pair is rejected with no Undo entry;
  - one plasticity_batch that creates a box and sets a driving distance in one call.
After every case it reads the editor directly (read-only, same CDP endpoint): no active command, no selection,
no selection hits, no focused space input. It undoes back to the baseline Undo depth and body count and never
saves the document. Run it only against an isolated Plasticity instance.`;

const PICK_STATE = nativeFunction`function () {
  let bodies = 0;
  for (const [versionId] of nativeApi.geo.geometryModel) if (!nativeApi.geo.automatics.has(versionId)) bodies += 1;
  let selected = 0;
  for (const value of Object.values(this.selection.selected)) {
    if ((value instanceof Set || value instanceof Map) && typeof value.size === 'number') selected += value.size;
  }
  return {
    undoDepth: this.history.undoStack.length,
    bodies,
    busy: Boolean(this.executor.isBusy),
    activeCommand: this.executor.active ? (this.executor.active.command?.constructor?.name ?? 'unknown') : null,
    selected,
    hits: this.selection.hits.hits?.size ?? null,
    spaceInputFocused: Boolean(document.querySelector('input.z-space-input-focused')),
  };
}`;

async function main(): Promise<void> {
  const options = parseDrivingDistanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  const endpoint = process.env.PLASTICITY_CDP_URL;
  if (!endpoint) throw new Error("PLASTICITY_CDP_URL is mandatory and must name the isolated Plasticity instance; nothing was created");
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target!, endpoint };
  const serverStderr: string[] = [];
  let live: LiveMcp | undefined;
  let native: PlasticityRuntime | undefined;
  let baseline: any;
  let nativeBaseline: any;
  try {
    // Read-only direct view of the editor for the cleanliness checks (executor, selection hits).
    const targets = await discoverPlasticityTargets(endpoint);
    const target = targets.find((candidate) => candidate.id === options.target);
    requireCondition(target, "Explicit Plasticity target was not found on PLASTICITY_CDP_URL");
    native = await PlasticityRuntime.connect(target);
    const pickState = async (): Promise<any> => await native!.read(PICK_STATE);

    live = await startMcp(endpoint, output, serverStderr);
    const client = live.client;
    const windows = await call(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    await call(client, "plasticity_connect", { targetId: options.target });
    baseline = await status(client);
    nativeBaseline = await pickState();
    evidence.baseline = { ...summary(baseline), native: nativeBaseline };
    requireCondition(nativeBaseline.undoDepth === baseline.undoDepth && nativeBaseline.bodies === baseline.bodies.length, "Native and MCP baselines disagree");
    const checks: Record<string, unknown> = {};

    const requireClean = async (label: string): Promise<Record<string, unknown>> => {
      const state = await pickState();
      requireCondition(state.activeCommand === null && !state.busy, `${label}: a command is still active (${String(state.activeCommand)})`);
      requireCondition(state.selected === 0, `${label}: ${state.selected} items are still selected`);
      requireCondition(state.hits === 0, `${label}: ${String(state.hits)} selection hits remain`);
      requireCondition(!state.spaceInputFocused, `${label}: a space input is still focused`);
      const selection = await call(client, "plasticity_current_selection", {});
      const selectedCount = ["bodyIds", "curveIds", "instanceIds", "referenceMeshIds", "groupIds", "faces", "edges", "regionIds", "curveControlPoints"]
        .reduce((sum, key) => sum + (Array.isArray(selection[key]) ? selection[key].length : 0), 0);
      requireCondition(selectedCount === 0, `${label}: plasticity_current_selection is not empty`);
      return { activeCommand: state.activeCommand, selected: state.selected, hits: state.hits, spaceInputFocused: state.spaceInputFocused, mcpSelected: selectedCount };
    };
    const create = async (tool: string, args: Record<string, unknown>): Promise<any> => {
      const before = await status(client);
      await call(client, tool, { ...args, revision: before.revision });
      const after = await status(client);
      const added = after.bodies.filter((body: { id: number }) => !before.bodies.some((old: { id: number }) => old.id === body.id));
      requireCondition(added.length === 1 && added[0].type === "Solid", `${tool}: expected one new Solid`);
      return added[0];
    };
    const faceWithNormal = async (bodyId: number, normal: Vector): Promise<any> => {
      const current = await status(client);
      const found = await call(client, "plasticity_find_faces", { revision: current.revision, query: { bodyIds: [bodyId], planar: true, normal: { vector: normal, toleranceDeg: 0.01 } } });
      requireCondition(found.count === 1, `Expected one planar face of body ${bodyId} with normal ${normal.join(",")}, found ${found.count}`);
      return found.matches[0];
    };
    // Signed plane offset along the face normal's axis: the coordinate of the plane on that axis.
    const planeOf = async (bodyId: number, normal: Vector): Promise<number> => {
      const face = await faceWithNormal(bodyId, normal);
      const axis = normal.findIndex((value) => value !== 0);
      return face.centerMm[axis] as number;
    };
    const bodyOf = async (id: number): Promise<any> => {
      const body = (await status(client)).bodies.find((candidate: { id: number }) => candidate.id === id);
      requireCondition(body, `Body ${id} disappeared`);
      return body;
    };

    // One driving-distance edit: checks one Undo step, the moved and fixed planes, the reported distances,
    // a clean editor, then undoes once and checks the plane positions and Undo depth come back.
    const drive = async (label: string, bodyId: number, spec: { moving: Vector; reference?: Vector; fixed: Vector; distanceMm: number; previousMm: number }) => {
      const checkpoint = await status(client);
      const moving = await faceWithNormal(bodyId, spec.moving);
      const reference = spec.reference ? await faceWithNormal(bodyId, spec.reference) : undefined;
      const fixedBefore = await planeOf(bodyId, spec.fixed);
      const movingBefore = await planeOf(bodyId, spec.moving);
      const result = await call(client, "plasticity_set_driving_distance", {
        bodyId, movingFaceId: moving.id, ...(reference ? { referenceFaceId: reference.id } : {}), distanceMm: spec.distanceMm,
        revision: checkpoint.revision, intent: `Acceptance: ${label}`,
      });
      const after = await status(client);
      requireCondition(after.undoDepth === checkpoint.undoDepth + 1, `${label}: expected exactly one Undo step, got ${after.undoDepth - checkpoint.undoDepth}`);
      requireCondition(result.undoSteps === 1 && result.changed === true && result.distanceMm === spec.distanceMm, `${label}: unexpected result fields`);
      requireNear(result.previousDistanceMm, spec.previousMm, `${label} previousDistanceMm`, 1e-6);
      requireCondition(after.bodies.some((body: { id: number }) => body.id === bodyId), `${label}: the body lost its stable id`);
      requireCondition(after.bodies.length === checkpoint.bodies.length, `${label}: the body count changed`);
      const fixedAfter = await planeOf(bodyId, spec.fixed);
      const movingAfter = await planeOf(bodyId, spec.moving);
      requireNear(fixedAfter, fixedBefore, `${label}: fixed plane`, 1e-6);
      requireNear(Math.abs(movingAfter - fixedAfter), spec.distanceMm, `${label}: distance between the planes`, 1e-6);
      requireCondition(Math.abs(movingAfter - movingBefore) > 1e-3, `${label}: the moving plane did not move`);
      // Post-commit read-back reported by the tool: movedFaceId is the moved face and planeOffsetMm its plane.
      const movedFace = await faceWithNormal(bodyId, spec.moving);
      requireCondition(result.movedFaceId === movedFace.id, `${label}: movedFaceId ${String(result.movedFaceId)} is not the moved face ${movedFace.id}`);
      const axis = spec.moving.findIndex((value) => value !== 0);
      requireNear(result.planeOffsetMm, movingAfter * spec.moving[axis]!, `${label}: planeOffsetMm`, 1e-6);
      const clean = await requireClean(label);
      await call(client, "plasticity_undo", { revision: after.revision, intent: `Undo acceptance: ${label}` });
      const undone = await status(client);
      requireCondition(undone.undoDepth === checkpoint.undoDepth, `${label}: undo did not return to the checkpoint`);
      requireNear(await planeOf(bodyId, spec.moving), movingBefore, `${label}: undo restores the moving plane`, 1e-6);
      requireNear(await planeOf(bodyId, spec.fixed), fixedBefore, `${label}: undo keeps the fixed plane`, 1e-6);
      const record = {
        movingFaceId: moving.id, referenceFaceId: reference?.id ?? null, previousDistanceMm: result.previousDistanceMm, distanceMm: result.distanceMm,
        movedFaceId: result.movedFaceId, planeOffsetMm: result.planeOffsetMm,
        undoDepth: [checkpoint.undoDepth, after.undoDepth, undone.undoDepth],
        fixedPlaneMm: [fixedBefore, fixedAfter], movingPlaneMm: [movingBefore, movingAfter], boundsAfter: after.bodies.find((body: { id: number }) => body.id === bodyId).boundsMm, clean,
      };
      checks[label] = record;
      console.error(`${label}: ok ${JSON.stringify({ previous: record.previousDistanceMm, fixed: record.fixedPlaneMm, moving: record.movingPlaneMm, undo: record.undoDepth })}`);
      return record;
    };

    // ---- box 20 x 10 x 5
    const box = await create("plasticity_create_box", { originMm: [2400, 0, 0], sizeMm: [20, 10, 5] });
    await drive("box_x_moving_pos_x", box.id, { moving: [1, 0, 0], reference: [-1, 0, 0], fixed: [-1, 0, 0], distanceMm: 30, previousMm: 20 });
    await drive("box_x_moving_neg_x", box.id, { moving: [-1, 0, 0], reference: [1, 0, 0], fixed: [1, 0, 0], distanceMm: 30, previousMm: 20 });
    await drive("box_y_moving_pos_y", box.id, { moving: [0, 1, 0], reference: [0, -1, 0], fixed: [0, -1, 0], distanceMm: 18, previousMm: 10 });
    await drive("box_z_single_face", box.id, { moving: [0, 0, 1], fixed: [0, 0, -1], distanceMm: 12, previousMm: 5 });
    requireNear((await bodyOf(box.id)).boundsMm.max[0], 2420, "box restored after the cases");

    // ---- cylinder cap height 10 -> 16
    const cylinder = await create("plasticity_create_cylinder", { centerMm: [2500, 5, 0], radiusMm: 5, heightMm: 10 });
    await drive("cylinder_cap_height", cylinder.id, { moving: [0, 0, 1], reference: [0, 0, -1], fixed: [0, 0, -1], distanceMm: 16, previousMm: 10 });

    // ---- equal distance: a no-op with no Undo entry, in pair mode (pre-checked, no native call) and in
    // single-face mode (Plasticity's finish gives "no effect"; the tool reports a no-op).
    const noOp = async (label: string, bodyId: number, spec: { moving: Vector; reference?: Vector; distanceMm: number }) => {
      const before = await status(client);
      const moving = await faceWithNormal(bodyId, spec.moving);
      const reference = spec.reference ? await faceWithNormal(bodyId, spec.reference) : undefined;
      const result = await call(client, "plasticity_set_driving_distance", {
        bodyId, movingFaceId: moving.id, ...(reference ? { referenceFaceId: reference.id } : {}), distanceMm: spec.distanceMm, revision: before.revision, intent: `Acceptance: ${label}`,
      });
      const after = await status(client);
      requireCondition(result.changed === false && result.undoSteps === 0, `${label}: expected a no-op, got ${JSON.stringify({ changed: result.changed, undoSteps: result.undoSteps })}`);
      requireCondition(/distance already/.test(result.message ?? ""), `${label}: expected a "distance already" message, got ${String(result.message)}`);
      requireCondition(after.undoDepth === before.undoDepth && after.revision === before.revision, `${label}: a no-op changed the document`);
      checks[label] = { message: result.message, previousDistanceMm: result.previousDistanceMm, undoDepth: [before.undoDepth, after.undoDepth], clean: await requireClean(label) };
      console.error(`${label}: ok ${JSON.stringify(result.message)}`);
    };
    await noOp("equal_distance_pair_noop", box.id, { moving: [1, 0, 0], reference: [-1, 0, 0], distanceMm: 20 });
    await noOp("equal_distance_single_face_noop", box.id, { moving: [0, 0, 1], distanceMm: 5 });

    // ---- washer: 40 x 40 x 5 plate with a centred r 8 through hole. The top face midpoint lies in the hole, so
    // single-face mode needs the kernel's own point on the face as the hit (probe-washer.json).
    {
      const plate = await create("plasticity_create_box", { originMm: [2800, 0, 0], sizeMm: [40, 40, 5] });
      const before = await status(client);
      await call(client, "plasticity_create_cylinder", { centerMm: [2820, 20, -1], radiusMm: 8, heightMm: 7, revision: before.revision });
      const withHole = await status(client);
      const hole = withHole.bodies.find((body: { id: number }) => !before.bodies.some((old: { id: number }) => old.id === body.id));
      await call(client, "plasticity_boolean", { targetIds: [plate.id], toolIds: [hole.id], operation: "difference", revision: withHole.revision });
      const top = await faceWithNormal(plate.id, [0, 0, 1]);
      requireCondition(Math.hypot(top.centerMm[0] - 2820, top.centerMm[1] - 20) < 1e-6, `washer: expected the top face midpoint in the hole, got ${top.centerMm}`);
      checks.washer_top_midpoint_in_hole = { centerMm: top.centerMm };
      await drive("washer_single_face_top", plate.id, { moving: [0, 0, 1], fixed: [0, 0, -1], distanceMm: 8, previousMm: 5 });
      await drive("washer_pair_top_bottom", plate.id, { moving: [0, 0, 1], reference: [0, 0, -1], fixed: [0, 0, -1], distanceMm: 9, previousMm: 5 });
    }

    // ---- same-direction pair: a stepped block whose two +z faces (z 10 and z 5) face the same way. Plasticity
    // dimensions them; the upper face moves to 8 mm above the lower one.
    {
      const high = await create("plasticity_create_box", { originMm: [2900, 0, 0], sizeMm: [20, 10, 10] });
      const low = await create("plasticity_create_box", { originMm: [2920, 0, 0], sizeMm: [20, 10, 5] });
      const merged = await status(client);
      await call(client, "plasticity_boolean", { targetIds: [high.id], toolIds: [low.id], operation: "union", revision: merged.revision });
      const before = await status(client);
      const tops = await call(client, "plasticity_find_faces", { revision: before.revision, query: { bodyIds: [high.id], planar: true, normal: { vector: [0, 0, 1], toleranceDeg: 0.01 } } });
      requireCondition(tops.count === 2, `stepped: expected two +z faces, found ${tops.count}`);
      const upper = tops.matches.find((face: any) => face.centerMm[2] > 9);
      const lower = tops.matches.find((face: any) => face.centerMm[2] < 6);
      requireCondition(upper && lower, "stepped: upper and lower +z faces not found");
      const result = await call(client, "plasticity_set_driving_distance", { bodyId: high.id, movingFaceId: upper.id, referenceFaceId: lower.id, distanceMm: 8, revision: before.revision, intent: "Acceptance: stepped same-direction pair" });
      const after = await status(client);
      requireCondition(after.undoDepth === before.undoDepth + 1 && result.changed === true, "stepped: expected one Undo step");
      const topsAfter = await call(client, "plasticity_find_faces", { revision: after.revision, query: { bodyIds: [high.id], planar: true, normal: { vector: [0, 0, 1], toleranceDeg: 0.01 } } });
      const zs = topsAfter.matches.map((face: any) => face.centerMm[2]).sort((a: number, b: number) => a - b);
      requireNear(zs[0], 5, "stepped: lower face fixed", 1e-6);
      requireNear(zs[1], 13, "stepped: upper face at 5 + 8", 1e-6);
      requireNear(result.planeOffsetMm, 13, "stepped: planeOffsetMm", 1e-6);
      requireCondition(topsAfter.matches.some((face: any) => face.id === result.movedFaceId && Math.abs(face.centerMm[2] - 13) < 1e-6), "stepped: movedFaceId is not the upper face");
      const clean = await requireClean("stepped");
      await call(client, "plasticity_undo", { revision: after.revision, intent: "Undo acceptance: stepped" });
      const undone = await status(client);
      requireCondition(undone.undoDepth === before.undoDepth, "stepped: undo did not return to the checkpoint");
      checks.stepped_same_direction = { previousDistanceMm: result.previousDistanceMm, planeOffsetMm: result.planeOffsetMm, movedFaceId: result.movedFaceId, topZ: zs, undoDepth: [before.undoDepth, after.undoDepth, undone.undoDepth], clean };
      console.error(`stepped_same_direction: ok ${JSON.stringify({ zs, previous: result.previousDistanceMm })}`);
    }

    // ---- shared check for pair layouts the box cases do not cover: one Undo step, the reference plane fixed, the
    // moving plane at distanceMm from it (on the side it started), movedFaceId and planeOffsetMm, a clean editor,
    // and undo restores the moving plane.
    const layout = async (label: string, bodyId: number, spec: { moving: any; reference?: any; fixedMm: number; axis: number; distanceMm: number; previousMm: number; expectedMm: number }) => {
      const before = await status(client);
      const result = await call(client, "plasticity_set_driving_distance", {
        bodyId, movingFaceId: spec.moving.id, ...(spec.reference ? { referenceFaceId: spec.reference.id } : {}), distanceMm: spec.distanceMm, revision: before.revision, intent: `Acceptance: ${label}`,
      });
      const after = await status(client);
      requireCondition(after.undoDepth === before.undoDepth + 1 && result.changed === true && result.undoSteps === 1, `${label}: expected one Undo step`);
      requireNear(result.previousDistanceMm, spec.previousMm, `${label}: previousDistanceMm`, 1e-6);
      const faces = (await call(client, "plasticity_body_info", { id: bodyId })).body.faces as any[];
      const normal = spec.moving.normal as Vector;
      const parallel = faces.filter((face) => face.planar && Math.abs(Math.abs(face.normal[spec.axis]) - 1) < 1e-9);
      requireCondition(parallel.some((face) => Math.abs(face.centerMm[spec.axis] - spec.fixedMm) < 1e-6), `${label}: the fixed plane at ${spec.fixedMm} moved`);
      const moved = faces.find((face) => face.id === result.movedFaceId);
      requireCondition(moved && Math.abs(moved.normal[spec.axis] - normal[spec.axis]!) < 1e-9, `${label}: movedFaceId ${String(result.movedFaceId)} is not a face with the moving normal`);
      requireNear(moved.centerMm[spec.axis], spec.expectedMm, `${label}: moved plane`, 1e-6);
      requireNear(Math.abs(moved.centerMm[spec.axis] - spec.fixedMm), spec.distanceMm, `${label}: distance between the planes`, 1e-6);
      requireNear(result.planeOffsetMm, spec.expectedMm * normal[spec.axis]!, `${label}: planeOffsetMm`, 1e-6);
      const clean = await requireClean(label);
      await call(client, "plasticity_undo", { revision: after.revision, intent: `Undo acceptance: ${label}` });
      const undone = await status(client);
      requireCondition(undone.undoDepth === before.undoDepth, `${label}: undo did not return to the checkpoint`);
      const restoredFaces = (await call(client, "plasticity_body_info", { id: bodyId })).body.faces as any[];
      requireCondition(restoredFaces.some((face) => face.planar && Math.abs(face.normal[spec.axis] - normal[spec.axis]!) < 1e-9 && Math.abs(face.centerMm[spec.axis] - spec.moving.centerMm[spec.axis]) < 1e-6), `${label}: undo did not restore the moving plane`);
      checks[label] = { previousDistanceMm: result.previousDistanceMm, movedFaceId: result.movedFaceId, planeOffsetMm: result.planeOffsetMm, movedPlaneMm: moved.centerMm[spec.axis], fixedPlaneMm: spec.fixedMm, undoDepth: [before.undoDepth, after.undoDepth, undone.undoDepth], clean };
      console.error(`${label}: ok ${JSON.stringify({ previous: result.previousDistanceMm, moved: moved.centerMm[spec.axis], fixed: spec.fixedMm })}`);
    };
    const facesOf = async (bodyId: number) => (await call(client, "plasticity_body_info", { id: bodyId })).body.faces as any[];
    const only = (faces: any[], predicate: (face: any) => boolean, label: string) => {
      const matches = faces.filter(predicate);
      requireCondition(matches.length === 1, `${label}: expected one face, found ${matches.length}`);
      return matches[0];
    };

    // ---- reversed stepped pair: the UPPER +z face (z 10) is the reference, the lower +z face (z 5) moves. Live,
    // Plasticity keeps the lower face below the upper one: 5 -> 8 mm puts it at z 2.
    {
      const high = await create("plasticity_create_box", { originMm: [3000, 0, 0], sizeMm: [20, 10, 10] });
      const low = await create("plasticity_create_box", { originMm: [3020, 0, 0], sizeMm: [20, 10, 5] });
      await call(client, "plasticity_boolean", { targetIds: [high.id], toolIds: [low.id], operation: "union", revision: (await status(client)).revision });
      const faces = await facesOf(high.id);
      const upper = only(faces, (face) => face.planar && face.normal[2] > 0.999 && face.centerMm[2] > 9, "reversed stepped: upper +z");
      const lower = only(faces, (face) => face.planar && face.normal[2] > 0.999 && face.centerMm[2] < 6, "reversed stepped: lower +z");
      await layout("stepped_reversed_upper_reference", high.id, { moving: lower, reference: upper, fixedMm: 10, axis: 2, distanceMm: 8, previousMm: 5, expectedMm: 2 });
      // The step-deleted case (probe-pair-layouts.json stepped_reversed_lower_moves_5_to_12_past_zero): the lower face
      // set 12 mm below the upper one would sit at z -2, below the bottom, so Plasticity removes the low part. That is a
      // determinate change: a certain error, and one plasticity_undo restores the body without a reconcile.
      const before = await status(client);
      const bodyBefore = await bodyOf(high.id);
      const facesBefore = await facesOf(high.id);
      const upperNow = only(facesBefore, (face) => face.planar && face.normal[2] > 0.999 && face.centerMm[2] > 9, "step deleted: upper +z");
      const lowerNow = only(facesBefore, (face) => face.planar && face.normal[2] > 0.999 && face.centerMm[2] < 6, "step deleted: lower +z");
      let message = "";
      try {
        await call(client, "plasticity_set_driving_distance", { bodyId: high.id, movingFaceId: lowerNow.id, referenceFaceId: upperNow.id, distanceMm: 12, revision: before.revision, intent: "Acceptance: step deleted" });
      } catch (error) { message = error instanceof Error ? error.message : String(error); }
      const after = await status(client);
      requireCondition(after.undoDepth === before.undoDepth + 1, `step deleted: expected one Undo step, got ${after.undoDepth - before.undoDepth}`);
      requireCondition(/^Driving distance committed one Undo step, but the read-back does not match: /.test(message), `step deleted: expected a committed-mismatch error, got "${message.slice(0, 300)}"`);
      requireCondition(message.includes(`the moving face ${high.id}:${lowerNow.id} was removed`), `step deleted: the error must name the removed face ${high.id}:${lowerNow.id}, got "${message.slice(0, 400)}"`);
      requireCondition(message.includes(`The document is in a known state at revision ${after.revision}: one Undo step was added, and plasticity_undo restores the previous geometry`), `step deleted: the error must name revision ${after.revision} and the Undo step, got "${message.slice(0, 600)}"`);
      requireCondition(!/uncertain|plasticity_reconcile/.test(message), `step deleted: the error must be certain, got "${message.slice(0, 300)}"`);
      // No reconcile: the undo is accepted only while the session is certain.
      await call(client, "plasticity_undo", { revision: after.revision, intent: "Undo acceptance: step deleted" });
      const undone = await status(client);
      requireCondition(undone.undoDepth === before.undoDepth, "step deleted: one undo did not return to the checkpoint");
      const bodyUndone = await bodyOf(high.id);
      requireCondition(JSON.stringify(bodyUndone.boundsMm) === JSON.stringify(bodyBefore.boundsMm), `step deleted: undo did not restore the bounds ${JSON.stringify(bodyBefore.boundsMm)}, got ${JSON.stringify(bodyUndone.boundsMm)}`);
      const facesUndone = await facesOf(high.id);
      requireCondition(facesUndone.length === facesBefore.length, `step deleted: undo restored ${facesUndone.length} faces, expected ${facesBefore.length}`);
      requireCondition(facesUndone.some((face) => face.planar && face.normal[2] > 0.999 && Math.abs(face.centerMm[2] - 5) < 1e-6), "step deleted: undo did not restore the lower +z face at z 5");
      checks.step_deleted_certain_mismatch = { message: message.slice(0, 600), undoDepth: [before.undoDepth, after.undoDepth, undone.undoDepth], boundsBefore: bodyBefore.boundsMm, boundsUndone: bodyUndone.boundsMm, clean: await requireClean("step deleted") };
      console.error("step_deleted_certain_mismatch: ok");
    }

    // ---- slot walls that face each other: a 40 x 20 x 10 block with a 10 mm slot (x 3115..3125) 5 mm deep. The
    // -x wall at x 3125 moves, the +x wall at x 3115 stays: width 10 -> 14 mm puts the moving wall at x 3129.
    {
      const block = await create("plasticity_create_box", { originMm: [3100, 0, 0], sizeMm: [40, 20, 10] });
      const cutter = await create("plasticity_create_box", { originMm: [3115, -1, 5], sizeMm: [10, 22, 6] });
      await call(client, "plasticity_boolean", { targetIds: [block.id], toolIds: [cutter.id], operation: "difference", revision: (await status(client)).revision });
      const faces = await facesOf(block.id);
      const left = only(faces, (face) => face.planar && face.normal[0] > 0.999 && Math.abs(face.centerMm[0] - 3115) < 1e-6, "slot: +x wall");
      const right = only(faces, (face) => face.planar && face.normal[0] < -0.999 && Math.abs(face.centerMm[0] - 3125) < 1e-6, "slot: -x wall");
      await layout("slot_walls_width", block.id, { moving: right, reference: left, fixedMm: 3115, axis: 0, distanceMm: 14, previousMm: 10, expectedMm: 3129 });
      // Single-face mode on a slot wall: Plasticity finds the facing wall itself.
      await layout("slot_wall_single_face", block.id, { moving: right, fixedMm: 3115, axis: 0, distanceMm: 12, previousMm: 10, expectedMm: 3127 });
    }

    // ---- island inside a ring-shaped coplanar face (review follow-up): a 60 x 60 x 10 block with a 20 x 20 pocket
    // (x 3320..3340, y 20..40) whose floor is at z 3, and a 10 x 10 pad (x 3325..3335, y 25..35) standing on that floor
    // up to z 10. Its top is coplanar with the surrounding ring-shaped top face, whose bounds box covers the pad. The pad's
    // top moves to 14 mm above the bottom by driving distance: a correct edit that a bounds box used to report as "the moving
    // face is still at 10 mm over its footprint, undo". It must succeed (verified, or ambiguous with a note naming the ring).
    // The independent read is the body's face list after the edit, not the tool's own reply.
    {
      const block = await create("plasticity_create_box", { originMm: [3300, 0, 0], sizeMm: [60, 60, 10] });
      const pocket = await create("plasticity_create_box", { originMm: [3320, 20, 3], sizeMm: [20, 20, 8] });
      await call(client, "plasticity_boolean", { targetIds: [block.id], toolIds: [pocket.id], operation: "difference", revision: (await status(client)).revision });
      const pad = await create("plasticity_create_box", { originMm: [3325, 25, 2], sizeMm: [10, 10, 8] });
      await call(client, "plasticity_boolean", { targetIds: [block.id], toolIds: [pad.id], operation: "union", revision: (await status(client)).revision });
      const faces = await facesOf(block.id);
      const tops = faces.filter((face) => face.planar && face.normal[2] > 0.999 && Math.abs(face.centerMm[2] - 10) < 1e-6);
      // Face bounds come from the float32 display mesh: extents match to about 1e-4 mm, so these checks use 0.01 mm slack.
      requireCondition(tops.length === 2, `island: expected the ring face and the island top at z 10, found ${tops.length}`);
      const extent = (face: any) => (face.boundsMm.max[0] - face.boundsMm.min[0]) * (face.boundsMm.max[1] - face.boundsMm.min[1]);
      const [island, ring] = [...tops].sort((left, right) => extent(left) - extent(right));
      requireNear(extent(island), 100, "island: the island top is 10 x 10", 0.05);
      requireNear(extent(ring), 3600, "island: the ring face's bounds cover the whole block top", 0.5);
      const bottom = only(faces, (face) => face.planar && face.normal[2] < -0.999 && Math.abs(face.centerMm[2]) < 1e-6, "island: bottom face");
      const before = await status(client);
      const result = await call(client, "plasticity_set_driving_distance", {
        bodyId: block.id, movingFaceId: island.id, referenceFaceId: bottom.id, distanceMm: 14, revision: before.revision, intent: "Acceptance: island in a ring-shaped coplanar face",
      });
      const after = await status(client);
      requireCondition(after.undoDepth === before.undoDepth + 1 && result.changed === true && result.undoSteps === 1, "island: expected one Undo step and a success");
      requireCondition(result.verification === undefined || result.verification === "ambiguous", `island: unexpected verification ${String(result.verification)}`);
      if (result.verification === "ambiguous") requireCondition(/another coplanar face overlaps the footprint \(.+\); could not prove which face moved/.test(result.note ?? ""), `island: an ambiguous result must carry the sibling note, got "${String(result.note)}"`);
      // Independent read-back of the geometry.
      const facesAfter = await facesOf(block.id);
      const topsAfter = facesAfter.filter((face) => face.planar && face.normal[2] > 0.999).sort((left, right) => left.centerMm[2] - right.centerMm[2]);
      const ringNow = topsAfter.filter((face) => Math.abs(face.centerMm[2] - 10) < 1e-6);
      const islandNow = topsAfter.filter((face) => Math.abs(face.centerMm[2] - 14) < 1e-6);
      requireCondition(ringNow.length === 1 && extent(ringNow[0]) > 3000, "island: the ring face stays at z 10");
      requireCondition(islandNow.length === 1, `island: expected one top at z 14, found ${islandNow.length}`);
      requireNear(extent(islandNow[0]), 100, "island: the raised top is still 10 x 10", 0.05);
      requireNear(islandNow[0].boundsMm.min[0], 3325, "island: raised top x min", 0.01);
      requireNear(islandNow[0].boundsMm.max[1], 35, "island: raised top y max", 0.01);
      requireCondition(facesAfter.some((face) => face.planar && face.normal[2] < -0.999 && Math.abs(face.centerMm[2]) < 1e-6), "island: the bottom stays at z 0");
      requireNear((await bodyOf(block.id)).boundsMm.max[2], 14, "island: the body is 14 mm tall", 0.01);
      requireCondition(result.movedFaceId === islandNow[0].id, `island: movedFaceId ${String(result.movedFaceId)} is not the raised top ${islandNow[0].id}`);
      requireNear(result.planeOffsetMm, 14, "island: planeOffsetMm", 0.01);
      const clean = await requireClean("island");
      await call(client, "plasticity_undo", { revision: after.revision, intent: "Undo acceptance: island" });
      const undone = await status(client);
      requireCondition(undone.undoDepth === before.undoDepth, "island: undo did not return to the checkpoint");
      requireNear((await bodyOf(block.id)).boundsMm.max[2], 10, "island: undo restores the 10 mm height", 0.01);
      checks.island_in_ring_coplanar = { verification: result.verification ?? "verified", note: result.note ?? null, movedFaceId: result.movedFaceId, planeOffsetMm: result.planeOffsetMm, ringTopAfterMm: ringNow[0].centerMm[2], islandTopAfterMm: islandNow[0].centerMm[2], undoDepth: [before.undoDepth, after.undoDepth, undone.undoDepth], clean };
      console.error(`island_in_ring_coplanar: ok ${JSON.stringify({ verification: result.verification ?? "verified", note: result.note ?? null })}`);
    }

    // ---- single-face mode where the surface behind the face is not a parallel plane: the flat face of a half
    // cylinder (r 10) has the cylinder behind it. Plasticity rejects it cleanly: no effect, no Undo entry.
    {
      const cylinder = await create("plasticity_create_cylinder", { centerMm: [3200, 0, 0], radiusMm: 10, heightMm: 10 });
      const cutter = await create("plasticity_create_box", { originMm: [3185, -15, -1], sizeMm: [15, 30, 12] });
      await call(client, "plasticity_boolean", { targetIds: [cylinder.id], toolIds: [cutter.id], operation: "difference", revision: (await status(client)).revision });
      const flat = only(await facesOf(cylinder.id), (face) => face.planar && face.normal[0] < -0.999, "half cylinder: flat face");
      const before = await status(client);
      let message = "";
      try {
        await call(client, "plasticity_set_driving_distance", { bodyId: cylinder.id, movingFaceId: flat.id, distanceMm: 6, revision: before.revision, intent: "Acceptance: non-parallel single face" });
      } catch (error) { message = error instanceof Error ? error.message : String(error); }
      requireCondition(/Plasticity could not dimension these faces \(no effect\)/.test(message), `half cylinder: expected a clean rejection, got "${message.slice(0, 200)}"`);
      const after = await status(client);
      requireCondition(after.undoDepth === before.undoDepth && after.revision === before.revision, "half cylinder: the rejection changed the document");
      checks.non_parallel_single_face_rejected = { message: message.slice(0, 300), undoDepth: [before.undoDepth, after.undoDepth], clean: await requireClean("half cylinder") };
      console.error("non_parallel_single_face_rejected: ok");
    }

    // ---- non-parallel pair: rejected before any native call, no Undo entry, clean editor
    {
      const before = await status(client);
      const moving = await faceWithNormal(box.id, [1, 0, 0]);
      const reference = await faceWithNormal(box.id, [0, 1, 0]);
      let message = "";
      try {
        await call(client, "plasticity_set_driving_distance", { bodyId: box.id, movingFaceId: moving.id, referenceFaceId: reference.id, distanceMm: 30, revision: before.revision });
      } catch (error) { message = error instanceof Error ? error.message : String(error); }
      requireCondition(/must be parallel planes/.test(message), `non-parallel pair: expected a rejection, got "${message.slice(0, 200)}"`);
      const after = await status(client);
      requireCondition(after.undoDepth === before.undoDepth && after.revision === before.revision, "non-parallel pair: a rejected call changed the document");
      checks.non_parallel_rejected = { message: message.slice(0, 300), undoDepth: [before.undoDepth, after.undoDepth], clean: await requireClean("non-parallel pair") };
      console.error("non_parallel_rejected: ok");
    }

    // ---- Plasticity itself rejects: a chamfer face has no parallel opposite face, so the Dimension command ends
    // without its dialog. The tool reports no effect, adds no Undo entry and leaves the editor clean.
    {
      const chamfered = await create("plasticity_create_box", { originMm: [2700, 0, 0], sizeMm: [20, 10, 5] });
      const current = await status(client);
      const edges = await call(client, "plasticity_find_edges", { revision: current.revision, query: {
        bodyIds: [chamfered.id], line: true, direction: { vector: [0, 1, 0] }, center: { pointMm: [2720, 5, 5], toleranceMm: 0.01 },
      } });
      requireCondition(edges.count === 1, `chamfer edge: expected one edge, found ${edges.count}`);
      await call(client, "plasticity_chamfer", { id: chamfered.id, edgeIds: [edges.matches[0].id], distanceMm: 2, revision: current.revision });
      const before = await status(client);
      const slopes = await call(client, "plasticity_find_faces", { revision: before.revision, query: {
        bodyIds: [chamfered.id], planar: true, normal: { vector: [Math.SQRT1_2, 0, Math.SQRT1_2], toleranceDeg: 0.1 },
      } });
      requireCondition(slopes.count === 1, `chamfer face: expected one face, found ${slopes.count}`);
      let message = "";
      try {
        await call(client, "plasticity_set_driving_distance", { bodyId: chamfered.id, movingFaceId: slopes.matches[0].id, distanceMm: 7, revision: before.revision });
      } catch (error) { message = error instanceof Error ? error.message : String(error); }
      requireCondition(/Plasticity could not dimension these faces \(no effect\)/.test(message), `native rejection: expected no effect, got "${message.slice(0, 200)}"`);
      const after = await status(client);
      requireCondition(after.undoDepth === before.undoDepth && after.revision === before.revision, "native rejection: the document changed");
      checks.native_rejection = { message: message.slice(0, 300), undoDepth: [before.undoDepth, after.undoDepth], clean: await requireClean("native rejection") };
      console.error("native_rejection: ok");
      // The next call must still work: the runtime stayed certain.
      await drive("after_rejection_box_x", chamfered.id, { moving: [-1, 0, 0], reference: [1, 0, 0], fixed: [1, 0, 0], distanceMm: 25, previousMm: 20 });
    }

    // ---- one plasticity_batch: create a box and set a driving distance in one call
    {
      const before = await status(client);
      const batch = await call(client, "plasticity_batch", { steps: [
        { toolName: "plasticity_create_box", arguments: { originMm: [2600, 0, 0], sizeMm: [20, 10, 5] } },
        { toolName: "plasticity_find_faces", arguments: { query: { bodyIds: ["$0.added[0]"], planar: true, normal: { vector: [1, 0, 0], toleranceDeg: 0.01 } } } },
        { toolName: "plasticity_find_faces", arguments: { query: { bodyIds: ["$0.added[0]"], planar: true, normal: { vector: [-1, 0, 0], toleranceDeg: 0.01 } } } },
        { toolName: "plasticity_set_driving_distance", arguments: { bodyId: "$0.added[0]", movingFaceId: "$1.result.matches[0].id", referenceFaceId: "$2.result.matches[0].id", distanceMm: 30, intent: "Acceptance: batch" } },
      ] });
      const after = await status(client);
      requireCondition(batch.undoSteps === 2 && after.undoDepth === before.undoDepth + 2, `batch: expected 2 Undo steps, got ${batch.undoSteps}`);
      const created = after.bodies.filter((body: { id: number }) => !before.bodies.some((old: { id: number }) => old.id === body.id));
      requireCondition(created.length === 1, "batch: expected one new body");
      requireNear(created[0].boundsMm.min[0], 2600, "batch: -x plane fixed", 1e-6);
      requireNear(created[0].boundsMm.max[0], 2630, "batch: +x plane at 30 mm", 1e-6);
      const clean = await requireClean("batch");
      await call(client, "plasticity_undo", { revision: after.revision, intent: "Undo acceptance: batch driving distance" });
      const undone = await status(client);
      requireCondition(undone.undoDepth === before.undoDepth + 1, "batch: one undo should leave the created box");
      requireNear(undone.bodies.find((body: { id: number }) => body.id === created[0].id).boundsMm.max[0], 2620, "batch: undo restores 20 mm", 1e-6);
      checks.batch = { undoSteps: batch.undoSteps, boundsAfter: created[0].boundsMm, undoDepth: [before.undoDepth, after.undoDepth, undone.undoDepth], clean };
      console.error("batch: ok");
    }

    // ---- restore the baseline
    await undoTo(client, baseline.undoDepth);
    const restored = await status(client);
    const nativeRestored = await pickState();
    evidence.checks = checks;
    evidence.restored = { ...summary(restored), native: nativeRestored };
    requireCondition(restored.documentToken === baseline.documentToken, "The document changed during acceptance");
    requireCondition(restored.undoDepth === baseline.undoDepth, `Undo depth is ${restored.undoDepth}, baseline was ${baseline.undoDepth}`);
    requireCondition(restored.bodies.length === baseline.bodies.length, `Body count is ${restored.bodies.length}, baseline was ${baseline.bodies.length}`);
    requireCondition(JSON.stringify(restored.bodies.map((body: { id: number }) => body.id)) === JSON.stringify(baseline.bodies.map((body: { id: number }) => body.id)), "Undo did not restore the baseline bodies");
    requireCondition(nativeRestored.undoDepth === nativeBaseline.undoDepth && nativeRestored.bodies === nativeBaseline.bodies, "Native undo depth or body count differs from the baseline");
    await requireClean("restored");
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
    native?.close();
  }
}

async function startMcp(endpoint: string, output: string, stderr: string[]): Promise<LiveMcp> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "scripts", "run-server.ts")],
    cwd: projectRoot,
    env: {
      PLASTICITY_MCP_STATE_DIR: join(output, "state"),
      PLASTICITY_CONSTRUCTION_HISTORY_ROOT: join(output, "history"),
      ...selectedEnvironment(process.env),
      PLASTICITY_CDP_URL: endpoint, PLASTICITY_AUTO_LAUNCH: "0", PLASTICITY_HUD: "0",
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-driving-distance-live", version: "1.0.0" });
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

async function undoTo(client: Client, depth: number): Promise<void> {
  for (let count = 0; count < 40; count += 1) {
    const current = await status(client);
    if (current.undoDepth <= depth) return;
    await call(client, "plasticity_undo", { intent: "Return to the acceptance baseline", revision: current.revision });
  }
  throw new Error(`Undo did not reach the baseline ${depth}`);
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
    if (current.undoDepth <= initial.undoDepth) return { restored: current.bodies.length === initial.bodies.length, undoDepth: current.undoDepth, bodyCount: current.bodies.length };
    await call(client, "plasticity_undo", { intent: "Recover driving-distance acceptance", revision: current.revision });
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
