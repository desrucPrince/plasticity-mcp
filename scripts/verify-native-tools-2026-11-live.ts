#!/usr/bin/env node
// Live acceptance for the 2026-11 tool changes: overwrite on the file-writing tools, long undo and redo, the overlap
// volume of plasticity_check_interference, and the absence of a whole-body clearance tool.
//
// Every case builds its own bodies in an isolated, empty test document, reads the results back independently
// (files from disk, plasticity_status for the revision and the Undo and Redo depths) and restores the document by Undo
// to the baseline Undo depth and body list. It never saves, opens or closes a document.
import { lstat, mkdir, readdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { isolatedAcceptanceEnvironment } from "./native-live-environment.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
type Check = { case: string; check: string; ok: boolean; detail?: unknown };
const CASES = ["overwrite", "history", "overlap", "clearance"] as const;
const HISTORY_MOVES = 600;
const CALL_TIMEOUT_MS = 600_000;

interface Options { help: boolean; target?: string; output?: string; allowDisposableMutations: boolean; cases: string[] }

export function parseTools202611Args(argv: string[]): Options {
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
  if (!options.target) throw new Error("Live tools-2026-11 acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live tools-2026-11 acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live tools-2026-11 acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  PLASTICITY_CDP_URL=http://127.0.0.1:PORT node scripts/verify-native-tools-2026-11-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY [--case ${CASES.join(",")}]

Cases: overwrite (STEP, STL and screenshot: refused by default, replaced with overwrite: true, a directory and a
symbolic link refused, a failed call leaves the old file as it was); history (${HISTORY_MOVES} moves, all undone by one
plasticity_undo call and restored by one plasticity_redo call); overlap (exact overlap volumes against analytic values,
zero volume for bodies that touch, in both body orders, with the revision and the Undo and Redo depths unchanged by every
call); clearance (no whole-body clearance tool is registered). The document must be empty at the start (an isolated
instance, npm run start:plasticity-isolated). The script restores the Undo depth and the body list and writes
evidence.json to the new output directory.`;

// ---------- MCP plumbing ----------
async function startMcp(storeRoot: string): Promise<Client> {
  const env = { ...isolatedAcceptanceEnvironment(storeRoot, process.env), PLASTICITY_AUTO_LAUNCH: "0", PLASTICITY_HUD: "0", PLASTICITY_TIMING: "1", PLASTICITY_MCP_STATE_DIR: process.env.PLASTICITY_MCP_STATE_DIR ?? join(storeRoot, "state") };
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env, stderr: "pipe" });
  const client = new Client({ name: "plasticity-tools-2026-11-live", version: "1.0.0" });
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
    const response = await this.client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
    const text = toolText(response);
    if ((response as { isError?: boolean }).isError) throw new Error(text);
    return JSON.parse(text);
  }
  /** A call that may fail: the reply, or the error text. */
  async attempt(name: string, args: Record<string, unknown>): Promise<{ ok: true; reply: any } | { ok: false; error: string }> {
    const response = await this.client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
    const text = toolText(response);
    if ((response as { isError?: boolean }).isError) return { ok: false, error: text };
    return { ok: true, reply: JSON.parse(text) };
  }
  async status(): Promise<any> { return await this.call("plasticity_status", {}); }
  async revision(): Promise<string> { return (await this.status()).revision; }
  check(caseName: string, check: string, ok: boolean, detail?: unknown): boolean {
    this.checks.push({ case: caseName, check, ok, ...(detail === undefined ? {} : { detail }) });
    return ok;
  }
  /** Builds named bodies in one batch and returns their ids by name. */
  async build(steps: Array<{ toolName: string; arguments: Record<string, unknown> }>): Promise<Record<string, number>> {
    await this.call("plasticity_batch", { detail: "lean", steps });
    const status = await this.status();
    return Object.fromEntries(status.bodies.filter((body: { name: string | null }) => body.name).map((body: { name: string; id: number }) => [body.name, body.id]));
  }
  async restore(caseName: string): Promise<void> {
    for (let guard = 0; guard < 50; guard += 1) {
      const status = await this.status();
      if (status.undoDepth <= this.baseline.undoDepth) break;
      await this.call("plasticity_undo", { steps: Math.min(status.undoDepth - this.baseline.undoDepth, 5_000), intent: "tools-2026-11 acceptance restore", revision: status.revision });
    }
    const status = await this.status();
    const ids = status.bodies.map((body: { id: number }) => body.id).sort((a: number, b: number) => a - b);
    this.check(caseName, "document restored: Undo depth and body list equal the baseline", status.undoDepth === this.baseline.undoDepth && JSON.stringify(ids) === JSON.stringify(this.baseline.bodyIds), { undoDepth: status.undoDepth, bodies: ids.length });
  }
}

const box = (name: string, originMm: number[], sizeMm: number[]) => ({ toolName: "plasticity_create_box", arguments: { originMm, sizeMm, name, intent: "tools-2026-11 acceptance" } });
const cylinder = (name: string, centerMm: number[], radiusMm: number, heightMm: number) => ({ toolName: "plasticity_create_cylinder", arguments: { centerMm, radiusMm, heightMm, name, intent: "tools-2026-11 acceptance" } });
const relative = (value: number, expected: number) => Math.abs(value - expected) / expected;

// ---------- case: overwrite ----------
async function caseOverwrite(live: Live, output: string): Promise<void> {
  const name = "overwrite";
  const folder = join(output, "files");
  await mkdir(folder, { mode: 0o700 });
  const ids = await live.build([box("old", [0, 0, 0], [10, 10, 10]), cylinder("new", [40, 0, 0], 4, 12)]);
  const entries = async () => (await readdir(folder)).sort();
  const expected: string[] = [];

  // One file-writing tool: `write` makes the call for a body (or view) variant; `fail` is a call that must fail.
  const exercise = async (tool: string, file: string, write: (variant: "old" | "new", path: string, extra: Record<string, unknown>) => Promise<{ ok: true; reply: any } | { ok: false; error: string }>, fail: (path: string) => Promise<{ ok: true; reply: any } | { ok: false; error: string }>) => {
    const path = join(folder, file);
    expected.push(file);
    const first = await write("old", path, {});
    live.check(name, `${tool}: writes a new file`, first.ok && (await lstat(path)).isFile(), first.ok ? { bytes: first.reply.bytes } : first.error);
    const old = await readFile(path);

    const refused = await write("new", path, {});
    live.check(name, `${tool}: an existing file is refused without the option, and the refusal names it`, !refused.ok && /Refusing to overwrite existing file: /.test(refused.error) && /overwrite: true/.test(refused.error), refused.ok ? "the call succeeded" : refused.error.slice(0, 300));
    const explicit = await write("new", path, { overwrite: false });
    live.check(name, `${tool}: overwrite: false is refused the same way; the file is byte-identical`, !explicit.ok && (await readFile(path)).equals(old));

    const replaced = await write("new", path, { overwrite: true });
    const now = await readFile(path);
    live.check(name, `${tool}: overwrite: true replaces the file (${old.length} -> ${now.length} bytes) and its content differs`, replaced.ok && !now.equals(old) && replaced.ok && replaced.reply.bytes === now.length && (await lstat(path)).isFile(), replaced.ok ? { bytes: replaced.reply.bytes } : replaced.error);
    live.check(name, `${tool}: no temporary file or staging folder remains`, JSON.stringify(await entries()) === JSON.stringify([...expected].sort()), await entries());

    const failed = await fail(path);
    live.check(name, `${tool}: a failed call with overwrite: true leaves the old file byte-identical and nothing else behind`, !failed.ok && (await readFile(path)).equals(now) && JSON.stringify(await entries()) === JSON.stringify([...expected].sort()), failed.ok ? "the call succeeded" : failed.error.slice(0, 200));

    // A directory and a symbolic link at the path are refused, and nothing is written through the link.
    const extension = file.slice(file.lastIndexOf("."));
    const directory = join(folder, `directory-${tool}${extension}`);
    const link = join(folder, `link-${tool}${extension}`);
    await mkdir(directory);
    await symlink(path, link);
    expected.push(`directory-${tool}${extension}`, `link-${tool}${extension}`);
    const intoDirectory = await write("old", directory, { overwrite: true });
    live.check(name, `${tool}: a directory is refused with overwrite: true`, !intoDirectory.ok && /is a directory; overwrite: true replaces a regular file only/.test(intoDirectory.error) && (await readdir(directory)).length === 0, intoDirectory.ok ? "the call succeeded" : intoDirectory.error.slice(0, 200));
    const intoLink = await write("old", link, { overwrite: true });
    live.check(name, `${tool}: a symbolic link is refused with overwrite: true; its target is untouched and it is still a link`, !intoLink.ok && /is a symbolic link; overwrite: true replaces a regular file only/.test(intoLink.error) && (await readFile(path)).equals(now) && (await lstat(link)).isSymbolicLink() && (await readlink(link)) === path, intoLink.ok ? "the call succeeded" : intoLink.error.slice(0, 200));
    const wrongExtension = await write("old", join(folder, `wrong-${tool}.txt`), { overwrite: true });
    live.check(name, `${tool}: a wrong extension is refused as before, also with overwrite: true`, !wrongExtension.ok && /must end in/.test(wrongExtension.error), wrongExtension.ok ? "the call succeeded" : wrongExtension.error.slice(0, 200));
    live.check(name, `${tool}: the folder holds only the expected entries`, JSON.stringify(await entries()) === JSON.stringify([...expected].sort()), await entries());
  };

  await exercise("plasticity_export_step", "part.step",
    async (variant, path, extra) => await live.attempt("plasticity_export_step", { ids: [ids[variant]], path, revision: await live.revision(), ...extra }),
    async (path) => await live.attempt("plasticity_export_step", { ids: [999_999], path, revision: await live.revision(), overwrite: true }));
  await exercise("plasticity_export_stl", "part.stl",
    async (variant, path, extra) => await live.attempt("plasticity_export_stl", { ids: [ids[variant]], path, revision: await live.revision(), ...extra }),
    async (path) => await live.attempt("plasticity_export_stl", { ids: [999_999], path, revision: await live.revision(), overwrite: true }));
  // The screenshot renders the viewport (no window is brought to the front). The two variants frame different bodies.
  await exercise("plasticity_screenshot", "view.png",
    async (variant, path, extra) => await live.attempt("plasticity_screenshot", { path, captureMode: "viewport", frame: { bodyIds: [ids[variant]] }, ...extra }),
    async (path) => await live.attempt("plasticity_screenshot", { path, captureMode: "viewport", frame: { bodyIds: [999_999] }, overwrite: true }));
  const inline = await live.attempt("plasticity_screenshot", { overwrite: true });
  live.check(name, "plasticity_screenshot: overwrite: true without path is refused (an inline screenshot writes no file)", !inline.ok && /overwrite: true needs path/.test(inline.error));
  // A file the script wrote itself is replaced as well: the rule is about the entry at the path, not who made it.
  const foreign = join(folder, "foreign.step");
  await writeFile(foreign, "not a STEP file\n");
  expected.push("foreign.step");
  const overForeign = await live.attempt("plasticity_export_step", { ids: [ids.old], path: foreign, revision: await live.revision(), overwrite: true });
  live.check(name, "plasticity_export_step: overwrite: true replaces a regular file of any content", overForeign.ok && (await readFile(foreign, "utf8")).startsWith("ISO-10303-21;"));
}

// ---------- case: history ----------
async function caseHistory(live: Live): Promise<void> {
  const name = "history";
  const start = await live.status();
  const ids = await live.build([box("mover", [0, 0, 0], [10, 10, 10]), box("still", [30, 0, 0], [5, 5, 5])]);
  const buildStarted = performance.now();
  for (let done = 0; done < HISTORY_MOVES; done += 50) {
    await live.call("plasticity_batch", { detail: "lean", steps: Array.from({ length: 50 }, (_, index) => ({ toolName: "plasticity_move", arguments: { ids: [ids.mover], deltaMm: [0, 0, (done + index) % 2 === 0 ? 1 : -1], intent: "tools-2026-11 acceptance" } })) });
  }
  const built = await live.status();
  const steps = built.undoDepth - start.undoDepth;
  live.check(name, `built ${steps} Undo steps (${HISTORY_MOVES} moves and the two boxes) in ${Math.round(performance.now() - buildStarted)} ms`, steps >= HISTORY_MOVES && steps === HISTORY_MOVES + 2 && built.bodies.length === start.bodies.length + 2, { undoDepth: [start.undoDepth, built.undoDepth] });
  const bounds = (status: any) => JSON.stringify(status.bodies.map((body: { id: number; boundsMm: unknown }) => [body.id, body.boundsMm]));

  const undoStarted = performance.now();
  const undone = await live.attempt("plasticity_undo", { steps, intent: "tools-2026-11 acceptance", revision: built.revision });
  const undoMs = Math.round(performance.now() - undoStarted);
  const afterUndo = await live.status();
  live.check(name, `one plasticity_undo call with ${steps} steps returns without a time-out (${undoMs} ms)`, undone.ok && undoMs < 120_000, undone.ok ? { timing: undone.reply.timing } : undone.error.slice(0, 400));
  if (undone.ok) {
    live.check(name, "its reply is definite: stepsRequested, stepsDone, stepsRemaining 0, no stopped", undone.reply.stepsRequested === steps && undone.reply.stepsDone === steps && undone.reply.stepsRemaining === 0 && !("stopped" in undone.reply), { stepsRequested: undone.reply.stepsRequested, stepsDone: undone.reply.stepsDone, stepsRemaining: undone.reply.stepsRemaining, stopped: undone.reply.stopped });
    live.check(name, "the reply's revision and depths are the document's", undone.reply.revision === afterUndo.revision && undone.reply.undoDepth === afterUndo.undoDepth && undone.reply.redoDepth === afterUndo.redoDepth);
  }
  live.check(name, "the document is as at the start: the Undo depth and the body list", afterUndo.undoDepth === start.undoDepth && afterUndo.bodies.length === start.bodies.length && afterUndo.redoDepth === steps, { undoDepth: afterUndo.undoDepth, redoDepth: afterUndo.redoDepth, bodies: afterUndo.bodies.length });

  const redoStarted = performance.now();
  const redone = await live.attempt("plasticity_redo", { steps, intent: "tools-2026-11 acceptance", revision: afterUndo.revision });
  const redoMs = Math.round(performance.now() - redoStarted);
  const afterRedo = await live.status();
  live.check(name, `one plasticity_redo call with ${steps} steps restores them (${redoMs} ms)`, redone.ok && redone.reply.stepsDone === steps && redone.reply.stepsRemaining === 0 && afterRedo.undoDepth === built.undoDepth && afterRedo.redoDepth === 0, redone.ok ? { stepsDone: redone.reply.stepsDone, undoDepth: afterRedo.undoDepth } : redone.error.slice(0, 400));
  live.check(name, "after the redo every body is where it was (ids and exact bounds)", bounds(afterRedo) === bounds(built), { bodies: afterRedo.bodies.length });

  // The Redo history is empty now: more steps than exist stop with a definite count.
  const beyond = await live.attempt("plasticity_redo", { steps: 5, intent: "tools-2026-11 acceptance", revision: afterRedo.revision });
  live.check(name, "a redo past the end of the history says so: stepsDone 0, stepsRemaining 5, stopped history-empty", beyond.ok && beyond.reply.stepsDone === 0 && beyond.reply.stepsRemaining === 5 && beyond.reply.stopped === "history-empty" && (await live.status()).undoDepth === built.undoDepth, beyond.ok ? { stopped: beyond.reply.stopped } : beyond.error.slice(0, 300));
  live.evidence.history = { steps, undoMs, redoMs, perStepMs: Math.round((undoMs / steps) * 100) / 100 };
}

// ---------- case: overlap ----------
async function caseOverlap(live: Live): Promise<void> {
  const name = "overlap";
  const ids = await live.build([
    box("a", [0, 0, 0], [10, 10, 10]),
    box("overlap", [6, 0, 0], [10, 10, 10]),          // shares 4 x 10 x 10 with a
    cylinder("half", [10, 5, 0], 3, 10),               // its axis lies on the face x = 10 of a: half of it is inside
    cylinder("through", [5, 5, -5], 3, 20),            // passes through a along z
    box("face", [10, 0, 0], [10, 10, 10]),             // shares the whole face x = 10
    box("partface", [10, 5, 0], [10, 10, 10]),         // shares half of that face
    box("edge", [10, 10, 0], [10, 10, 10]),            // shares one edge
    box("vertex", [10, 10, 10], [10, 10, 10]),         // shares one vertex
    box("apart", [13, 0, 0], [10, 10, 10]),            // 3 mm away
    box("inside", [2, 2, 2], [3, 3, 3]),               // strictly inside a
    box("insidetouch", [0, 0, 0], [5, 5, 5]),          // inside a, on three of its faces
  ]);
  const tools = (await live.client.listTools()).tools;
  const tool = tools.find((item) => item.name === "plasticity_check_interference");
  live.check(name, "plasticity_check_interference is registered read-only and says so", tool?.annotations?.readOnlyHint === true && /Read-only: the check does not change the document, its revision or its Undo and Redo history/.test(tool?.description ?? ""));

  const statuses = new Set<string>();
  const results: Record<string, unknown> = {};
  /** One call for one ordered pair, with the read-only proof around it. */
  const pair = async (first: string, second: string) => {
    const before = await live.status();
    const reply = await live.call("plasticity_check_interference", { pairs: [{ firstBodyId: ids[first], secondBodyId: ids[second] }], revision: before.revision });
    const after = await live.status();
    const identity = (status: any) => JSON.stringify(status.bodies.map((body: { id: number; versionId: number }) => [body.id, body.versionId]));
    const unchanged = before.revision === after.revision && before.undoDepth === after.undoDepth && before.redoDepth === after.redoDepth && identity(before) === identity(after);
    live.check(name, `${first} | ${second}: the revision, the Undo depth, the Redo depth and the bodies are unchanged by the call`, unchanged && reply.revision === before.revision, { revision: [before.revision, after.revision], undoDepth: [before.undoDepth, after.undoDepth], redoDepth: [before.redoDepth, after.redoDepth] });
    const result = reply.pairs[0];
    statuses.add(result.status);
    results[`${first}|${second}`] = { status: result.status, reasons: result.reasons, overlapVolumeMm3: result.overlapVolumeMm3, overlapBoundsMm: result.overlapBoundsMm, kernelEvidence: result.kernelEvidence };
    return result;
  };
  const volumeCase = async (label: string, second: string, expected: number, boundsMm: { min: number[]; max: number[] }) => {
    for (const [x, y] of [["a", second], [second, "a"]] as const) {
      const result = await pair(x, y);
      const error = typeof result.overlapVolumeMm3 === "number" ? relative(result.overlapVolumeMm3, expected) : Number.NaN;
      live.check(name, `${x} | ${y} (${label}): interfere, overlapVolumeMm3 ${result.overlapVolumeMm3} equals ${expected} within 1e-6 relative (${error.toExponential(2)})`, result.status === "interfere" && error <= 1e-6, result);
      const bounds = result.overlapBoundsMm;
      live.check(name, `${x} | ${y}: overlapBoundsMm and the bodies' volumes agree with the overlap`, !!bounds && bounds.min.every((value: number, axis: number) => Math.abs(value - boundsMm.min[axis]!) <= 1e-6) && bounds.max.every((value: number, axis: number) => Math.abs(value - boundsMm.max[axis]!) <= 1e-6)
        && Math.abs(result.intersectionBodies.reduce((sum: number, body: { volumeMm3: number }) => sum + body.volumeMm3, 0) - result.overlapVolumeMm3) <= 1e-9, { bounds, bodies: result.intersectionBodies?.length });
    }
  };
  await volumeCase("two boxes that share 4 x 10 x 10 mm", "overlap", 400, { min: [6, 0, 0], max: [10, 10, 10] });
  await volumeCase("half of a cylinder r 3, h 10", "half", (Math.PI * 9 * 10) / 2, { min: [7, 2, 0], max: [10, 8, 10] });
  await volumeCase("a cylinder r 3 through 10 mm", "through", Math.PI * 9 * 10, { min: [2, 2, 0], max: [8, 8, 10] });
  await volumeCase("a 3 mm box strictly inside", "inside", 27, { min: [2, 2, 2], max: [5, 5, 5] });
  await volumeCase("a 5 mm box inside, on three faces", "insidetouch", 125, { min: [0, 0, 0], max: [5, 5, 5] });

  const zeroCase = async (label: string, second: string, contact: boolean) => {
    for (const [x, y] of [["a", second], [second, "a"]] as const) {
      const result = await pair(x, y);
      live.check(name, `${x} | ${y} (${label}): no-volumetric-interference with overlapVolumeMm3 0${contact ? " and the reason contact-without-volume" : ", no contact"}`,
        result.status === "no-volumetric-interference" && result.overlapVolumeMm3 === 0 && result.reasons.includes("native-intersection-has-no-volume") && result.reasons.includes("contact-without-volume") === contact && result.intersectionBodies === undefined, result);
    }
  };
  await zeroCase("two boxes that share a face", "face", true);
  await zeroCase("two boxes that share part of a face", "partface", true);
  await zeroCase("two boxes that share an edge", "edge", true);
  await zeroCase("two boxes that share a vertex", "vertex", true);
  await zeroCase("two boxes 3 mm apart", "apart", false);

  // Several pairs in one call keep their order and their results.
  const before = await live.status();
  const many = await live.call("plasticity_check_interference", { pairs: [{ firstBodyId: ids.a, secondBodyId: ids.overlap }, { firstBodyId: ids.face, secondBodyId: ids.a }, { firstBodyId: ids.inside, secondBodyId: ids.a }], revision: before.revision });
  const after = await live.status();
  live.check(name, "three pairs in one call: 400 mm3, 0 mm3 by contact, 27 mm3 (the body inside comes first); document unchanged",
    many.pairs.length === 3 && relative(many.pairs[0].overlapVolumeMm3, 400) <= 1e-6 && many.pairs[1].status === "no-volumetric-interference" && many.pairs[1].overlapVolumeMm3 === 0 && many.pairs[2].status === "interfere" && relative(many.pairs[2].overlapVolumeMm3, 27) <= 1e-6
    && before.revision === after.revision && before.undoDepth === after.undoDepth && before.redoDepth === after.redoDepth, many.pairs.map((item: any) => [item.status, item.overlapVolumeMm3, item.reasons]));
  for (const item of many.pairs) statuses.add(item.status);
  live.check(name, "only the known status values were returned", [...statuses].every((status) => ["interfere", "no-volumetric-interference", "unsupported"].includes(status)), [...statuses]);
  live.evidence.overlap = results;
}

