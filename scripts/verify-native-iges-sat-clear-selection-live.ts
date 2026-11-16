#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hydrateNativeState } from "./native-live-state.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface IgesSatClearSelectionOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseIgesSatClearSelectionArgs(argv: string[]): IgesSatClearSelectionOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: IgesSatClearSelectionOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live IGES/SAT/clear-selection acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live IGES/SAT/clear-selection acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live IGES/SAT/clear-selection acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-iges-sat-clear-selection-live.ts --help
  node scripts/verify-native-iges-sat-clear-selection-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
PLASTICITY_CDP_URL is mandatory: set it to the isolated Plasticity instance. The command never launches Plasticity
(it forces PLASTICITY_AUTO_LAUNCH=0 and PLASTICITY_HUD=0) and refuses to start without the variable.
Live mode takes a baseline, creates one disposable box, exports it to IGES (.igs and .iges) and SAT,
checks the saved .igs, .iges and .sat files, selects the box, clears the selection, checks the selection
is empty and that clearing added no Undo entry, then undoes back to the baseline.
It never saves the document. Run it only against an isolated Plasticity instance.`;

async function main(): Promise<void> {
  const options = parseIgesSatClearSelectionArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  if (!process.env.PLASTICITY_CDP_URL) throw new Error("PLASTICITY_CDP_URL is mandatory and must name the isolated Plasticity instance; nothing was created");
  await mkdir(output, { mode: 0o700 });
  const igesPath = join(output, "box-20x10x5.igs");
  const longIgesPath = join(output, "box-20x10x5.iges");
  const satPath = join(output, "box-20x10x5.sat");
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target! };
  const serverStderr: string[] = [];
  let live: LiveMcp | undefined;
  let baseline: any;
  try {
    live = await startMcp(serverStderr);
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    baseline = await call(live.client, "plasticity_connect", { targetId: options.target });
    evidence.baseline = stateSummary(baseline);

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [2000, 0, 0], sizeMm: [20, 10, 5], name: "IGES SAT exchange box",
      intent: "Approved disposable IGES, SAT and clear-selection acceptance", revision: baseline.revision,
    });
    const created = state.bodies.filter((body: { id: number }) => !baseline.bodies.some((old: { id: number }) => old.id === body.id));
    requireCondition(created.length === 1 && created[0].type === "Solid", "Box creation did not add exactly one Solid");
    const box = created[0];

    const igesExport = await call(live.client, "plasticity_export_iges", { ids: [box.id], path: igesPath, revision: state.revision });
    const longIgesExport = await call(live.client, "plasticity_export_iges", { ids: [box.id], path: longIgesPath, revision: state.revision });
    const satExport = await call(live.client, "plasticity_export_sat", { ids: [box.id], path: satPath, revision: state.revision });
    const afterExports = await call(live.client, "plasticity_status", {});
    for (const field of ["documentToken", "revision", "undoDepth", "redoDepth"] as const) requireCondition(state[field] === afterExports[field], `Export changed ${field}`);
    const igesFile = await readFile(igesPath);
    const longIgesFile = await readFile(longIgesPath);
    const satFile = await readFile(satPath);
    requireIgesStart(igesFile);
    requireIgesStart(longIgesFile);
    requireSatHeader(satFile);
    requireCondition(igesExport.bytes === igesFile.length && longIgesExport.bytes === longIgesFile.length && satExport.bytes === satFile.length, "Export byte counts do not match saved files");
    evidence.exports = { iges: igesExport, igesLongExtension: longIgesExport, sat: satExport };

    await call(live.client, "plasticity_select_bodies", { ids: [box.id], revision: state.revision });
    const selected = await call(live.client, "plasticity_current_selection", {});
    requireCondition(selected.bodyIds.includes(box.id), "The box is not selected before clearing");
    const beforeClear = await call(live.client, "plasticity_status", {});
    const cleared = await call(live.client, "plasticity_clear_selection", { revision: beforeClear.revision });
    requireEmptySelection(cleared, "clear_selection result");
    requireEmptySelection(await call(live.client, "plasticity_current_selection", {}), "current selection after clear");
    const afterClear = await call(live.client, "plasticity_status", {});
    requireCondition(afterClear.undoDepth === beforeClear.undoDepth && afterClear.redoDepth === beforeClear.redoDepth, "Clearing the selection changed the Undo history");
    evidence.clearSelection = { undoDepth: afterClear.undoDepth, selectionEmpty: true };

    state = afterClear;
    for (let count = 0; state.undoDepth > baseline.undoDepth && count < 8; count += 1) {
      state = await call(live.client, "plasticity_undo", { intent: "Return to the IGES/SAT acceptance baseline", revision: state.revision });
    }
    requireBaseline(state, baseline);
    evidence.restoredBaseline = true;
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), evidence);
    console.log(JSON.stringify({ ok: true, output, files: [igesPath, longIgesPath, satPath], evidence: join(output, "evidence.json") }, null, 2));
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
  const client = new Client({ name: "plasticity-iges-sat-clear-selection-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const text = toolText(response);
  if ("isError" in response && response.isError) throw new Error(text);
  return await hydrateNativeState(JSON.parse(text), id => call(client, "plasticity_body_info", { id }), (offset, revision) => call(client, "plasticity_list_bodies", { bodyOffset: offset, bodyLimit: 100, expectedRevision: revision }));
}

function toolText(response: unknown): string {
  if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content");
  const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string");
  if (!item) throw new Error("MCP tool returned no text content");
  return item.text;
}

async function recover(client: Client, initial: any): Promise<Record<string, unknown>> {
  for (let count = 0; count < 16; count += 1) {
    const status = await call(client, "plasticity_status", {});
    if (status.documentToken !== initial.documentToken) return { restored: false, reason: "document-changed" };
    if (status.undoDepth <= initial.undoDepth) return { restored: status.bodies.length === initial.bodies.length };
    await call(client, "plasticity_undo", { intent: "Recover IGES/SAT/clear-selection acceptance", revision: status.revision });
  }
  return { restored: false, reason: "undo-limit" };
}

function requireBaseline(state: any, baseline: any): void {
  requireCondition(state.documentToken === baseline.documentToken && state.undoDepth === baseline.undoDepth, "Undo did not return to the baseline history depth");
  requireCondition(JSON.stringify(state.bodies.map((body: { id: number }) => body.id)) === JSON.stringify(baseline.bodies.map((body: { id: number }) => body.id)), "Undo did not restore the baseline bodies");
}

function requireEmptySelection(selection: any, label: string): void {
  for (const field of ["bodyIds", "curveIds", "instanceIds", "referenceMeshIds", "groupIds", "faces", "edges", "regionIds", "curveControlPoints"]) {
    requireCondition(Array.isArray(selection[field]) && selection[field].length === 0, `${label}: ${field} is not empty`);
  }
}

function requireIgesStart(data: Buffer): void {
  const line = data.toString("latin1").split(/\r?\n/u, 1)[0] ?? "";
  requireCondition(data.length > 0 && line.length >= 73 && line[72] === "S", "IGES file does not start with a Start-section line");
}

function requireSatHeader(data: Buffer): void {
  const line = data.toString("latin1").split(/\r?\n/u, 1)[0] ?? "";
  requireCondition(data.length > 0 && /^\d+ \d+ \d+ \d+\s*$/u.test(line), "SAT file header is invalid");
}

function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length }; }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL", "PLASTICITY_AUTO_LAUNCH", "PLASTICITY_HUD", "PLASTICITY_MCP_STATE_DIR", "PLASTICITY_CONSTRUCTION_HISTORY_ROOT"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
