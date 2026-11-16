#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { discoverPlasticityTargets } from "../src/cdp/discovery.ts";
import { nativeFunction } from "../src/plasticity/native-function.ts";
import { PlasticityRuntime } from "../src/plasticity/runtime.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface GapsOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseGapsArgs(argv: string[]): GapsOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: GapsOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live gaps acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live gaps acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live gaps acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-gaps-live.ts --help
  node scripts/verify-native-gaps-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
PLASTICITY_CDP_URL is mandatory: set it to the isolated Plasticity instance. The command never launches Plasticity
(it forces PLASTICITY_AUTO_LAUNCH=0 and PLASTICITY_HUD=0) and refuses to start without the variable.
Live mode takes a baseline, builds disposable geometry at x >= 2400 mm and checks five tool fixes:
  G1 plasticity_boolean with several tools: intersection with two and three tools is target AND every tool (volume read with
     plasticity_measure_solid_properties against the hand calculation), one Undo step per call, keepTools keeps every tool,
     and multi-tool union and difference volumes match the hand calculation;
  G2 plasticity_screenshot frame: bodies about 0, 400 and 2000 mm from the origin under three camera states (isometric fit,
     top, set_camera), three PNG captures each, plus a capture right after a view change. Every capture succeeds, the file
     exists, the camera read before and after is identical and the Undo depth does not change;
  G3 plasticity_delete_section_analysis: all: true removes the section analysis (Plasticity holds one at a time, so a second
     create is refused) and the list is empty; id and all are mutually exclusive;
  G4 STEP, IGES, SAT and Parasolid (.x_t, .x_b) exports of one body: no file contains the home directory, the OS user name or
     the staging folder, the STEP header names the output file with empty author and organisation;
  G5 a 48 x 36 x 22 box with its four long edges at R7 and the end loop chamfered: 5 mm and 7 mm match the hand calculation;
     7.41 mm (larger than R7) is refused with a certain error naming the Undo step, and its measured volume is reported.
