#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { discoverPlasticityTargets } from "../src/cdp/discovery.ts";
import { nativeFunction } from "../src/plasticity/native-function.ts";
import { CHAMFER_SOURCE } from "../src/plasticity/operations.ts";
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
Live mode takes a baseline, builds disposable geometry at x >= 2400 mm and checks the tool fixes:
  G1 (final review) the intersection matrix 1-2 targets x 1-3 tools x keepTools (32,000, 8,000 and 6,000 mm3 each, IDs kept, one
     Undo step that one undo restores); a tool that contains the target in either order and alone (32,000 and 64,000, named
     in unchangedBy), a tool with a void inside the target (63,000), a tool that misses or only touches (refused by name,
     document unchanged).
  G1 plasticity_boolean with several tools: one target intersected with two and three tools (4,000 and 2,000 mm3), keepTools,
     union (91,200) and difference (36,000); two targets with two and three tools (8,000 and 4,000 mm3 each, IDs kept, both
     keepTools values); one Undo step that one undo restores; a failure on the second target names target and tool, and
     the document reads back as before;
  G2 plasticity_screenshot frame: bodies about 0, 400 and 2000 mm from the origin under three camera states (isometric fit,
     top, set_camera), three PNG captures each, plus a capture right after a view change. Every capture succeeds, the file
     exists, the camera read before and after is identical and the Undo depth does not change;
  G3 plasticity_delete_section_analysis: all: true removes the section analysis (Plasticity holds one at a time, so a second
     create is refused) and the list is empty; id and all are mutually exclusive;
  G4 STEP, IGES, SAT and Parasolid (.x_t, .x_b) exports, also into a folder with a non-ASCII name: no file contains the home
     directory, the OS user name or the staging folder; the STEP header names the output file with empty author and
     organisation; IGES files named a.igs, bracket.igs and a 120-character name pass the IGES 5.3 line rules
     (checkIgesGlobalRules);
  G5 plasticity_chamfer matrix: the R7 box end loop at 5, 7, 7.41 and 9 mm for six selections, through holes, a cylinder rim,
     a concave boss base, a pocket loop with R2 concave arcs, an edgeQuery selection, a plasticity_batch with undoOnError and
     a two-body call. Every row: the raw native chamfer's volume against the hand calculation decides whether the chamfer
     is right; the tool must return OK with the hand volume exactly then, and otherwise fail with the document as before
     (Undo depth, faces and volume).
