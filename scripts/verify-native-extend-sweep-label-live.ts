#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface ExtendSweepLabelOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }
type Bounds = { min: number[]; max: number[] };

export function parseExtendSweepLabelArgs(argv: string[]): ExtendSweepLabelOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: ExtendSweepLabelOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live extend/sweep/label acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live extend/sweep/label acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live extend/sweep/label acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-extend-sweep-label-live.ts --help
  node scripts/verify-native-extend-sweep-label-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
PLASTICITY_CDP_URL is mandatory: set it to the isolated Plasticity instance. The command never launches Plasticity
(it forces PLASTICITY_AUTO_LAUNCH=0 and PLASTICITY_HUD=0) and refuses to start without the variable.
Live mode takes a baseline, then builds disposable geometry at x >= 1990 mm and checks, by reading
bounds, topology and measurements back through plasticity_status and plasticity_list_measurements:
  - plasticity_extend_sheet_edges: shape linear, soft, natural and reflective, merge=false, targetId.
  - plasticity_sweep_curves: open arc, closed circle, arc plus circle on one spine (two Sheets), guide rail, twistDegrees and scale.
  - plasticity_sweep_regions with a guide rail.
  - plasticity_move_measurement_label: X-, Y- and Z-direction measurements, two offsets each within 0.01 mm, the measurement name survives.