It undoes back to the baseline Undo depth and body count and never saves the document. The last line printed is the result
with undoDepth and the body IDs. Run it only against an isolated Plasticity instance.`;

const CAMERA = nativeFunction`function () {
  const viewport = Array.from(this.viewports)[0], camera = viewport.camera, controls = viewport.orbitControls;
  return { position: camera.position.toArray(), target: camera.target.toArray(), quaternion: camera.quaternion.toArray(), zoom: Number(camera.zoom),
    radius: controls.radius, radiusEnd: controls.radiusEnd, zoomControl: controls.zoom };
}`;

const PICK_STATE = nativeFunction`function () {
  let bodies = 0;
  for (const [versionId] of nativeApi.geo.geometryModel) if (!nativeApi.geo.automatics.has(versionId)) bodies += 1;
  return { undoDepth: this.history.undoStack.length, bodies, busy: Boolean(this.executor.isBusy),
    activeCommand: this.executor.active ? (this.executor.active.command?.constructor?.name ?? 'unknown') : null };
}`;

async function main(): Promise<void> {
  const options = parseGapsArgs(process.argv.slice(2));
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
  try {
    const targets = await discoverPlasticityTargets(endpoint);
    const target = targets.find((candidate) => candidate.id === options.target);
    requireCondition(target, "Explicit Plasticity target was not found on PLASTICITY_CDP_URL");
    native = await PlasticityRuntime.connect(target);
    const nativeState = async (): Promise<any> => await native!.read(PICK_STATE);
    const cameraNow = async (): Promise<any> => await native!.read(CAMERA);
    // A camera set a moment ago still eases toward its end pose: read it until two reads agree.
    const settledCamera = async (): Promise<any> => {
      let previous = await cameraNow();
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((done) => setTimeout(done, 150));
        const current = await cameraNow();
        if (JSON.stringify(current) === JSON.stringify(previous)) return current;
        previous = current;
      }
      throw new Error("The camera did not hold still");
    };

    live = await startMcp(endpoint, output, serverStderr);
    const client = live.client;
    const windows = await call(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    await call(client, "plasticity_connect", { targetId: options.target });
    baseline = await status(client);
    const nativeBaseline = await nativeState();
    evidence.baseline = { ...summary(baseline), bodyIds: bodyIds(baseline), native: nativeBaseline };
    requireCondition(nativeBaseline.undoDepth === baseline.undoDepth && nativeBaseline.bodies === baseline.bodies.length, "Native and MCP baselines disagree");
    const checks: Record<string, unknown> = {};

    const box = async (originMm: number[], sizeMm: number[]): Promise<number> => {
      const before = await status(client);
      await call(client, "plasticity_create_box", { originMm, sizeMm, revision: before.revision });
      const after = await status(client);
      const added = after.bodies.filter((body: { id: number }) => !before.bodies.some((old: { id: number }) => old.id === body.id));
      requireCondition(added.length === 1 && added[0].type === "Solid", "create_box: expected one new Solid");
      return added[0].id;
    };
    const volume = async (id: number): Promise<number> => {
      const current = await status(client);
      const read = await call(client, "plasticity_measure_solid_properties", { ids: [id], revision: current.revision });
      requireCondition(read.bodies[0]?.nativeCheckCodes?.length === 0, `Body ${id} has native check codes`);
      return read.totals.volumeMm3;
    };
    const exists = async (id: number): Promise<boolean> => (await status(client)).bodies.some((body: { id: number }) => body.id === id);
    const boolean = async (targetIds: number[], toolIds: number[], operation: string, keepTools = false): Promise<{ undoSteps: number }> => {
      const before = await status(client);
      await call(client, "plasticity_boolean", { targetIds, toolIds, operation, keepTools, revision: before.revision });
      const after = await status(client);
      return { undoSteps: after.undoDepth - before.undoDepth };
    };
    const X = 3000;

    // ---- G1: boolean with several tools
    const g1: Record<string, unknown> = {};
    {
      // Target 40 x 40 x 40; tool a covers x <= 10 (target x 0..10), tool b covers y <= 10, tool c covers z <= 20.
      const fixture = async (keep = false) => {
        const target = await box([X, 0, 0], [40, 40, 40]);
        const a = await box([X - 30, -10, -10], [40, 60, 60]);
        const b = await box([X - 10, -30, -10], [60, 40, 60]);
        const c = await box([X - 10, -10, -30], [60, 60, 50]);
        return { target, a, b, c, keep };
      };
      let f = await fixture();
      let step = await boolean([f.target], [f.a, f.b], "intersection");
      let measured = await volume(f.target);
      requireNear(measured, 4000, "two-tool intersection volume (10 x 10 x 40)", 1e-6);
      requireCondition(Math.abs(measured - 28000) > 1, "the result is still the union of the tools");
      requireCondition(step.undoSteps === 1, `two-tool intersection took ${step.undoSteps} Undo steps`);
      requireCondition(!(await exists(f.a)) && !(await exists(f.b)) && (await exists(f.c)), "tools a and b are consumed and the unused tool c stays");
      g1.intersectionTwoTools = { volumeMm3: measured, expectedMm3: 4000, undoSteps: step.undoSteps };
      await undoTo(client, baseline.undoDepth);

      f = await fixture();
      step = await boolean([f.target], [f.a, f.b, f.c], "intersection");
      measured = await volume(f.target);
      requireNear(measured, 2000, "three-tool intersection volume (10 x 10 x 20)", 1e-6);
      requireCondition(step.undoSteps === 1, `three-tool intersection took ${step.undoSteps} Undo steps`);
      g1.intersectionThreeTools = { volumeMm3: measured, expectedMm3: 2000, undoSteps: step.undoSteps };
      await undoTo(client, baseline.undoDepth);

      f = await fixture();
      const toolVolumes = [await volume(f.a), await volume(f.b)];
      step = await boolean([f.target], [f.a, f.b], "intersection", true);
      measured = await volume(f.target);
      requireNear(measured, 4000, "keepTools two-tool intersection volume", 1e-6);
      requireCondition((await exists(f.a)) && (await exists(f.b)), "keepTools must keep every tool");
      requireNear(await volume(f.a), toolVolumes[0]!, "kept tool a volume", 1e-6);
      requireNear(await volume(f.b), toolVolumes[1]!, "kept tool b volume", 1e-6);
      g1.keepTools = { volumeMm3: measured, expectedMm3: 4000, undoSteps: step.undoSteps, toolsKept: true };
      await undoTo(client, baseline.undoDepth);

      // Union: target 40^3 plus t1 (x 30..50, 20 mm sticking out) and t2 (x 0..28, y 30..50); no tool touches the other.
      const target = await box([X, 0, 0], [40, 40, 40]);
      const t1 = await box([X + 30, 0, 0], [20, 40, 40]);
      const t2 = await box([X, 30, 0], [28, 20, 40]);
      step = await boolean([target], [t1, t2], "union");
      measured = await volume(target);
      requireNear(measured, 64000 + 16000 + 11200, "two-tool union volume", 1e-6);
      g1.unionTwoTools = { volumeMm3: measured, expectedMm3: 91200, undoSteps: step.undoSteps };
      await undoTo(client, baseline.undoDepth);

      // Difference: x >= 10 and y >= 10 stays: 30 x 30 x 40.
      f = await fixture();
      step = await boolean([f.target], [f.a, f.b], "difference");
      measured = await volume(f.target);
      requireNear(measured, 36000, "two-tool difference volume (30 x 30 x 40)", 1e-6);
      g1.differenceTwoTools = { volumeMm3: measured, expectedMm3: 36000, undoSteps: step.undoSteps };
      await undoTo(client, baseline.undoDepth);
    }
    checks.g1 = g1;

    // ---- G2: plasticity_screenshot frame
    const g2: Record<string, unknown> = {};
    {
      await mkdir(join(output, "shots"));
      const near = await box([-10, -10, -10], [20, 20, 20]);
      const mid = await box([-10, 390, -10], [20, 20, 20]);
      const far = await box([-10, 1990, -10], [20, 20, 20]);
      const states: Array<[string, () => Promise<unknown>]> = [
        ["isometric-fit", () => call(client, "plasticity_set_view", { view: "isometric", fit: true })],
        ["top", () => call(client, "plasticity_set_view", { view: "top", fit: false })],
        ["custom", () => call(client, "plasticity_set_camera", { eyeMm: [300, -500, 250], targetMm: [20, 100, 10], frameRadiusMm: 150 })],
      ];
      const distances: Array<[string, number, number]> = [["near", near, 0], ["mid", mid, 400], ["far", far, 2000]];
      const rows: unknown[] = [];
      let captures = 0;
      for (const [stateName, apply] of states) {
        await apply();
        for (const [distanceName, id, distanceMm] of distances) {
          for (let repeat = 1; repeat <= 3; repeat += 1) {
            const before = await settledCamera();
            const undoBefore = (await status(client)).undoDepth;
            const path = join(output, "shots", `${stateName}-${distanceName}-${repeat}.png`);
            const shot = await call(client, "plasticity_screenshot", { path, captureMode: "viewport", frame: { bodyIds: [id] } });
            const after = await cameraNow();
            const undoAfter = (await status(client)).undoDepth;
            requireCondition((await stat(path)).size > 1000, `${path} was not written`);
            requireCondition(JSON.stringify(before) === JSON.stringify(after), `${stateName}/${distanceName}/${repeat}: the camera is different after the capture`);
            requireCondition(undoBefore === undoAfter, `${stateName}/${distanceName}/${repeat}: the Undo depth changed`);
            requireCondition(shot.view?.frame?.cameraRestored === true && shot.view.frame.cameraDeviation <= 1e-9, `${stateName}/${distanceName}/${repeat}: cameraRestored is not true`);
            captures += 1;
            if (repeat === 1) rows.push({ state: stateName, distanceMm, cameraRestored: true, cameraDeviation: shot.view.frame.cameraDeviation, cameraIdentical: true, file: path });
          }
        }
      }
      // The case that used to fail: a capture straight after a view change, while the camera is still easing.
      await call(client, "plasticity_set_view", { view: "isometric", fit: true });
      const direct = await call(client, "plasticity_screenshot", { path: join(output, "shots", "right-after-set-view.png"), captureMode: "viewport", frame: { bodyIds: [near] } });
      requireCondition(direct.view?.frame?.cameraRestored === true, "A capture right after a view change did not restore the camera");
      g2.captures = captures + 1;
      g2.rows = rows;
      g2.rightAfterViewChange = direct.view.frame;
    }
    checks.g2 = g2;
    await undoTo(client, baseline.undoDepth);

    // ---- G3: delete every section analysis
    const g3: Record<string, unknown> = {};
    {
      let current = await status(client);
      await call(client, "plasticity_create_section_analysis", { originMm: [0, 0, 5], normal: [0, 0, 1], name: "gaps-1", revision: current.revision });
      current = await status(client);
      requireCondition((await call(client, "plasticity_list_section_analyses", {})).sectionAnalyses.length === 1, "expected one section analysis");
      // Plasticity keeps one section plane: a second create is refused, so one is what "all" has to remove.
      const second = await callRaw(client, "plasticity_create_section_analysis", { originMm: [0, 0, 8], normal: [0, 0, 1], name: "gaps-2", revision: current.revision });
      requireCondition(second.isError && /already has an active section/i.test(second.text), "a second section analysis was not refused");
      const neither = await callRaw(client, "plasticity_delete_section_analysis", { revision: current.revision });
      requireCondition(neither.isError && /id/.test(neither.text) && /all/.test(neither.text), "delete without id or all did not name both");
      const both = await callRaw(client, "plasticity_delete_section_analysis", { id: 1, all: true, revision: current.revision });
      requireCondition(both.isError, "delete with id and all was accepted");
      await call(client, "plasticity_delete_section_analysis", { all: true, revision: current.revision });
      requireCondition((await call(client, "plasticity_list_section_analyses", {})).sectionAnalyses.length === 0, "the list is not empty after all: true");
      g3.createdCount = 1; g3.secondCreateRefused = true; g3.afterAllCount = 0; g3.missingArgumentError = neither.text.slice(0, 200);
      // all: true on an empty list is a no-op
      current = await status(client);
      const empty = await call(client, "plasticity_delete_section_analysis", { all: true, revision: current.revision });
      requireCondition(empty.revision === current.revision, "all: true on an empty list changed the revision");
    }
    checks.g3 = g3;

    // ---- G4: export headers
    const g4: Record<string, unknown> = {};
    {
      await mkdir(join(output, "exports"));
      const id = await box([X, 0, 0], [10, 20, 30]);
      const files: Array<[string, string, Record<string, unknown>]> = [
        ["plasticity_export_step", "part.step", {}], ["plasticity_export_iges", "part.igs", {}], ["plasticity_export_sat", "part.sat", {}],
        ["plasticity_export_parasolid", "part.x_t", {}], ["plasticity_export_parasolid", "part.x_b", {}],
      ];
      const needles = [homedir(), userInfo().username, join(output, "exports"), ".plasticity-"];
      const results: Record<string, unknown> = {};
      for (const [tool, name] of files) {
        const current = await status(client);
        const path = join(output, "exports", name);
        await call(client, tool, { ids: [id], path, revision: current.revision });
        const text = (await readFile(path)).toString("latin1");
        // IGES wraps the header at column 72: test the unwrapped Global text too.
        const unwrapped = text.split("\n").map((line) => line.slice(0, 72)).join("");
        const leaked = needles.filter((needle) => text.includes(needle) || unwrapped.includes(needle));
        requireCondition(leaked.length === 0, `${name} still contains ${leaked.join(", ")}`);
        results[name] = { bytes: text.length, leaks: 0 };
      }
      const step = (await readFile(join(output, "exports", "part.step"), "utf8"));
      requireCondition(/FILE_NAME\('part\.step',\s*'[^']*',\s*\(''\),\s*\(''\),/.test(step), "STEP FILE_NAME does not name part.step with empty author and organisation");
      const iges = (await readFile(join(output, "exports", "part.igs"), "latin1")).split("\n");
      requireCondition(iges.join("").includes("8Hpart.igs") || iges.map((line) => line.slice(0, 72)).join("").includes("8Hpart.igs"), "IGES Global section does not name part.igs");
      g4.files = results;
      g4.stepHeader = step.slice(step.indexOf("FILE_NAME("), step.indexOf("FILE_SCHEMA")).trim();
      await undoTo(client, baseline.undoDepth);
    }
    checks.g4 = g4;

    // ---- G5: chamfer larger than the corner radius
    const g5: Record<string, unknown> = {};
    {
      const R = 7;
      const A0 = 36 * 22 - (4 - Math.PI) * R * R;
      const section = (t: number) => t <= R ? (36 - 2 * t) * (22 - 2 * t) - (4 - Math.PI) * (R - t) ** 2 : (36 - 2 * t) * (22 - 2 * t);
      // Removed volume of an ideal equal-distance chamfer: integral over 0..d of (A0 - A(t)) dt, A(t) the section eroded by t.
      const idealVolume = (d: number): number => { const n = 200000; let removed = 0; for (let i = 0; i < n; i += 1) removed += (A0 - section((i + 0.5) * d / n)) * d / n; return 48 * A0 - removed; };
      const build = async () => {
        const id = await box([X, 0, 0], [48, 36, 22]);
        let current = await status(client);
        const longEdges = await call(client, "plasticity_find_edges", { revision: current.revision, query: { bodyIds: [id], line: true, direction: { vector: [1, 0, 0], toleranceDeg: 0.1 } } });
        requireCondition(longEdges.count === 4, "expected four long edges");
        await call(client, "plasticity_fillet", { id, edgeIds: longEdges.matches.map((match: { id: string }) => match.id), radiusMm: 7, revision: current.revision });
        current = await status(client);
        const faces = await call(client, "plasticity_find_faces", { revision: current.revision, query: { bodyIds: [id], planar: true, normal: { vector: [1, 0, 0], toleranceDeg: 0.01 } } });
        const endFace = faces.matches.sort((a: any, b: any) => b.centerMm[0] - a.centerMm[0])[0];
        const loop = await call(client, "plasticity_find_edges", { revision: current.revision, query: { bodyIds: [id], adjacentFaceIds: [endFace.id] } });
        requireCondition(loop.count === 8 && loop.matches.filter((match: any) => match.curveType === "Circle").length === 4, "the end loop is not 4 lines + 4 arcs");
        return { id, loopIds: loop.matches.map((match: { id: string }) => match.id) };
      };
      const faceCount = async (id: number) => (await status(client)).bodies.find((body: { id: number }) => body.id === id).faceCount;
      const validity = async (id: number) => { const current = await status(client); const read = await call(client, "plasticity_validate_bodies", { ids: [id], revision: current.revision }); return read.bodies[0]; };
      const rows: Record<string, unknown> = {};
      for (const distance of [5, 7]) {
        const { id, loopIds } = await build();
        const filleted = await volume(id);
        requireNear(filleted, 48 * A0, "filleted box volume", 1e-3);
        const current = await status(client);
        await call(client, "plasticity_chamfer", { id, edgeIds: loopIds, distanceMm: distance, revision: current.revision });
        const measured = await volume(id);
        requireNear(measured, idealVolume(distance), `${distance} mm chamfer volume`, 1e-3);
        const valid = await validity(id);
        requireCondition(valid.closed && valid.nativeValid && valid.printableSolid, `${distance} mm chamfer is not a valid closed solid`);
        rows[`d${distance}`] = { volumeMm3: measured, idealMm3: idealVolume(distance), faces: await faceCount(id), tool: "ok" };
        await undoTo(client, baseline.undoDepth);
      }
      {
        const { id, loopIds } = await build();
        const facesBefore = await faceCount(id);
        const current = await status(client);
        const refused = await callRaw(client, "plasticity_chamfer", { id, edgeIds: loopIds, distanceMm: 7.41, revision: current.revision });
        requireCondition(refused.isError && /larger than the radius of arc edge/.test(refused.text) && /Undo step/.test(refused.text), `7.41 mm chamfer was not refused honestly: ${refused.text.slice(0, 200)}`);
        const measured = await volume(id);
        const ideal = idealVolume(7.41);
        const valid = await validity(id);
        requireCondition(valid.closed && valid.nativeValid, "the kernel's 7.41 mm result is not closed and valid (the finding says it is)");
        rows.d7_41 = { toolRefused: true, measuredMm3: measured, idealMm3: ideal, differenceMm3: measured - ideal, faces: await faceCount(id), facesBeforeChamfer: facesBefore, expectedFacesForFullChamfer: facesBefore + 8, closed: valid.closed, nativeValid: valid.nativeValid, message: refused.text.slice(0, 400) };
        await undoTo(client, baseline.undoDepth);
      }
      g5.rows = rows;
    }
    checks.g5 = g5;

    // ---- restore the baseline
    await undoTo(client, baseline.undoDepth);
    const restored = await status(client);
    const nativeRestored = await nativeState();
    evidence.checks = checks;
    evidence.restored = { ...summary(restored), bodyIds: bodyIds(restored), native: nativeRestored };
    requireCondition(restored.documentToken === baseline.documentToken, "The document changed during acceptance");
    requireCondition(restored.undoDepth === baseline.undoDepth, `Undo depth is ${restored.undoDepth}, baseline was ${baseline.undoDepth}`);
    requireCondition(JSON.stringify(bodyIds(restored)) === JSON.stringify(bodyIds(baseline)), "Undo did not restore the baseline bodies");
    requireCondition(nativeRestored.undoDepth === nativeBaseline.undoDepth && nativeRestored.bodies === nativeBaseline.bodies && nativeRestored.activeCommand === null, "Native state differs from the baseline");
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), evidence);
    console.log(JSON.stringify({ checks }, null, 2));
    console.log(JSON.stringify({ ok: true, output, undoDepth: restored.undoDepth, bodies: bodyIds(restored) }));
  } catch (error) {
    evidence.failure = boundedError(error);
    throw error;
  } finally {
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
  const client = new Client({ name: "plasticity-gaps-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function callRaw(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const response = await client.callTool({ name, arguments: args });
  return { isError: "isError" in response && response.isError === true, text: toolText(response) };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const result = await callRaw(client, name, args);
  if (result.isError) throw new Error(result.text);
  return JSON.parse(result.text);
}

async function status(client: Client): Promise<any> {
  const state = await call(client, "plasticity_status", { bodyLimit: 200 });
  requireCondition(!state.bodyPagination?.nextOffset, "The acceptance document has more than 200 bodies");
  return state;
}

async function undoTo(client: Client, depth: number): Promise<void> {
  for (let count = 0; count < 60; count += 1) {
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
  // A section analysis is viewport state, not Undo history: clear any left by a failed run.
  const current = await status(client);
  if ((current.sectionAnalyses ?? []).length > 0) await call(client, "plasticity_delete_section_analysis", { all: true, revision: current.revision }).catch(() => undefined);
  for (let count = 0; count < 60; count += 1) {
    const state = await status(client);
    if (state.documentToken !== initial.documentToken) return { restored: false, reason: "document-changed" };
    if (state.undoDepth <= initial.undoDepth) return { restored: state.bodies.length === initial.bodies.length, undoDepth: state.undoDepth, bodyCount: state.bodies.length };
    await call(client, "plasticity_undo", { intent: "Recover gaps acceptance", revision: state.revision });
  }
  return { restored: false, reason: "undo-limit" };
}

function bodyIds(state: any): number[] { return state.bodies.map((body: { id: number }) => body.id).sort((a: number, b: number) => a - b); }
function summary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length }; }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function requireNear(actual: number, expected: number, label: string, tolerance = 0.05): void {
  requireCondition(typeof actual === "number" && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} within ${tolerance}, got ${actual}`);
}
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL", "PLASTICITY_AUTO_LAUNCH", "PLASTICITY_HUD", "PLASTICITY_MCP_STATE_DIR", "PLASTICITY_CONSTRUCTION_HISTORY_ROOT"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