It undoes back to the baseline Undo depth and body count and never saves the document. The last line printed is the result
with undoDepth and the body IDs. Run it only against an isolated Plasticity instance.`;

/**
 * Checks an IGES file's fixed-format lines and its Global section against IGES 5.3 sections 2.2.2 and 2.2.3, written
 * apart from the tool's own wrapper. Every line is 80 columns with a section letter in column 73 and a sequence number
 * that counts from 1 in each section; the Terminate record's counts match. In the Global section (data in columns
 * 1-72): a string's count and H sit together on one line, and a string that crosses a line runs to column 72 and goes on
 * in column 1; a numeric or empty field and its delimiter end on one line, with no blank inside the number; blanks
 * outside strings only stand between parameters; nothing but blanks follows the record delimiter. Returns the
 * violations and the parameters read (strings as written, e.g. 8Hpart.igs; numbers trimmed).
 */
export function checkIgesGlobalRules(text: string): { violations: string[]; parameters: string[]; counts: Record<string, number> } {
  const violations: string[] = [];
  const all = text.split(/\r?\n/u);
  if (all[all.length - 1] === "") all.pop();
  const counts: Record<string, number> = {};
  all.forEach((line, index) => {
    if (line.length !== 80) violations.push(`line ${index + 1} is ${line.length} columns, not 80`);
    const letter = line[72] ?? "?";
    counts[letter] = (counts[letter] ?? 0) + 1;
    if (!/^[SGDPT]$/u.test(letter)) violations.push(`line ${index + 1} has section letter ${JSON.stringify(letter)}`);
    if (line.slice(73).length !== 7 || line.slice(73).trim() !== String(counts[letter])) violations.push(`line ${index + 1} (${letter}) has sequence ${JSON.stringify(line.slice(73))}, expected ${counts[letter]}`);
  });
  const terminate = all.find((line) => line[72] === "T");
  const termCounts = terminate ? /^S([ \d]{7})G([ \d]{7})D([ \d]{7})P([ \d]{7})/u.exec(terminate) : null;
  if (!termCounts) violations.push("no Terminate record with S, G, D and P counts");
  else for (const [index, letter] of ["S", "G", "D", "P"].entries()) if (Number(termCounts[index + 1]) !== (counts[letter] ?? 0)) violations.push(`Terminate says ${letter} ${Number(termCounts[index + 1])}, the file has ${counts[letter] ?? 0}`);
  const data = all.filter((line) => line[72] === "G").map((line) => line.slice(0, 72).padEnd(72, " "));
  const parameters: string[] = [];
  let row = 0;
  let col = 0;
  const at = () => (row < data.length ? data[row]![col] : undefined);
  const where = () => `G line ${row + 1} column ${col + 1}`;
  const next = () => { col += 1; if (col === 72) { row += 1; col = 0; } };
  let ended = false;
  while (!ended) {
    while (row < data.length && at() === " ") next(); // blanks between parameters (and line padding)
    if (row >= data.length) { violations.push("the Global section ends without a record delimiter"); break; }
    const startRow = row;
    if (/\d/u.test(at()!)) {
      let digits = "";
      while (row === startRow && /\d/u.test(at()!)) { digits += at(); next(); }
      if (row !== startRow) { violations.push(`a count or number reaches column 72 of G line ${startRow + 1} without its H or delimiter`); break; }
      if (at() === "H") {
        next();
        const length = Number(digits);
        let value = "";
        for (let index = 0; index < length; index += 1) {
          if (row >= data.length) { violations.push(`string ${digits}H runs past the Global section`); break; }
          value += at();
          next();
        }
        parameters.push(`${digits}H${value}`);
      } else {
        let rest = digits;
        while (row === startRow && at() !== "," && at() !== ";") { rest += at(); next(); }
        if (row !== startRow) { violations.push(`numeric field ${JSON.stringify(rest.trim())} on G line ${startRow + 1} does not end with its delimiter on that line`); break; }
        if (/ /u.test(rest.trim())) violations.push(`numeric field ${JSON.stringify(rest)} has a blank inside (${where()})`);
        parameters.push(rest.trim());
      }
    } else if (at() === "," || at() === ";") {
      parameters.push("");
    } else {
      let rest = "";
      while (row === startRow && at() !== "," && at() !== ";") { rest += at(); next(); }
      if (row !== startRow) { violations.push(`field ${JSON.stringify(rest.trim())} on G line ${startRow + 1} does not end with its delimiter on that line`); break; }
      if (/ /u.test(rest.trim())) violations.push(`field ${JSON.stringify(rest)} has a blank inside (${where()})`);
      parameters.push(rest.trim());
    }
    const delimiter = at();
    if (delimiter !== "," && delimiter !== ";") { violations.push(`expected a delimiter at ${where()}, found ${JSON.stringify(delimiter)}`); break; }
    next();
    if (delimiter === ";") ended = true;
  }
  if (ended) {
    const tail = data.slice(row).join("").slice(col);
    if (tail.trim() !== "") violations.push(`text after the record delimiter: ${JSON.stringify(tail.trim().slice(0, 40))}`);
    // The record delimiter's line is the last Global line (row moved past it only when ';' sat in column 72).
    if (data.length - row > (col === 0 ? 0 : 1)) violations.push("a Global line after the record delimiter's line");
  }
  return { violations, parameters, counts };
}

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

      // Several targets: t1 and t2 are 40^3 cubes 100 mm apart; tool p keeps y <= 20, tool q keeps z <= 10, tool r keeps
      // y >= 10. Each target: 40 x 20 x 10 = 8,000 with p and q; 40 x 10 x 10 = 4,000 with p, q and r.
      const multi: Record<string, unknown> = {};
      for (const [label, toolCount, keep, expected] of [["twoTools", 2, false, 8000], ["threeTools", 3, false, 4000], ["twoToolsKeep", 2, true, 8000], ["threeToolsKeep", 3, true, 4000]] as const) {
        const t1 = await box([X, 0, 0], [40, 40, 40]);
        const t2 = await box([X + 100, 0, 0], [40, 40, 40]);
        const tools = [await box([X - 10, -10, -10], [160, 30, 60]), await box([X - 10, -10, -10], [160, 60, 20]), await box([X - 10, 10, -10], [160, 60, 60])].slice(0, toolCount);
        const toolVolumes = await Promise.all(tools.map(async (id) => await volume(id)));
        const before = await status(client);
        step = await boolean([t1, t2], tools, "intersection", keep);
        const v1 = await volume(t1);
        const v2 = await volume(t2);
        requireNear(v1, expected, `${label}: target 1 volume`, 1e-6);
        requireNear(v2, expected, `${label}: target 2 volume`, 1e-6);
        requireCondition(step.undoSteps === 1, `${label}: ${step.undoSteps} Undo steps`);
        const after = await status(client);
        requireCondition(after.bodies.filter((body: { id: number }) => !before.bodies.some((old: { id: number }) => old.id === body.id)).length === 0, `${label}: new body IDs appeared`);
        for (const [index, id] of tools.entries()) {
          if (keep) requireNear(await volume(id), toolVolumes[index]!, `${label}: kept tool ${id}`, 1e-6);
          else requireCondition(!(await exists(id)), `${label}: tool ${id} was not consumed`);
        }
        const current = await status(client);
        await call(client, "plasticity_undo", { intent: "one undo restores the call", revision: current.revision });
        const undone = await status(client);
        requireCondition(undone.undoDepth === before.undoDepth && sameBodies(undone, before), `${label}: one undo did not restore every body`);
        multi[label] = { volumesMm3: [v1, v2], expectedMm3: expected, undoSteps: step.undoSteps, toolsKept: keep, oneUndoRestores: true };
        await undoTo(client, baseline.undoDepth);
      }
      g1.severalTargets = multi;

      // A failure in the second target's passes: tool s covers half of t1 and misses t2, so t1's passes succeed and the
      // kernel refuses t2 AND s ("Operation has no effect", which it also says for a tool that contains the target).
      {
        const t1 = await box([X, 0, 0], [40, 40, 40]);
        const t2 = await box([X + 100, 0, 0], [40, 40, 40]);
        const p = await box([X - 10, -10, -10], [160, 30, 60]);
        const sTool = await box([X - 10, -10, -10], [30, 60, 60]);
        const before = await status(client);
        const refused = await callRaw(client, "plasticity_boolean", { targetIds: [t1, t2], toolIds: [p, sTool], operation: "intersection", revision: before.revision });
        const after = await status(client);
        requireCondition(refused.isError && new RegExp(`Intersection of target ${t2} with tool ${sTool} failed`).test(refused.text), `the failure does not name target ${t2} and tool ${sTool}: ${refused.text.slice(0, 300)}`);
        requireCondition(/the document reads back as before this call/.test(refused.text) && refused.text.includes(`the current revision is ${after.revision}`), `the failure message does not say the document is as before at the current revision: ${refused.text.slice(-400)}`);
        requireCondition(after.undoDepth === before.undoDepth && sameBodies(after, before), "the failed call changed the document");
        requireNear(await volume(t1), 64000, "target 1 after the failed call", 1e-6);
        g1.failureOnSecondTarget = { refused: true, undoDepthUnchanged: true, bodiesUnchanged: true, revisionBefore: before.revision, revisionAfter: after.revision, message: refused.text.slice(refused.text.indexOf("Intersection of target"), refused.text.indexOf("Intersection of target") + 120) + " ... " + refused.text.slice(-200) };
        await undoTo(client, baseline.undoDepth);
      }

      // ---- Final review B1 and B2. Targets: 40 mm cubes at x 0 and x 100 (from X). Tools across both: p keeps
      // y 10..30 (32,000 mm3 of each target), q keeps z <= 10, r keeps y >= 15. Hand volumes per target: p 32,000;
      // p and q 40 x 20 x 10 = 8,000; p, q and r 40 x 15 x 10 = 6,000.
      const run = async (targetCount: number, makeTools: Array<() => Promise<number>>, keep: boolean) => {
        const targets = [await box([X, 0, 0], [40, 40, 40]), await box([X + 100, 0, 0], [40, 40, 40])].slice(0, targetCount);
        const tools: number[] = [];
        for (const make of makeTools) tools.push(await make());
        const toolVolumes: number[] = [];
        for (const id of tools) toolVolumes.push(await volume(id));
        const before = await status(client);
        const reply = await call(client, "plasticity_boolean", { targetIds: targets, toolIds: tools, operation: "intersection", keepTools: keep, revision: before.revision });
        const after = await status(client);
        const volumes: number[] = [];
        for (const id of targets) { requireCondition(after.bodies.some((body: { id: number }) => body.id === id), `target ${id} lost its ID`); volumes.push(await volume(id)); }
        const added = after.bodies.filter((body: { id: number }) => !before.bodies.some((old: { id: number }) => old.id === body.id)).map((body: { id: number }) => body.id);
        requireCondition(added.length === 0, `new body IDs appeared: ${JSON.stringify(added)}`);
        requireCondition(after.undoDepth - before.undoDepth === 1, `${after.undoDepth - before.undoDepth} Undo steps`);
        for (const [index, id] of tools.entries()) {
          if (keep) requireNear(await volume(id), toolVolumes[index]!, `kept tool ${id}`, 1e-6);
          else requireCondition(!after.bodies.some((body: { id: number }) => body.id === id), `tool ${id} was not consumed`);
        }
        await call(client, "plasticity_undo", { intent: "one undo restores the call", revision: after.revision });
        const undone = await status(client);
        requireCondition(undone.undoDepth === before.undoDepth && sameBodies(undone, before), "one undo did not restore every body");
        await undoTo(client, baseline.undoDepth);
        return { targets, tools, volumes, reply, before };
      };
      const P = () => box([X - 10, 10, -10], [160, 20, 60]);
      const Q = () => box([X - 10, -10, -10], [160, 60, 20]);
      const R = () => box([X - 10, 15, -10], [160, 60, 60]);
      const BIG = () => box([X - 10, -10, -10], [160, 60, 60]); // contains both targets
      const matrix: Record<string, unknown> = {};
      for (const targetCount of [1, 2]) for (const [toolCount, expected] of [[1, 32000], [2, 8000], [3, 6000]] as const) for (const keep of [false, true]) {
        const label = `${targetCount} target(s) x ${toolCount} tool(s), keepTools ${keep}`;
        const result = await run(targetCount, [P, Q, R].slice(0, toolCount), keep).catch((error) => { throw new Error(`${label}: ${boundedError(error)}`); });
        for (const measuredVolume of result.volumes) requireNear(measuredVolume, expected, `${label}: target volume`, 1e-6);
        requireCondition(result.reply.unchangedBy === undefined, `${label}: unexpected unchangedBy`);
        matrix[label] = { volumesMm3: result.volumes, expectedMm3: expected, undoSteps: 1, idsKept: true, toolsKept: keep, oneUndoRestores: true };
      }
      g1.finalB1Matrix = matrix;

      // B2: a tool that contains the target is a no-op for it, in either order, and is named in unchangedBy.
      const containing: Record<string, unknown> = {};
      for (const targetCount of [1, 2]) for (const keep of [false, true]) for (const [name, makers, bigIndex, expected] of [["[BIG, A]", [BIG, P], 0, 32000], ["[A, BIG]", [P, BIG], 1, 32000], ["[BIG]", [BIG], 0, 64000]] as const) {
        const label = `${targetCount} target(s) x ${name}, keepTools ${keep}`;
        const result = await run(targetCount, [...makers], keep).catch((error) => { throw new Error(`${label}: ${boundedError(error)}`); });
        for (const measuredVolume of result.volumes) requireNear(measuredVolume, expected, `${label}: target volume`, 1e-6);
        const big = result.tools[bigIndex]!;
        requireCondition(JSON.stringify(result.reply.unchangedBy) === JSON.stringify([big]), `${label}: unchangedBy ${JSON.stringify(result.reply.unchangedBy)}, expected [${big}]`);
        requireCondition(JSON.stringify(result.reply.unchangedPairs) === JSON.stringify(result.targets.map((targetId) => ({ targetId, toolId: big }))), `${label}: unchangedPairs ${JSON.stringify(result.reply.unchangedPairs)}`);
        if (name === "[BIG]") {
          // The target is at its earlier version: nothing rebuilt it.
          const versionsBefore = result.targets.map((id) => result.before.bodies.find((body: { id: number }) => body.id === id).versionId);
          const versionsAfter = result.targets.map((id) => result.reply.bodies?.find((body: { id: number }) => body.id === id)?.versionId);
          if (versionsAfter.every((version) => version !== undefined)) requireCondition(JSON.stringify(versionsAfter) === JSON.stringify(versionsBefore), `${label}: the target version changed`);
        }
        containing[label] = { volumesMm3: result.volumes, expectedMm3: expected, unchangedBy: result.reply.unchangedBy, toolsKept: keep, undoSteps: 1, oneUndoRestores: true };
      }
      g1.finalB2Containing = containing;

      // B2: the kernel decides first. A tool with a void that lies inside the target answers the clash test like a
      // containing tool, and the intersection still removes the void: 64,000 - 1,000 = 63,000 mm3.
      {
        const target = await box([X, 0, 0], [40, 40, 40]);
        const shell = await box([X - 10, -10, -10], [60, 60, 60]);
        const core = await box([X + 15, 15, 15], [10, 10, 10]);
        await boolean([shell], [core], "difference");
        requireNear(await volume(shell), 215000, "the voided tool", 1e-6);
        const before = await status(client);
        const reply = await call(client, "plasticity_boolean", { targetIds: [target], toolIds: [shell], operation: "intersection", keepTools: true, revision: before.revision });
        const measuredVolume = await volume(target);
        requireNear(measuredVolume, 63000, "target AND a tool with a void inside the target", 1e-6);
        requireCondition(reply.unchangedBy === undefined, "the voided tool was reported as leaving the target unchanged");
        g1.finalB2VoidedTool = { volumeMm3: measuredVolume, expectedMm3: 63000 };
        await undoTo(client, baseline.undoDepth);
      }

      // B2: a tool that misses the target, and one that only touches it, fail by name with the document unchanged.
      const refusals: Record<string, unknown> = {};
      for (const [name, origin, size, pattern] of [
        ["miss", [X + 500, 0, 0], [5, 5, 5], /failed: the intersection is empty: Plasticity refused it \(Operation has no effect\) and the kernel clash test finds no contact between the two bodies/],
        ["touch", [X + 40, 0, 0], [5, 40, 40], /failed: the intersection has no volume: Plasticity refused it \(Operation has no effect\) and the kernel clash test finds the two bodies touching only on their surfaces/],
      ] as const) for (const withCut of [false, true]) {
        const label = `${name}${withCut ? " after a cutting tool" : ""}`;
        const target = await box([X, 0, 0], [40, 40, 40]);
        const cutter = withCut ? await P() : undefined;
        const tool = await box([...origin], [...size]);
        const before = await status(client);
        const refused = await callRaw(client, "plasticity_boolean", { targetIds: [target], toolIds: [...(cutter ? [cutter] : []), tool], operation: "intersection", revision: before.revision });
        const after = await status(client);
        requireCondition(refused.isError && refused.text.includes(`Intersection of target ${target} with tool ${tool} failed`) && pattern.test(refused.text), `${label}: ${refused.text.slice(0, 400)}`);
        requireCondition(/Plasticity rolled the command back: the document reads back as before this call/.test(refused.text) && refused.text.includes(`the current revision is ${after.revision}. The document is unchanged.`), `${label}: the message does not say the document is unchanged at the current revision: ${refused.text.slice(-300)}`);
        requireCondition(!/evalmachine|\n\s+at /.test(refused.text), `${label}: the message carries a stack: ${refused.text.slice(0, 400)}`);
        requireCondition(after.undoDepth === before.undoDepth && sameBodies(after, before), `${label}: the failed call changed the document`);
        requireNear(await volume(target), 64000, `${label}: target after the failed call`, 1e-6);
        refusals[label] = { refused: true, undoDepthUnchanged: true, bodiesUnchanged: true, message: refused.text.slice(0, 600) };
        await undoTo(client, baseline.undoDepth);
      }
      g1.finalB2Refusals = refusals;
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
      const id = await box([X, 0, 0], [10, 20, 30]);
      const plain = join(output, "exports");
      const unicode = join(output, "exports-d\u00efr \u6a21\u578b o'k");
      await mkdir(plain);
      await mkdir(unicode);
      const longName = `${"L".repeat(116)}.igs`;
      const files: Array<[string, string, string]> = [
        ["plasticity_export_step", plain, "part.step"], ["plasticity_export_iges", plain, "part.igs"], ["plasticity_export_sat", plain, "part.sat"],
        ["plasticity_export_parasolid", plain, "part.x_t"], ["plasticity_export_parasolid", plain, "part.x_b"],
        ["plasticity_export_iges", plain, "a.igs"], ["plasticity_export_iges", plain, "bracket.igs"], ["plasticity_export_iges", plain, longName],
        ["plasticity_export_step", unicode, "part.step"], ["plasticity_export_iges", unicode, "part.igs"], ["plasticity_export_sat", unicode, "part.sat"],
        ["plasticity_export_parasolid", unicode, "part.x_t"], ["plasticity_export_parasolid", unicode, "part.x_b"],
      ];
      const needles = [homedir(), userInfo().username, plain, unicode, ".plasticity-"];
      const results: Record<string, unknown> = {};
      for (const [tool, dir, name] of files) {
        const current = await status(client);
        const path = join(dir, name);
        await call(client, tool, { ids: [id], path, revision: current.revision });
        const bytes = await readFile(path);
        const text = bytes.toString("latin1");
        // IGES wraps the header at column 72: test the unwrapped Global text too, in UTF-8 and in latin1.
        const unwrapped = Buffer.from(text.split(/\r?\n/u).map((line) => line.slice(0, 72)).join(""), "latin1");
        const leaked = needles.filter((needle) => [Buffer.from(needle, "utf8"), Buffer.from(needle, "latin1")].some((form) => bytes.includes(form) || unwrapped.includes(form)));
        requireCondition(leaked.length === 0, `${path} still contains ${leaked.join(", ")}`);
        const key = `${dir === unicode ? "unicode/" : ""}${name.length > 40 ? `${name.length}-character name` : name}`;
        results[key] = { bytes: bytes.length, leaks: 0 };
        if (name.endsWith(".igs")) {
          const rules = checkIgesGlobalRules(text);
          requireCondition(rules.violations.length === 0, `${key} breaks the IGES 5.3 line rules: ${rules.violations.join("; ")}`);
          const igesName = name.replace(/[^\x20-\x7e]/gu, "_");
          requireCondition(rules.parameters[3] === `${igesName.length}H${igesName}`, `${key}: Global parameter 4 is ${rules.parameters[3]}`);
          results[key] = { bytes: bytes.length, leaks: 0, igesRuleViolations: 0, globalLines: rules.counts.G, parameter4: rules.parameters[3]!.slice(0, 40) };
        }
      }
      const step = (await readFile(join(plain, "part.step"), "utf8"));
      requireCondition(/FILE_NAME\('part\.step',\s*'[^']*',\s*\(''\),\s*\(''\),/.test(step), "STEP FILE_NAME does not name part.step with empty author and organisation");
      g4.files = results;
      g4.stepHeader = step.slice(step.indexOf("FILE_NAME("), step.indexOf("FILE_SCHEMA")).trim();
      await undoTo(client, baseline.undoDepth);
    }
    checks.g4 = g4;

    // ---- G5: the chamfer matrix
    const g5: Record<string, unknown> = {};
    {
      const R = 7;
      const A0 = 36 * 22 - (4 - Math.PI) * R * R;
      const sectionArea = (t: number) => t <= R ? (36 - 2 * t) * (22 - 2 * t) - (4 - Math.PI) * (R - t) ** 2 : (36 - 2 * t) * (22 - 2 * t);
      // Equal-distance chamfer of the end loop: at depth s below the end face the section is the end section eroded by d - s
      // (a rounded rectangle; corners go sharp once d - s > R), so the removed volume is the integral of A0 - A(t) over 0..d.
      const loopVolume = (d: number): number => { const n = 200000; let removed = 0; for (let i = 0; i < n; i += 1) removed += (A0 - sectionArea((i + 0.5) * d / n)) * d / n; return 48 * A0 - removed; };
      // A rim chamfer of a hole of radius r: a cone from radius r + d at the face down to depth min(d, available), minus the hole.
      const rimRemoved = (r: number, d: number, depth: number) => Math.PI * ((r + d) ** 3 - (r + d - depth) ** 3) / 3 - Math.PI * r * r * depth;
      const faceIds = async (id: number): Promise<string[]> => {
        const current = await status(client);
        const found = await call(client, "plasticity_find_faces", { revision: current.revision, query: { bodyIds: [id] }, limit: 500 });
        return (found.matches as Array<{ id: string }>).map((match) => match.id).sort();
      };
      const rows: unknown[] = [];
      // One row: the raw native chamfer (no tool check) decides whether Plasticity's result is right, by its volume against the
      // hand value; it is undone; then the tool must return OK with that volume, or fail with the document as before.
      const row = async (label: string, id: number, selection: Record<string, unknown>, distanceMm: number, handMm3: number) => {
        const before = await status(client);
        const facesBefore = await faceIds(id);
        const volumeBefore = await volume(id);
        const edgeIds = selection.edgeIds as string[] | undefined;
        let kernel: { volumeMm3?: number; error?: string } = {};
        if (edgeIds) {
          try {
            await native!.mutate(CHAMFER_SOURCE, ["FilletShellFactory"], [{ id, edgeIds, distance: -distanceMm / 1000 }]);
            kernel = { volumeMm3: await volume(id) };
            const done = await status(client);
            await call(client, "plasticity_undo", { intent: "undo the raw native chamfer", revision: done.revision });
          } catch (error) {
            kernel = { error: (error instanceof Error ? error.message : String(error)).slice(0, 120) };
          }
          const back = await status(client);
          requireCondition(back.undoDepth === before.undoDepth && JSON.stringify(await faceIds(id)) === JSON.stringify(facesBefore), `${label}: the raw native chamfer was not undone`);
        }
        const right = kernel.volumeMm3 !== undefined && Math.abs(kernel.volumeMm3 - handMm3) <= 0.01;
        const current = await status(client);
        const reply = await callRaw(client, "plasticity_chamfer", { id, ...selection, distanceMm, revision: current.revision });
        const after = await status(client);
        const entry: Record<string, unknown> = { label, distanceMm, handMm3: round3(handMm3), kernelMm3: kernel.volumeMm3 === undefined ? null : round3(kernel.volumeMm3), ...(kernel.error ? { kernelError: kernel.error } : {}), geometricallyRight: edgeIds ? right : "judged by the tool row", tool: reply.isError ? "refused" : "OK" };
        if (!reply.isError) {
          const measured = await volume(id);
          entry.toolMm3 = round3(measured);
          requireNear(measured, handMm3, `${label}: the tool returned OK; its volume`, 0.01);
          if (edgeIds) requireCondition(right, `${label}: the tool returned OK for a chamfer the raw kernel made wrong (${kernel.volumeMm3} against ${handMm3})`);
        } else {
          if (edgeIds) requireCondition(!right, `${label}: the tool refused a right chamfer: ${reply.text.slice(0, 300)}`);
          requireCondition(after.undoDepth === before.undoDepth, `${label}: the Undo depth changed (${before.undoDepth} -> ${after.undoDepth})`);
          requireCondition(JSON.stringify(await faceIds(id)) === JSON.stringify(facesBefore), `${label}: the body's faces changed`);
          requireNear(await volume(id), volumeBefore, `${label}: the body's volume after the refusal`, 1e-9);
          requireCondition(sameBodies(after, before), `${label}: the bodies differ after the refusal`);
          if (kernel.error === undefined) requireCondition(/The tool undid its own step: the document is as it was before this call/.test(reply.text) && /No undo is needed for this call/.test(reply.text), `${label}: the refusal does not say the document is as before: ${reply.text.slice(0, 400)}`);
          entry.message = reply.text.slice(0, 220);
          entry.documentUnchanged = true;
        }
        rows.push(entry);
        return { reply, entry };
      };
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
        requireNear(await volume(id), 48 * A0, "filleted box volume", 1e-3);
        return { id, endFaceId: endFace.id as string, lines: loop.matches.filter((m: any) => m.curveType === "Line").map((m: any) => m.id as string), arcs: loop.matches.filter((m: any) => m.curveType === "Circle").map((m: any) => m.id as string) };
      };
      const selections: Array<[string, (f: { lines: string[]; arcs: string[] }) => string[]]> = [
        ["all 8", (f) => [...f.lines, ...f.arcs]], ["4 arcs", (f) => f.arcs], ["1 arc", (f) => f.arcs.slice(0, 1)],
        ["1 line + 1 arc", (f) => [f.lines[0]!, f.arcs[0]!]], ["4 lines", (f) => f.lines], ["1 line", (f) => f.lines.slice(0, 1)],
      ];
      for (const d of [5, 7, 7.41, 9]) {
        for (const [name, pick] of selections) {
          const f = await build();
          await row(`R7 box end loop d=${d}, ${name}`, f.id, { edgeIds: pick(f) }, d, loopVolume(d));
          await undoTo(client, baseline.undoDepth);
        }
      }
      // edgeQuery: the loop by its end face, through the tool only (the selection is resolved by the server).
      for (const d of [5, 7.41]) {
        const f = await build();
        const { reply } = await row(`R7 box end loop d=${d}, edgeQuery adjacentFaceIds`, f.id, { edgeQuery: { adjacentFaceIds: [f.endFaceId] } }, d, loopVolume(d));
        requireCondition(reply.isError === (d > R), `edgeQuery d=${d}: expected ${d > R ? "a refusal" : "OK"}`);
        await undoTo(client, baseline.undoDepth);
      }
      const holed = async (thick: number, r: number) => {
        const id = await box([X, 0, 0], [40, 40, thick]);
        const current = await status(client);
        await call(client, "plasticity_create_cylinder", { centerMm: [X + 20, 20, -5], radiusMm: r, heightMm: thick + 10, revision: current.revision });
        const withTool = await status(client);
        const cylinder = withTool.bodies.find((body: { id: number }) => !current.bodies.some((old: { id: number }) => old.id === body.id)).id;
        await call(client, "plasticity_boolean", { targetIds: [id], toolIds: [cylinder], operation: "difference", revision: withTool.revision });
        const rims = (await call(client, "plasticity_find_edges", { revision: (await status(client)).revision, query: { bodyIds: [id], circle: true } })).matches;
        return { id, top: rims.filter((m: any) => Math.abs(m.centerMm[2] - thick) < 1e-6).map((m: any) => m.id), bottom: rims.filter((m: any) => Math.abs(m.centerMm[2]) < 1e-6).map((m: any) => m.id) };
      };
      for (const [thick, r, d, both] of [[4, 3, 5, false], [6, 1.6, 3, true], [20, 3, 2, false], [20, 3, 5, false], [8, 3, 5, true]] as const) {
        const f = await holed(thick, r);
        const depth = Math.min(d, both ? thick / 2 : thick);
        const hand = 1600 * thick - Math.PI * r * r * thick - (both ? 2 : 1) * rimRemoved(r, d, depth);
        await row(`hole R${r} in a ${thick} mm plate, ${both ? "both rims" : "top rim"} d=${d}`, f.id, { edgeIds: both ? [...f.top, ...f.bottom] : f.top }, d, hand);
        await undoTo(client, baseline.undoDepth);
      }
      for (const [r, d] of [[10, 3], [5, 5], [5, 5.5]] as const) {
        const before = await status(client);
        await call(client, "plasticity_create_cylinder", { centerMm: [X, 0, 0], radiusMm: r, heightMm: 20, revision: before.revision });
        const now = await status(client);
        const id = now.bodies.find((body: { id: number }) => !before.bodies.some((old: { id: number }) => old.id === body.id)).id;
        const top = (await call(client, "plasticity_find_edges", { revision: now.revision, query: { bodyIds: [id], circle: true } })).matches.filter((m: any) => Math.abs(m.centerMm[2] - 20) < 1e-6).map((m: any) => m.id);
        // Removed: the integral over depth s in 0..d of pi (r^2 - (r - d + s)^2). No chamfer exists for d > r.
        const hand = d <= r ? Math.PI * r * r * 20 - Math.PI * (r * r * d - (r ** 3 - (r - d) ** 3) / 3) : Number.NaN;
        await row(`cylinder R${r} top rim d=${d}`, id, { edgeIds: top }, d, hand);
        await undoTo(client, baseline.undoDepth);
      }
      {
        const plate = await box([X, 0, 0], [40, 40, 5]);
        const before = await status(client);
        await call(client, "plasticity_create_cylinder", { centerMm: [X + 20, 20, 5], radiusMm: 2, heightMm: 10, revision: before.revision });
        const now = await status(client);
        const boss = now.bodies.find((body: { id: number }) => !before.bodies.some((old: { id: number }) => old.id === body.id)).id;
        await call(client, "plasticity_boolean", { targetIds: [plate], toolIds: [boss], operation: "union", revision: now.revision });
        const base = (await call(client, "plasticity_find_edges", { revision: (await status(client)).revision, query: { bodyIds: [plate], circle: true } })).matches.filter((m: any) => Math.abs(m.centerMm[2] - 5) < 1e-6).map((m: any) => m.id);
        // Added: a 3 x 3 triangle (area 4.5, centroid at r = 3) swept around the boss axis.
        await row("concave boss base R2 d=3", plate, { edgeIds: base }, 3, 8000 + Math.PI * 4 * 10 + 2 * Math.PI * 3 * 4.5);
        await undoTo(client, baseline.undoDepth);
      }
      {
        const id = await box([X, 0, 0], [60, 50, 20]);
        const tool = await box([X + 15, 12, 8], [30, 26, 20]);
        let current = await status(client);
        await call(client, "plasticity_boolean", { targetIds: [id], toolIds: [tool], operation: "difference", revision: current.revision });
        current = await status(client);
        const vertical = (await call(client, "plasticity_find_edges", { revision: current.revision, query: { bodyIds: [id], line: true, direction: { vector: [0, 0, 1], toleranceDeg: 0.1 } } })).matches
          .filter((m: any) => m.centerMm[0] > X + 1 && m.centerMm[0] < X + 59 && m.centerMm[1] > 1 && m.centerMm[1] < 49);
        await call(client, "plasticity_fillet", { id, edgeIds: vertical.map((m: any) => m.id), radiusMm: 2, revision: current.revision });
        current = await status(client);
        const loop = (await call(client, "plasticity_find_edges", { revision: current.revision, query: { bodyIds: [id] }, limit: 500 })).matches
          .filter((m: any) => Math.abs(m.centerMm[2] - 20) < 1e-6 && m.boundsMm.min[0] > X + 10 && m.boundsMm.max[0] < X + 50 && m.boundsMm.min[1] > 5 && m.boundsMm.max[1] < 45);
        requireCondition(loop.length === 8, `the pocket loop has ${loop.length} edges`);
        // Removed: the 4.5 mm2 triangle along 96 mm of straight rim, plus four quarter turns of it around the R2 corner axes.
        const pocket = (30 * 26 - (4 - Math.PI) * 4) * 12;
        await row("pocket loop with R2 concave arcs d=3", id, { edgeIds: loop.map((m: any) => m.id) }, 3, 60000 - pocket - (96 * 4.5 + 4 * (Math.PI / 2) * 3 * 4.5));
        await undoTo(client, baseline.undoDepth);
      }
      // plasticity_batch with undoOnError: a box, then the 7.41 mm chamfer. The chamfer undoes itself; the batch undoes the box.
      {
        const f = await build();
        const before = await status(client);
        const reply = await callRaw(client, "plasticity_batch", { undoOnError: true, steps: [
          { toolName: "plasticity_create_box", arguments: { originMm: [X + 200, 0, 0], sizeMm: [5, 5, 5] } },
          { toolName: "plasticity_chamfer", arguments: { id: f.id, edgeIds: f.lines.slice(0, 1), distanceMm: 7.41 } },
        ] });
        const after = await status(client);
        requireCondition(reply.isError, "the batch did not fail");
        const failure = JSON.parse(reply.text);
        requireCondition(failure.failedStep === 1 && failure.undoneSteps === 1, `batch: failedStep ${failure.failedStep}, undoneSteps ${failure.undoneSteps}`);
        requireCondition(/No undo is needed for this call/.test(failure.error) && !/plasticity_undo restores/.test(failure.error), "the batch error tells the caller to undo");
        requireCondition(after.undoDepth === before.undoDepth && sameBodies(after, before), "the batch did not end with the document as before");
        rows.push({ label: "plasticity_batch undoOnError: create_box, then the d=7.41 chamfer on 1 line", tool: "refused", undoneSteps: failure.undoneSteps, documentUnchanged: true });
        await undoTo(client, baseline.undoDepth);
      }
      // Two bodies in one call: plasticity_chamfer takes one body id, so the schema refuses it before any edit.
      {
        const a = await build();
        const before = await status(client);
        const reply = await callRaw(client, "plasticity_chamfer", { id: [a.id, a.id], edgeIds: a.lines, distanceMm: 3, revision: before.revision });
        const after = await status(client);
        requireCondition(reply.isError && after.undoDepth === before.undoDepth && after.revision === before.revision, "a two-body chamfer call was not refused before any edit");
        rows.push({ label: "two bodies in one call", tool: "refused by the schema (one body id per call)", documentUnchanged: true });
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

function sameBodies(a: any, b: any): boolean {
  const key = (body: any) => JSON.stringify([body.id, body.versionId, body.faceCount, body.edgeCount, body.boundsMm]);
  return a.bodies.length === b.bodies.length && a.bodies.map(key).sort().join() === b.bodies.map(key).sort().join();
}
function round3(value: number): number { return Math.round(value * 1000) / 1000; }
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