It undoes back to the baseline Undo depth and body count and never saves the document.
Run it only against an isolated Plasticity instance.`;

async function main(): Promise<void> {
  const options = parseExtendSweepLabelArgs(process.argv.slice(2));
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
    baseline = await status(client);
    evidence.baseline = summary(baseline);
    const baselineMeasurements = (await call(client, "plasticity_list_measurements", {})).measurements.length;
    baseline.measurementCount = baselineMeasurements;
    const known = new Set<number>(baseline.bodies.map((body: { id: number }) => body.id));
    const checks: Record<string, unknown> = {};

    // Adds geometry with one tool call and returns the bodies that appeared.
    const add = async (tool: string, args: Record<string, unknown>): Promise<any[]> => {
      const before = await status(client);
      await call(client, tool, { ...args, revision: before.revision });
      const after = await status(client);
      const added = after.bodies.filter((body: { id: number }) => !known.has(body.id));
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
    const mutate = async (tool: string, args: Record<string, unknown>): Promise<any> => {
      const before = await status(client);
      await call(client, tool, { ...args, revision: before.revision });
      return await status(client);
    };
    const rejects = async (tool: string, args: Record<string, unknown>, pattern: RegExp, label: string): Promise<void> => {
      const before = await status(client);
      let message = "";
      try { await call(client, tool, { ...args, revision: before.revision }); } catch (error) { message = error instanceof Error ? error.message : String(error); }
      requireCondition(pattern.test(message), `${label}: expected rejection ${String(pattern)}, got "${message.slice(0, 200)}"`);
      const after = await status(client);
      requireCondition(after.undoDepth === before.undoDepth, `${label}: a rejected call changed the Undo history`);
    };

    // ---- plasticity_extend_sheet_edges (FINDINGS gap 3)
    const [arch] = await add("plasticity_create_nurbs_curve", { pointsMm: [[2500, 0, 0], [2520, 0, 10], [2540, 0, 0]] });
    requireCondition(arch?.type === "Wire", "The arch Wire was not created");
    const sheetAdded = await add("plasticity_extrude_curves", { ids: [arch.id], distanceMm: 20, direction: [0, 1, 0] });
    const sheet = sheetAdded.find((body: { type: string }) => body.type === "Sheet");
    requireCondition(sheet, "The arch Sheet was not created");
    const [targetBox] = await add("plasticity_create_box", { originMm: [2555, -5, -30], sizeMm: [10, 30, 40], name: "Extend target" });
    const sheetInfo = await call(client, "plasticity_body_info", { id: sheet.id });
    const endEdge = (sheetInfo.body.edges as any[]).find((edge) => edge.faceIds.length === 1 && edge.curveType === "Line"
      && Math.abs(edge.boundsMm.min[0] - 2540) < 0.05 && Math.abs(edge.boundsMm.max[0] - 2540) < 0.05);
    requireCondition(endEdge, "The straight end edge of the arch Sheet was not found");
    const extendCheckpoint = (await status(client)).undoDepth;
    const resultSheet = (current: any) => {
      const sheets = current.bodies.filter((body: any) => body.type === "Sheet" && body.boundsMm && body.boundsMm.min[0] > 2400 && body.boundsMm.min[0] < 2600 && body.boundsMm.max[1] < 100);
      requireCondition(sheets.length >= 1, "No arch Sheet found after the extension");
      return sheets;
    };
    const extendVariant = async (label: string, args: Record<string, unknown>): Promise<any> => {
      const current = await mutate("plasticity_extend_sheet_edges", { id: sheet.id, edgeIds: [endEdge.id], ...args });
      const sheets = resultSheet(current);
      const body = sheets.reduce((best: any, candidate: any) => candidate.boundsMm.max[0] > best.boundsMm.max[0] ? candidate : best);
      const entry = { maxX: body.boundsMm.max[0], minZ: body.boundsMm.min[2], faces: body.faceCount, edges: body.edgeCount, sheetCount: sheets.length };
      checks[`extend_${label}`] = entry;
      requireCondition(current.undoDepth === extendCheckpoint + 1, `${label}: the extension must add exactly one Undo entry`);
      await undoTo(extendCheckpoint);
      return entry;
    };
    const linear = await extendVariant("linear", { distanceMm: 10, shape: "linear" });
    requireNear(linear.maxX, 2547.07, "Linear max x");
    const plain = await extendVariant("default", { distanceMm: 10 });
    requireCondition(plain.maxX === linear.maxX && plain.minZ === linear.minZ, "The default extension differs from shape linear");
    requireNear((await extendVariant("soft", { distanceMm: 10, shape: "soft" })).maxX, 2546.77, "Soft max x");
    requireNear((await extendVariant("natural", { distanceMm: 10, shape: "natural" })).maxX, 2546.51, "Natural max x");
    requireNear((await extendVariant("reflective", { distanceMm: 10, shape: "reflective" })).maxX, 2546.26, "Reflective max x");
    const separate = await extendVariant("merge_false", { distanceMm: 10, merge: false });
    requireCondition(separate.faces === 2 && separate.edges === 7, `merge=false must leave a separate face (2F/7E), got ${separate.faces}F/${separate.edges}E`);
    const merged = await extendVariant("merge_true", { distanceMm: 10, merge: true });
    requireCondition(merged.faces === 1, `merge=true must merge the extension into one face, got ${merged.faces}F`);
    const targeted = await extendVariant("target", { targetId: targetBox.id });
    requireNear(targeted.maxX, 2555, "Target max x");
    await rejects("plasticity_extend_sheet_edges", { id: sheet.id, edgeIds: [endEdge.id], distanceMm: 10, targetId: targetBox.id }, /exactly one/i, "distance and target together");
    await rejects("plasticity_extend_sheet_edges", { id: sheet.id, edgeIds: [endEdge.id] }, /exactly one/i, "neither distance nor target");
    await rejects("plasticity_extend_sheet_edges", { id: sheet.id, edgeIds: [endEdge.id], distanceMm: 10, shape: "arc" }, /shape/i, "arc shape");
    requireCondition((await status(client)).undoDepth === extendCheckpoint, "The extension checks left Undo entries behind");

    // ---- plasticity_sweep_curves and guides (FINDINGS gap 1)
    const [spine] = await add("plasticity_create_polyline", { pointsMm: [[2000, 0, 0], [2000, 0, 60]], closed: false });
    const [arc] = await add("plasticity_create_three_point_arc", { startMm: [1990, 0, 0], throughMm: [2000, 10, 0], endMm: [2010, 0, 0] });
    const [circle] = await add("plasticity_create_circle", { centerMm: [2000, 0, 0], radiusMm: 5, normal: [0, 0, 1] });
    const [rail] = await add("plasticity_create_polyline", { pointsMm: [[2005, 0, 0], [2015, 0, 60]], closed: false });
    const regions = await call(client, "plasticity_list_regions", {});
    const circleRegion = (regions.regions ?? regions).find((region: any) => Math.abs(region.displayBoundsMm.min[0] - 1995) < 0.01 && Math.abs(region.displayBoundsMm.max[1] - 5) < 0.01);
    requireCondition(circleRegion, "The circle Region was not found");
    const sweepCheckpoint = (await status(client)).undoDepth;
    const sweepVariant = async (label: string, tool: string, args: Record<string, unknown>, type: "Sheet" | "Solid"): Promise<any> => {
      const current = await mutate(tool, args);
      const created = current.bodies.filter((body: any) => !known.has(body.id));
      requireCondition(created.length === 1 && created[0].type === type, `${label}: expected one new ${type}, got ${created.map((body: any) => body.type).join(",")}`);
      const body = created[0];
      const entry = { type: body.type, boundsMm: body.boundsMm, faces: body.faceCount, edges: body.edgeCount, vertices: body.vertexCount };
      checks[`sweep_${label}`] = entry;
      requireCondition(current.undoDepth === sweepCheckpoint + 1, `${label}: the sweep must add exactly one Undo entry`);
      await undoTo(sweepCheckpoint);
      return entry;
    };
    const openArc = await sweepVariant("open_arc", "plasticity_sweep_curves", { profileIds: [arc.id], spineId: spine.id }, "Sheet");
    requireBounds(openArc.boundsMm, [1990, 0, 0], [2010, 10, 60], "Open arc sweep bounds");
    requireCondition(openArc.faces === 1 && openArc.edges === 4 && openArc.vertices === 4, `Open arc sweep must be 1F/4E/4V, got ${openArc.faces}F/${openArc.edges}E/${openArc.vertices}V`);
    const closedCircle = await sweepVariant("closed_circle", "plasticity_sweep_curves", { profileIds: [circle.id], spineId: spine.id }, "Sheet");
    requireBounds(closedCircle.boundsMm, [1995, -5, 0], [2005, 5, 60], "Closed circle sweep bounds");
    // Several profiles on one spine: live probe (2026-11) showed one Sheet per profile from a single command.
    {
      const before = await status(client);
      await call(client, "plasticity_sweep_curves", { profileIds: [arc.id, circle.id], spineId: spine.id, revision: before.revision });
      const after = await status(client);
      const sheets = after.bodies.filter((body: any) => !known.has(body.id));
      requireCondition(sheets.length === 2 && sheets.every((body: any) => body.type === "Sheet"), `Multi-profile sweep: expected two new Sheets, got ${sheets.map((body: any) => body.type).join(",")}`);
      requireCondition(after.undoDepth === sweepCheckpoint + 1, "The multi-profile sweep must add exactly one Undo entry");
      const widths = sheets.map((body: any) => Math.round(body.boundsMm.max[0] - body.boundsMm.min[0])).sort((left: number, right: number) => left - right);
      requireCondition(widths[0] === 10 && widths[1] === 20, `Multi-profile sweep widths must be 10 (circle) and 20 (arc), got ${widths}`);
      checks.sweep_multi_profile = sheets.map((body: any) => ({ type: body.type, boundsMm: body.boundsMm, faces: body.faceCount }));
      await undoTo(sweepCheckpoint);
    }
    const regionPlain = await sweepVariant("region_no_guide", "plasticity_sweep_regions", { regionIds: [circleRegion.id], spineId: spine.id }, "Solid");
    requireNear(regionPlain.boundsMm.max[0], 2005, "Region sweep max x without a guide");
    const regionRail = await sweepVariant("region_rail", "plasticity_sweep_regions", { regionIds: [circleRegion.id], spineId: spine.id, guideIds: [rail.id], guideMethod: "curve" }, "Solid");
    requireNear(regionRail.boundsMm.max[0], 2015, "Region sweep max x with a rail");
    for (const method of ["point", "chord"]) {
      const variant = await sweepVariant(`region_rail_${method}`, "plasticity_sweep_regions", { regionIds: [circleRegion.id], spineId: spine.id, guideIds: [rail.id], guideMethod: method }, "Solid");
      requireNear(variant.boundsMm.max[0], 2015, `Region sweep max x with a ${method} rail`);
    }
    const regionRailDefault = await sweepVariant("region_rail_default_method", "plasticity_sweep_regions", { regionIds: [circleRegion.id], spineId: spine.id, guideIds: [rail.id] }, "Solid");
    requireNear(regionRailDefault.boundsMm.max[0], 2015, "Region sweep max x with a rail and the default method");
    const arcRail = await sweepVariant("open_arc_rail", "plasticity_sweep_curves", { profileIds: [arc.id], spineId: spine.id, guideIds: [rail.id], guideMethod: "curve" }, "Sheet");
    requireNear(arcRail.boundsMm.max[0], 2020, "Open arc sweep max x with a rail");
    const twisted = await sweepVariant("open_arc_twist", "plasticity_sweep_curves", { profileIds: [arc.id], spineId: spine.id, twistDegrees: 90 }, "Sheet");
    requireCondition(!boundsEqual(twisted.boundsMm, openArc.boundsMm), "twistDegrees had no visible effect on the sweep bounds");
    const scaled = await sweepVariant("open_arc_scale", "plasticity_sweep_curves", { profileIds: [arc.id], spineId: spine.id, scale: 2 }, "Sheet");
    requireCondition(!boundsEqual(scaled.boundsMm, openArc.boundsMm), "scale had no visible effect on the sweep bounds");
    await rejects("plasticity_sweep_curves", { profileIds: [arc.id], spineId: spine.id, guideMethod: "curve" }, /guide/i, "guide method without guides");
    await rejects("plasticity_sweep_curves", { profileIds: [arc.id], spineId: arc.id }, /spine/i, "spine as profile");
    requireCondition((await status(client)).undoDepth === sweepCheckpoint, "The sweep checks left Undo entries behind");

    // ---- plasticity_move_measurement_label (FINDINGS gap 4)
    const [labelBox] = await add("plasticity_create_box", { originMm: [2800, 0, 0], sizeMm: [20, 10, 5], name: "Label box" });
    const boxInfo = await call(client, "plasticity_body_info", { id: labelBox.id });
    const vertexAt = (x: number, y: number, z: number) => (boxInfo.body.vertices as any[]).find((vertex) => Math.abs(vertex.positionMm[0] - x) < 0.01 && Math.abs(vertex.positionMm[1] - y) < 0.01 && Math.abs(vertex.positionMm[2] - z) < 0.01);
    const v0 = vertexAt(2800, 0, 0);
    const v1 = vertexAt(2820, 0, 0);
    const v2 = vertexAt(2820, 10, 5);
    requireCondition(v0 && v1 && v2, "Box vertices were not found");
    const measurementName = "label-move-check";
    await mutate("plasticity_create_vertex_distance_measurement", { first: { bodyId: labelBox.id, vertexId: v0.id }, second: { bodyId: labelBox.id, vertexId: v1.id }, name: measurementName });
    const findMeasurement = async (name: string) => {
      const list = await call(client, "plasticity_list_measurements", {});
      return list.measurements.find((measurement: { name: string | null }) => measurement.name === name);
    };
    const created = await findMeasurement(measurementName);
    requireCondition(created, "The named measurement was not created");
    const labelCheckpoint = (await status(client)).undoDepth;
    const offsets: Array<[number, number]> = [[10, -10], [0, 5]];
    const moves: unknown[] = [];
    let previousVersion = created.versionId;
    for (const offset of offsets) {
      await mutate("plasticity_move_measurement_label", { id: created.id, offsetMm: offset });
      const moved = (await call(client, "plasticity_list_measurements", {})).measurements.find((measurement: { id: number }) => measurement.id === created.id);
      requireCondition(moved, `The measurement disappeared after moving its label to ${offset}`);
      requireCondition(moved.name === measurementName, `The measurement lost its name after moving its label to ${offset}`);
      requireNear(moved.offsetMm[0], offset[0], `Label along offset ${offset}`, 0.01);
      requireNear(moved.offsetMm[1], offset[1], `Label perpendicular offset ${offset}`, 0.01);
      requireCondition(moved.versionId > previousVersion, "The measurement version did not advance");
      previousVersion = moved.versionId;
      moves.push({ requested: offset, offsetMm: moved.offsetMm, name: moved.name, versionId: moved.versionId });
    }
    checks.label_moves = moves;
    requireCondition((await status(client)).undoDepth === labelCheckpoint + offsets.length, "Each label move must add exactly one Undo entry");
    // A measurement that is not axis aligned checks the local frame on a second direction.
    await mutate("plasticity_create_vertex_distance_measurement", { first: { bodyId: labelBox.id, vertexId: v0.id }, second: { bodyId: labelBox.id, vertexId: v2.id }, name: "label-move-diagonal" });
    const diagonal = await findMeasurement("label-move-diagonal");
    requireCondition(diagonal, "The diagonal measurement was not created");
    await mutate("plasticity_move_measurement_label", { id: diagonal.id, offsetMm: [3, 4] });
    const movedDiagonal = (await call(client, "plasticity_list_measurements", {})).measurements.find((measurement: { id: number }) => measurement.id === diagonal.id);
    requireNear(movedDiagonal.offsetMm[0], 3, "Diagonal label along offset");
    requireNear(movedDiagonal.offsetMm[1], 4, "Diagonal label perpendicular offset");
    requireCondition(movedDiagonal.name === "label-move-diagonal", "The diagonal measurement lost its name");
    checks.label_diagonal = { direction: movedDiagonal.direction, normal: movedDiagonal.normal, offsetMm: movedDiagonal.offsetMm, name: movedDiagonal.name };
    // Y- and Z-direction measurements: the label offset must round-trip on every axis the dimension can lie along.
    const axisChecks: Record<string, unknown> = {};
    for (const [axisName, endpoint] of [["y", [2800, 10, 0]], ["z", [2800, 0, 5]]] as Array<[string, number[]]>) {
      const endVertex = vertexAt(endpoint[0]!, endpoint[1]!, endpoint[2]!);
      requireCondition(endVertex, `The ${axisName} measurement end vertex was not found`);
      const axisMeasurementName = `label-move-${axisName}`;
      await mutate("plasticity_create_vertex_distance_measurement", { first: { bodyId: labelBox.id, vertexId: v0.id }, second: { bodyId: labelBox.id, vertexId: endVertex.id }, name: axisMeasurementName });
      const axisMeasurement = await findMeasurement(axisMeasurementName);
      requireCondition(axisMeasurement, `The ${axisName} measurement was not created`);
      const axisMoves: unknown[] = [];
      for (const offset of [[0, 5], [3, 4]] as Array<[number, number]>) {
        await mutate("plasticity_move_measurement_label", { id: axisMeasurement.id, offsetMm: offset });
        const movedAxis = (await call(client, "plasticity_list_measurements", {})).measurements.find((measurement: { id: number }) => measurement.id === axisMeasurement.id);
        requireCondition(movedAxis && movedAxis.name === axisMeasurementName, `The ${axisName} measurement lost its name after the label move`);
        requireNear(movedAxis.offsetMm[0], offset[0], `${axisName}-direction label along offset ${offset}`, 0.01);
        requireNear(movedAxis.offsetMm[1], offset[1], `${axisName}-direction label perpendicular offset ${offset}`, 0.01);
        axisMoves.push({ requested: offset, offsetMm: movedAxis.offsetMm, direction: movedAxis.direction, normal: movedAxis.normal });
      }
      axisChecks[axisName] = axisMoves;
    }
    checks.label_axes = axisChecks;
    await rejects("plasticity_move_measurement_label", { id: 999999, offsetMm: [0, 0] }, /unknown/i, "unknown measurement");

    // ---- restore the baseline
    await undoTo(baseline.undoDepth);
    const restored = await status(client);
    evidence.checks = checks;
    evidence.restored = summary(restored);
    requireCondition(restored.documentToken === baseline.documentToken, "The document changed during acceptance");
    requireCondition(restored.undoDepth === baseline.undoDepth, `Undo depth is ${restored.undoDepth}, baseline was ${baseline.undoDepth}`);
    requireCondition(restored.bodies.length === baseline.bodies.length, `Body count is ${restored.bodies.length}, baseline was ${baseline.bodies.length}`);
    requireCondition(JSON.stringify(restored.bodies.map((body: { id: number }) => body.id)) === JSON.stringify(baseline.bodies.map((body: { id: number }) => body.id)), "Undo did not restore the baseline bodies");
    requireCondition((await call(client, "plasticity_list_measurements", {})).measurements.length === baselineMeasurements, "Undo did not restore the baseline measurements");
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
  const client = new Client({ name: "plasticity-extend-sweep-label-live", version: "1.0.0" });
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
  for (let count = 0; count < 24; count += 1) {
    const current = await status(client);
    if (current.documentToken !== initial.documentToken) return { restored: false, reason: "document-changed" };
    if (current.undoDepth <= initial.undoDepth) {
      const measurementCount = (await call(client, "plasticity_list_measurements", {})).measurements.length;
      return { restored: current.bodies.length === initial.bodies.length && (initial.measurementCount === undefined || measurementCount === initial.measurementCount), bodyCount: current.bodies.length, measurementCount };
    }
    await call(client, "plasticity_undo", { intent: "Recover extend/sweep/label acceptance", revision: current.revision });
  }
  return { restored: false, reason: "undo-limit" };
}

function summary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length }; }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function requireNear(actual: number, expected: number, label: string, tolerance = 0.05): void {
  requireCondition(typeof actual === "number" && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} within ${tolerance}, got ${actual}`);
}
function requireBounds(bounds: Bounds, min: number[], max: number[], label: string): void {
  min.forEach((value, axis) => requireNear(bounds.min[axis]!, value, `${label} min[${axis}]`));
  max.forEach((value, axis) => requireNear(bounds.max[axis]!, value, `${label} max[${axis}]`));
}
function boundsEqual(left: Bounds, right: Bounds): boolean {
  return [...left.min, ...left.max].every((value, index) => Math.abs(value - [...right.min, ...right.max][index]!) < 0.01);
}
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL", "PLASTICITY_AUTO_LAUNCH", "PLASTICITY_HUD", "PLASTICITY_MCP_STATE_DIR", "PLASTICITY_CONSTRUCTION_HISTORY_ROOT"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