// ---------- case: clearance ----------
async function caseClearance(live: Live): Promise<void> {
  const tools = (await live.client.listTools()).tools.map((tool) => tool.name);
  live.check("clearance", "no plasticity_measure_body_clearance is registered (the kernel exposes no exact distance between two solids: discovery/tools-2026-11/FINDINGS.md)", !tools.includes("plasticity_measure_body_clearance"));
  live.check("clearance", "the exact face-pair clearance tools are still there", tools.includes("plasticity_measure_parallel_planar_face_clearance") && tools.includes("plasticity_measure_nonparallel_planar_polygon_clearance"));
}

async function main(): Promise<void> {
  const options = parseTools202611Args(process.argv.slice(2));
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
    const connected = await live.call("plasticity_connect", { targetId: options.target });
    if (connected.targetId !== options.target) throw new Error("The server connected to another Plasticity window");
    const status = await live.status();
    if (status.bodies.length !== 0) throw new Error(`The test document must be empty at the start; it has ${status.bodies.length} bodies`);
    live.baseline = { undoDepth: status.undoDepth, bodyIds: [], revision: status.revision };
    live.evidence.baseline = { ...live.baseline, redoDepth: status.redoDepth };
    const cases: Record<string, () => Promise<void>> = { overwrite: () => caseOverwrite(live, output), history: () => caseHistory(live), overlap: () => caseOverlap(live), clearance: () => caseClearance(live) };
    for (const name of options.cases) {
      try {
        await cases[name]!();
      } catch (error) {
        live.check(name, "case ran to the end", false, error instanceof Error ? error.message.slice(0, 2000) : String(error));
      } finally {
        await live.restore(name);
      }
    }
  } finally {
    if (live.baseline) { try { await live.restore("final"); } catch (error) { live.check("final", "final restore", false, String(error)); } }
    try {
      const end = await live.status();
      live.evidence.end = { undoDepth: end.undoDepth, redoDepth: end.redoDepth, bodies: end.bodies.length };
    } catch (error) { live.evidence.end = { error: String(error) }; }
    live.evidence.checks = live.checks;
    live.evidence.finishedAt = new Date().toISOString();
    await writeFile(join(output, "evidence.json"), `${JSON.stringify(live.evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await client.close();
  }
  const failed = live.checks.filter((check) => !check.ok);
  for (const check of live.checks) console.log(`${check.ok ? "PASS" : "FAIL"}  [${check.case}] ${check.check}`);
  for (const check of failed) console.log(`  detail [${check.case}] ${check.check}: ${JSON.stringify(check.detail)?.slice(0, 1500)}`);
  console.log(`\n${live.checks.length - failed.length}/${live.checks.length} checks passed; evidence: evidence.json in the output directory`);
  const end = live.evidence.end as { undoDepth?: number; bodies?: number } | undefined;
  const restored = !!end && end.undoDepth === live.baseline?.undoDepth && end.bodies === 0;
  console.log(`baseline ${restored ? "restored" : "NOT restored"}: Undo depth ${end?.undoDepth}, ${end?.bodies} bodies (start: Undo depth ${live.baseline?.undoDepth}, 0 bodies)`);
  if (failed.length > 0 || !restored) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
