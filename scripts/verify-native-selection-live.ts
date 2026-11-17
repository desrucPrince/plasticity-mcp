#!/usr/bin/env node
// Live acceptance for the selection guard (src/plasticity/runtime.ts, SELECTION_GUARD_SOURCE).
//
// 1. Matrix: 13 edit tools x 8 selection states. Every call must return in its normal time, with the right geometry,
//    with the surviving part of the selection put back, with no command active and with the session not uncertain.
// 2. 20 edits in a row with a face of an untouched body selected, with no slowdown.
// 3. Entry states: a default command idling in Awaiting; a command of the user awaiting its dialog (pass-through).
// 4. A refused edit, a history step whose state holds a face selection, and plasticity_reconcile clearing an idle
//    default command that was left behind: one made by the script, and (with --baseline-root) the one that the
//    server before the guard really leaves when its call times out.
// 5. A gizmo the user is using, made with real mouse events: an untouched gizmo is left by every call that runs no
//    command and cancelled by an edit; a gizmo with a dragged preview (button held, then released) is left by every
//    call, and edits are refused with "the user is editing". A call that was given up: a click after the timeout keeps
//    its gizmo and its selection when the source settles; plasticity_reconcile puts a set-aside selection back.
// 6. Speed with nothing selected. plasticity_move: this tree's server against the server of the tree before the
//    guard (--baseline-root), calls interleaved, the median may rise by 5 ms. The 5-step batch: its five native calls
//    with the guard on and off in one process (judged, 5 ms), and the whole call through both servers (reported: its
//    median is not stable to 5 ms on a renderer whose garbage collections take seconds).
//
// The executor (active command, its agent and state) and the selection memento are read directly over CDP with
// runtime.read(), independently of the server. The script restores the Undo depth and the body list it found, clears
// the selection, and never saves, opens or closes a document.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { discoverPlasticityTargets } from "../src/cdp/discovery.ts";
import { nativeFunction } from "../src/plasticity/native-function.ts";
import { PlasticityOperations } from "../src/plasticity/operations.ts";
import { PlasticityRuntime, selectionSafeSource } from "../src/plasticity/runtime.ts";
import { isolatedAcceptanceEnvironment } from "./native-live-environment.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
type Vec = [number, number, number];
type Check = { section: string; check: string; ok: boolean; detail?: unknown };
const X0 = 3000; // every fixture is built at x >= 3000 mm, away from the document's own bodies
const SINGLE_EDIT_LIMIT_MS = 1_500;
const MULTI_STEP_LIMIT_MS = 5_000;
const SPEED_LIMIT_MS = 5;

interface Options { help: boolean; target?: string; output?: string; allowDisposableMutations: boolean; baselineRoot?: string; skipSpeed: boolean; sections: string[] }
const SECTIONS = ["matrix", "repeat", "entry", "recovery", "gizmo", "speed"] as const;

export function parseSelectionArgs(argv: string[]): Options {
  const options: Options = { help: argv.length === 0, allowDisposableMutations: false, skipSpeed: false, sections: [...SECTIONS] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--skip-speed") options.skipSpeed = true;
    else if (argument === "--target" || argument === "--output" || argument === "--baseline-root" || argument === "--section") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--target") options.target = value;
      else if (argument === "--output") options.output = value;
      else if (argument === "--baseline-root") options.baselineRoot = resolve(value);
      else {
        const picked = value.split(",");
        if (picked.some((item) => !(SECTIONS as readonly string[]).includes(item))) throw new Error(`--section takes ${SECTIONS.join(", ")} (comma-separated)`);
        options.sections = picked;
      }
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live selection acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live selection acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live selection acceptance requires --output with a new directory");
  if (options.sections.includes("speed") && !options.skipSpeed && !options.baselineRoot) throw new Error("The speed check compares against the tree before the selection guard: pass --baseline-root DIRECTORY (a checkout of that commit with node_modules), or --skip-speed");
  return options;
}

const HELP = `Usage:
  PLASTICITY_CDP_URL=http://127.0.0.1:PORT node scripts/verify-native-selection-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY --baseline-root DIRECTORY [--section ${SECTIONS.join(",")}] [--skip-speed]

Sections: matrix (13 tools x 8 selection states), repeat (20 edits with a face of an untouched body selected), entry (a
default command awaiting at entry; a command of the user awaiting at entry), recovery (a failing edit, an Undo over a
history step that holds a face selection, plasticity_reconcile), gizmo (real clicks and a real drag: an untouched and a
dragged default gizmo against reads, exports, a section analysis, a screenshot, reconcile and edits; a call that was
given up, a click after it, reconcile; the camera is set for the clicks and put back), speed (plasticity_move and a 5-step batch with nothing
selected; plasticity_move interleaved against the server of --baseline-root and the batch's five native calls with
the guard on and off: each median may rise by at most ${SPEED_LIMIT_MS} ms; the whole batch through both servers is reported).

--baseline-root is a copy of the commit before the selection guard, with node_modules, for example:
  mkdir /tmp/base && git archive <commit> | tar -x -C /tmp/base && ln -s "$PWD/node_modules" /tmp/base/node_modules
Builds at x >= ${X0} mm in an isolated instance only (npm run start:plasticity-isolated), restores the Undo depth and the
body list it found, clears the selection, and writes evidence.json to the new output directory.`;

const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2; };
const round1 = (value: number) => Math.round(value * 10) / 10;
const near = (a: Vec, b: Vec, tolerance = 1e-6) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tolerance;

// ---------- MCP plumbing ----------
async function startMcp(root: string, storeRoot: string, name: string): Promise<Client> {
  const env = { ...isolatedAcceptanceEnvironment(storeRoot, process.env), PLASTICITY_AUTO_LAUNCH: "0", PLASTICITY_HUD: "0", PLASTICITY_MCP_STATE_DIR: join(storeRoot, "state") };
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "scripts", "run-server.ts")], cwd: root, env, stderr: "pipe" });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return client;
}
function toolText(response: unknown): string {
  const content = (response as { content?: Array<{ type: string; text?: string }> }).content;
  const item = content?.find((entry) => entry.type === "text" && typeof entry.text === "string");
  if (!item) throw new Error("MCP tool returned no text result");
  return item.text!;
}
async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const text = toolText(response);
  if ((response as { isError?: boolean }).isError) throw new Error(text);
  return JSON.parse(text);
}

// ---------- direct CDP reads and native set-up (runtime.read only: never through the guard) ----------
interface NativeView { active: { name: string; agent: string | null; state: string | null } | null; selection: string[]; undoDepth: number }
const VIEW_SOURCE = `function () {
  const tag = value => value === null || value === undefined ? null : typeof value === 'string' ? value : (value.tag ?? value.constructor?.name ?? null);
  const command = this.executor.active?.command;
  const memento = this.selection.selected.saveToMemento();
  return {
    active: command ? { name: command.constructor?.name ?? 'unknown', agent: command.agent ?? null, state: tag(command._state) } : null,
    selection: memento.ids instanceof Map ? [...memento.ids.keys()].map(String) : Array.from(memento.ids ?? [], String),
    undoDepth: this.history.undoStack.length,
  };
}`;
// Runs one no-op command natively, as a command of the user would run, WITHOUT the guard: with a face or an edge
// selected, Plasticity then chains its default command, which stays Awaiting. mode "leave" returns with that command
// active; mode "cancel" cancels it again (the history step then holds the selection). One Undo step each.
const NATIVE_COMMAND_SOURCE = `async function (args) {
  const editor = this, executor = this.executor;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const tag = value => value === null || value === undefined ? null : typeof value === 'string' ? value : (value.tag ?? value.constructor?.name ?? null);
  const command = args.user ? new this.commands[args.user](this) : new this.commands.GroupSelectedCommand(this);
  if (!args.user) { command.remember = false; command.execute = async function () {}; }
  editor.exec(command).then(() => {}, () => {});
  const deadline = Date.now() + 5000;
  const awaiting = () => { const active = executor.active?.command; return !!active && tag(active._state) === 'Awaiting' && (args.user ? active === command : active.agent === 'automatic'); };
  while (!awaiting() && Date.now() < deadline) await sleep(5);
  if (!awaiting()) throw new Error('no command reached Awaiting: ' + (executor.active?.command?.constructor?.name ?? 'none active'));
  const name = executor.active.command.constructor.name;
  if (args.mode === 'cancel') { executor.cancelActiveCommand(); while (executor.active && Date.now() < deadline) await sleep(5); }
  return name;
}`;
// Clean-up of the script's own native set-up: an idle default command is cancelled, the selection and hits are emptied.
const NATIVE_CLEAR_SOURCE = `async function () {
  const executor = this.executor;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const tag = value => value === null || value === undefined ? null : typeof value === 'string' ? value : (value.tag ?? value.constructor?.name ?? null);
  const active = executor.active?.command;
  let cancelled = null;
  if (active && tag(active._state) === 'Awaiting') { cancelled = active.constructor?.name ?? 'unknown'; executor.cancelActiveCommand(); const deadline = Date.now() + 3000; while (executor.active && Date.now() < deadline) await sleep(5); }
  this.selection.selected.removeAll();
  this.selection.hits?.clear?.();
  return cancelled;
}`;

interface Selection { bodyIds: number[]; curveIds: number[]; faces: string[]; edges: string[] }
const emptySelection = (): Selection => ({ bodyIds: [], curveIds: [], faces: [], edges: [] });
const selectionText = (selection: Selection) => {
  const parts = [
    ...selection.bodyIds.filter((id) => !selection.curveIds.includes(id)).map((id) => `body ${id}`), ...selection.curveIds.map((id) => `curve ${id}`),
    ...selection.faces.map((face) => `face ${face}`), ...selection.edges.map((edge) => `edge ${edge}`),
  ];
  return parts.length > 0 ? parts.join(", ") : "none";
};

class Live {
  readonly client: Client;
  readonly native: PlasticityRuntime;
  readonly checks: Check[] = [];
  readonly evidence: Record<string, unknown> = {};
  /** The ids of the bodies the document had before the script built anything. */
  documentBodies: ReadonlySet<number> = new Set();
  constructor(client: Client, native: PlasticityRuntime) { this.client = client; this.native = native; }
  async call(name: string, args: Record<string, unknown> = {}): Promise<any> { return await callTool(this.client, name, args); }
  async status(): Promise<any> { return await this.call("plasticity_status", {}); }
  check(section: string, check: string, ok: boolean, detail?: unknown): boolean {
    this.checks.push({ section, check, ok, ...(detail === undefined ? {} : { detail }) });
    if (!ok) console.error(`FAIL [${section}] ${check}${detail === undefined ? "" : ` ${JSON.stringify(detail).slice(0, 600)}`}`);
    return ok;
  }
  async view(): Promise<NativeView> { return await this.native.read<NativeView>(VIEW_SOURCE); }
  /** One edit with the current revision; returns the reply and the round-trip time. */
  async edit(name: string, args: Record<string, unknown>): Promise<{ result: any; ms: number }> {
    const revision = (await this.status()).revision;
    const started = performance.now();
    const result = await this.call(name, name === "plasticity_batch" ? args : { ...args, revision });
    return { result, ms: performance.now() - started };
  }
  async make(name: string, args: Record<string, unknown>): Promise<number> {
    const { result } = await this.edit(name, { ...args, intent: "selection acceptance fixture" });
    const added = result.change?.added?.[0]?.id;
    if (!Number.isInteger(added)) throw new Error(`${name} added no body: ${JSON.stringify(result).slice(0, 300)}`);
    return added as number;
  }
  async box(origin: Vec, size: Vec): Promise<number> { return await this.make("plasticity_create_box", { originMm: origin, sizeMm: size }); }
  async faces(bodyId: number, query: Record<string, unknown> = {}): Promise<any[]> {
    return (await this.call("plasticity_find_faces", { revision: (await this.status()).revision, query: { bodyIds: [bodyId], ...query }, limit: 1000 })).matches;
  }
  async edges(bodyId: number, query: Record<string, unknown> = {}): Promise<any[]> {
    return (await this.call("plasticity_find_edges", { revision: (await this.status()).revision, query: { bodyIds: [bodyId], ...query }, limit: 1000 })).matches;
  }
  async selection(): Promise<Selection> {
    const current = await this.call("plasticity_current_selection", {});
    return {
      bodyIds: [...current.bodyIds].sort((a: number, b: number) => a - b), curveIds: [...current.curveIds].sort((a: number, b: number) => a - b),
      faces: current.faces.map((face: { bodyId: number; faceId: string }) => `${face.bodyId}:${face.faceId}`).sort(),
      edges: current.edges.map((edge: { bodyId: number; edgeId: string }) => `${edge.bodyId}:${edge.edgeId}`).sort(),
    };
  }
  async clearSelection(): Promise<void> { await this.call("plasticity_clear_selection", { revision: (await this.status()).revision }); }
  /** Undo down to a depth. Each Undo is itself an edit that an uncertain session would refuse. */
  async undoTo(depth: number): Promise<void> {
    for (let state = await this.status(); state.undoDepth > depth; state = await this.status()) {
      await this.call("plasticity_undo", { steps: Math.min(state.undoDepth - depth, 50), intent: "selection acceptance restore", revision: state.revision });
    }
  }
  /**
   * The part of a selection that still exists, read independently of the guard: a body with its id and type, a curve
   * with its id, a face or an edge whose id is still in its body.
   */
  async surviving(before: Selection, typesBefore: Map<number, string>): Promise<Selection> {
    const state = await this.status();
    const types = new Map<number, string>(state.bodies.map((body: { id: number; type: string }) => [body.id, body.type]));
    const topology = new Map<string, Set<string>>();
    const idsOf = async (kind: "faces" | "edges", bodyId: number) => {
      const key = `${kind}:${bodyId}`;
      if (!topology.has(key)) topology.set(key, new Set(types.has(bodyId) ? (kind === "faces" ? await this.faces(bodyId) : await this.edges(bodyId)).map((item) => String(item.id)) : []));
      return topology.get(key)!;
    };
    const keep = async (kind: "faces" | "edges", items: string[]) => {
      const kept: string[] = [];
      for (const item of items) { const [bodyId, id] = [Number(item.slice(0, item.indexOf(":"))), item.slice(item.indexOf(":") + 1)]; if ((await idsOf(kind, bodyId)).has(id)) kept.push(item); }
      return kept;
    };
    return {
      bodyIds: before.bodyIds.filter((id) => types.has(id) && types.get(id) === typesBefore.get(id)),
      // plasticity_current_selection reports curves by their version id.
      curveIds: before.curveIds.filter((id) => state.bodies.some((body: { versionId: number; type: string }) => body.versionId === id && body.type === "Wire")),
      faces: await keep("faces", before.faces), edges: await keep("edges", before.edges),
    };
  }
}

// ---------- the matrix ----------
interface Fixture {
  /** The body the edit changes (its faces and edges get new ids), when the tool has one. */
  touched?: number;
  args: Record<string, unknown>;
  /** The geometry check after the call. */
  verify(live: Live, result: any): Promise<string | undefined>;
}
interface ToolCase { tool: string; label: string; multiStep?: boolean; setup(live: Live): Promise<Fixture> }

const boundsOf = async (live: Live, id: number): Promise<{ min: Vec; max: Vec } | undefined> => (await live.status()).bodies.find((body: { id: number }) => body.id === id)?.boundsMm;
const expectBounds = async (live: Live, id: number, min: Vec, max: Vec) => {
  const bounds = await boundsOf(live, id);
  return bounds && near(bounds.min, min, 1e-4) && near(bounds.max, max, 1e-4) ? undefined : `body ${id} bounds ${JSON.stringify(bounds)} are not ${JSON.stringify({ min, max })}`;
};
const faceCount = async (live: Live, id: number) => (await live.status()).bodies.find((body: { id: number }) => body.id === id)?.faceCount as number | undefined;
const T0: Vec = [X0 + 200, 0, 0];

const TOOLS: ToolCase[] = [
  { tool: "plasticity_create_box", label: "create_box", async setup() {
    return { args: { originMm: [X0 + 400, 0, 0], sizeMm: [10, 20, 30], intent: "matrix" }, async verify(live, result) {
      const id = result.change?.added?.[0]?.id; return Number.isInteger(id) ? await expectBounds(live, id, [X0 + 400, 0, 0], [X0 + 410, 20, 30]) : "no body was added";
    } };
  } },
  { tool: "plasticity_move", label: "move", async setup(live) {
    const touched = await live.box(T0, [20, 10, 5]);
    return { touched, args: { ids: [touched], deltaMm: [5, 0, 0], intent: "matrix" }, verify: async (l) => await expectBounds(l, touched, [T0[0] + 5, 0, 0], [T0[0] + 25, 10, 5]) };
  } },
  { tool: "plasticity_boolean", label: "boolean", async setup(live) {
    const touched = await live.box(T0, [20, 20, 20]);
    const cutter = await live.box([T0[0] + 10, 5, 5], [20, 10, 10]);
    return { touched, args: { targetIds: [touched], toolIds: [cutter], operation: "difference", intent: "matrix" }, async verify(l) {
      const state = await l.status();
      if (state.bodies.some((body: { id: number }) => body.id === cutter)) return "the cutter was not consumed";
      const faces = await faceCount(l, touched);
      // A pocket through the +x face: 6 faces of the box, 4 walls and the floor.
      return faces === 11 ? await expectBounds(l, touched, T0, [T0[0] + 20, 20, 20]) : `the target has ${faces} faces, not 11`;
    } };
  } },
  { tool: "plasticity_fillet", label: "fillet", async setup(live) {
    const touched = await live.box(T0, [20, 20, 20]);
    const edge = (await live.edges(touched))[0];
    return { touched, args: { id: touched, edgeIds: [String(edge.id)], radiusMm: 2, intent: "matrix" }, async verify(l) { const faces = await faceCount(l, touched); return faces === 7 ? undefined : `the body has ${faces} faces, not 7`; } };
  } },
  { tool: "plasticity_chamfer", label: "chamfer", async setup(live) {
    const touched = await live.box(T0, [20, 20, 20]);
    const edge = (await live.edges(touched))[0];
    return { touched, args: { id: touched, edgeIds: [String(edge.id)], distanceMm: 2, intent: "matrix" }, async verify(l) { const faces = await faceCount(l, touched); return faces === 7 ? undefined : `the body has ${faces} faces, not 7`; } };
  } },
  { tool: "plasticity_extrude_profile", label: "extrude_profile", async setup(live) {
    const wire = await live.make("plasticity_create_rectangle", { centerMm: [T0[0] + 10, 5, 0], widthMm: 20, heightMm: 10 });
    return { args: { id: wire, distanceMm: 7, intent: "matrix" }, async verify(l, result) {
      const solid = (result.change?.added ?? []).find((body: { type: string }) => body.type === "Solid");
      return solid ? await expectBounds(l, solid.id, T0, [T0[0] + 20, 10, 7]) : "no Solid was added";
    } };
  } },
  { tool: "plasticity_join_sheets", label: "join_sheets", async setup(live) {
    const sheets: number[] = [];
    for (const x of [T0[0] + 10, T0[0] + 30]) {
      const { result: rectangle } = await live.edit("plasticity_create_rectangle", { centerMm: [x, 5, 0], widthMm: 20, heightMm: 10, intent: "matrix fixture" });
      // Both rectangles lie in one sketch, so the second call lists both Regions again: take the one of this rectangle.
      const region = (rectangle.change?.regionsAdded ?? []).find((candidate: { displayBoundsMm: { min: Vec } }) => Math.abs(candidate.displayBoundsMm.min[0] - (x - 10)) < 1e-3)?.id;
      if (typeof region !== "string") throw new Error("the rectangle added no Region");
      sheets.push(await live.make("plasticity_patch_regions", { regionIds: [region] }));
    }
    return { touched: sheets[0]!, args: { ids: sheets, intent: "matrix" }, async verify(l) {
      const left = (await l.status()).bodies.filter((body: { id: number; type: string }) => sheets.includes(body.id));
      if (left.length !== 1 || left[0].type !== "Sheet") return `the two Sheets became ${JSON.stringify(left.map((body: { id: number; type: string }) => [body.id, body.type]))}`;
      return left[0].faceCount === 2 ? await expectBounds(l, left[0].id, T0, [T0[0] + 40, 10, 0]) : `the joined Sheet has ${left[0].faceCount} faces, not 2`;
    } };
  } },
  { tool: "plasticity_delete", label: "delete", async setup(live) {
    const touched = await live.box(T0, [10, 10, 10]);
    return { touched, args: { ids: [touched], intent: "matrix" }, async verify(l) { return (await l.status()).bodies.some((body: { id: number }) => body.id === touched) ? "the body is still there" : undefined; } };
  } },
  { tool: "plasticity_undo", label: "undo", async setup(live) {
    const touched = await live.box(T0, [20, 10, 5]);
    await live.edit("plasticity_move", { ids: [touched], deltaMm: [5, 0, 0], intent: "matrix fixture" });
    return { touched, args: { steps: 1, intent: "matrix" }, verify: async (l) => await expectBounds(l, touched, T0, [T0[0] + 20, 10, 5]) };
  } },
  { tool: "plasticity_redo", label: "redo", async setup(live) {
    const touched = await live.box(T0, [20, 10, 5]);
    await live.edit("plasticity_move", { ids: [touched], deltaMm: [5, 0, 0], intent: "matrix fixture" });
    await live.edit("plasticity_undo", { steps: 1, intent: "matrix fixture" });
    return { touched, args: { steps: 1, intent: "matrix" }, verify: async (l) => await expectBounds(l, touched, [T0[0] + 5, 0, 0], [T0[0] + 25, 10, 5]) };
  } },
  { tool: "plasticity_set_driving_distance", label: "set_driving_distance", async setup(live) {
    const touched = await live.box(T0, [20, 10, 5]);
    const faces = await live.faces(touched);
    const facing = (x: number) => faces.find((face) => face.planar && Math.abs(face.normal[0] - x) < 1e-9);
    return { touched, args: { bodyId: touched, movingFaceId: String(facing(1).id), referenceFaceId: String(facing(-1).id), distanceMm: 30, intent: "matrix" }, verify: async (l) => await expectBounds(l, touched, T0, [T0[0] + 30, 10, 5]) };
  } },
  { tool: "plasticity_batch", label: "batch (5 steps)", multiStep: true, async setup(live) {
    const touched = await live.box(T0, [20, 10, 5]);
    return { touched, args: { steps: [
      { toolName: "plasticity_create_box", arguments: { originMm: [X0 + 400, 0, 0], sizeMm: [10, 10, 10], intent: "matrix" } },
      { toolName: "plasticity_move", arguments: { ids: ["$0.added[0]"], deltaMm: [1, 0, 0], intent: "matrix" } },
      { toolName: "plasticity_move", arguments: { ids: [touched], deltaMm: [0, 3, 0], intent: "matrix" } },
      { toolName: "plasticity_move", arguments: { ids: ["$0.added[0]"], deltaMm: [0, 0, 1], intent: "matrix" } },
      { toolName: "plasticity_delete", arguments: { ids: ["$0.added[0]"], intent: "matrix" } },
    ] }, async verify(l, result) {
      if (result.undoSteps !== 5) return `the batch reports ${result.undoSteps} Undo steps, not 5`;
      // The document's own bodies (there before the script) may lie there too; they are not the batch's box.
      if ((await l.status()).bodies.some((body: { id: number; boundsMm?: { min: Vec } }) => !l.documentBodies.has(body.id) && body.boundsMm && body.boundsMm.min[0] >= X0 + 400)) return "the batch's own box is still there";
      return await expectBounds(l, touched, [T0[0], 3, 0], [T0[0] + 20, 13, 5]);
    } };
  } },
  { tool: "plasticity_create_bracket", label: "create_bracket", multiStep: true, async setup() {
    return { args: { originMm: [X0 + 400, 0, 0], profile: "L", widthMm: 30, thicknessMm: 4, legs: { baseMm: 40, uprightMm: 40 }, innerBendRadiusMm: 5, cornerRadiusMm: 3, name: "selection-matrix", intent: "matrix" }, async verify(l, result) {
      const id = result.bodyId ?? result.id ?? result.change?.added?.[0]?.id;
      if (!Number.isInteger(id)) return `the reply names no body: ${JSON.stringify(result).slice(0, 200)}`;
      const bounds = await boundsOf(l, id);
      return bounds && near(bounds.min, [X0 + 400, 0, 0], 1e-4) && Math.abs(bounds.max[1] - 30) < 1e-4 ? undefined : `bracket bounds ${JSON.stringify(bounds)}`;
    } };
  } },
];

interface StateCase { key: string; label: string; select(live: Live, world: World, fixture: Fixture): Promise<boolean> }
/** Bodies every cell leaves alone: two boxes and a curve. */
interface World { untouched: number; other: number; curve: number; untouchedFace: string; otherFace: string; untouchedEdge: string }
const selectFaces = async (live: Live, faces: Array<[number, string]>) => { await live.call("plasticity_select_faces", { faces: faces.map(([bodyId, faceId]) => ({ bodyId, faceId })), revision: (await live.status()).revision }); };
const STATES: StateCase[] = [
  { key: "none", label: "nothing", async select(live) { await live.clearSelection(); return true; } },
  { key: "face-touched", label: "1 face of the touched body", async select(live, _world, fixture) {
    if (fixture.touched === undefined) return false;
    await selectFaces(live, [[fixture.touched, String((await live.faces(fixture.touched))[0].id)]]); return true;
  } },
  { key: "face-untouched", label: "1 face of an untouched body", async select(live, world) { await selectFaces(live, [[world.untouched, world.untouchedFace]]); return true; } },
  { key: "two-faces", label: "2 faces on 2 bodies", async select(live, world, fixture) {
    // One on the touched body when the tool has one, else on a second untouched body.
    const second: [number, string] = fixture.touched === undefined ? [world.other, world.otherFace] : [fixture.touched, String((await live.faces(fixture.touched))[0].id)];
    await selectFaces(live, [[world.untouched, world.untouchedFace], second]); return true;
  } },
  { key: "edge-untouched", label: "1 edge of an untouched body", async select(live, world) {
    await live.call("plasticity_select_edges", { edges: [{ bodyId: world.untouched, edgeId: world.untouchedEdge }], revision: (await live.status()).revision }); return true;
  } },
  { key: "body-untouched", label: "a whole untouched body", async select(live, world) { await live.call("plasticity_select_bodies", { ids: [world.untouched], revision: (await live.status()).revision }); return true; } },
  { key: "body-touched", label: "the whole touched body", async select(live, _world, fixture) {
    if (fixture.touched === undefined) return false;
    await live.call("plasticity_select_bodies", { ids: [fixture.touched], revision: (await live.status()).revision }); return true;
  } },
  { key: "curve", label: "a curve", async select(live, world) { await live.call("plasticity_select_curves", { ids: [world.curve], revision: (await live.status()).revision }); return true; } },
];

interface Cell { tool: string; state: string; ms?: number; slowFirstMs?: number; selectionBefore?: string; selectionAfter?: string; expected?: string; active?: string; result: string }

async function buildWorld(live: Live): Promise<World> {
  const untouched = await live.box([X0, 0, 0], [10, 10, 10]);
  const other = await live.box([X0 + 50, 0, 0], [10, 10, 10]);
  // On its own plane (z 40): a second Wire in the sketch of a fixture would make that fixture's profile ambiguous.
  const curve = await live.make("plasticity_create_rectangle", { centerMm: [X0 + 110, 5, 40], widthMm: 20, heightMm: 10 });
  return {
    untouched, other, curve,
    untouchedFace: String((await live.faces(untouched))[0].id), otherFace: String((await live.faces(other))[0].id), untouchedEdge: String((await live.edges(untouched))[0].id),
  };
}

async function runCell(live: Live, world: World, tool: ToolCase, state: StateCase, worldDepth: number): Promise<Cell> {
  const cell: Cell = { tool: tool.label, state: state.label, result: "n/a" };
  try {
    await live.clearSelection();
    const fixture = await tool.setup(live);
    if (!(await state.select(live, world, fixture))) { cell.result = "n/a (the tool touches no existing body)"; return cell; }
    const before = await live.selection();
    const typesBefore = new Map<number, string>((await live.status()).bodies.map((body: { id: number; type: string }) => [body.id, body.type]));
    cell.selectionBefore = selectionText(before);
    const { result, ms } = await live.edit(tool.tool, fixture.args);
    cell.ms = Math.round(ms);
    const view = await live.view();
    cell.active = view.active ? `${view.active.name} (${view.active.state})` : "none";
    const after = await live.selection();
    const expected = await live.surviving(before, typesBefore);
    cell.selectionAfter = selectionText(after);
    cell.expected = selectionText(expected);
    const problems: string[] = [];
    const geometry = await fixture.verify(live, result);
    if (geometry) problems.push(`geometry: ${geometry}`);
    if (JSON.stringify(after) !== JSON.stringify(expected)) problems.push(`selection after is ${cell.selectionAfter}, expected ${cell.expected}`);
    if (view.active) problems.push(`${cell.active} is active`);
    cell.result = problems.length > 0 ? `FAIL: ${problems.join("; ")}` : "ok";
  } catch (error) {
    cell.result = `FAIL: ${(error instanceof Error ? error.message : String(error)).slice(0, 400)}`;
  } finally {
    // The restore is an edit too: an uncertain session would refuse it. It runs with the cell's selection still in place.
    try { await live.undoTo(worldDepth); } catch (error) { cell.result = `${cell.result === "ok" ? "FAIL:" : `${cell.result};`} the restore after the cell failed (the session is uncertain?): ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`; }
  }
  return cell;
}

async function matrix(live: Live): Promise<void> {
  const baseDepth = (await live.status()).undoDepth;
  const world = await buildWorld(live);
  const worldDepth = (await live.status()).undoDepth;
  const cells: Cell[] = [];
  try {
    for (const tool of TOOLS) {
      const limit = tool.multiStep ? MULTI_STEP_LIMIT_MS : SINGLE_EDIT_LIMIT_MS;
      for (const state of STATES) {
        let cell = await runCell(live, world, tool, state, worldDepth);
        // A renderer garbage collection stalls one call in a few hundred for seconds (also before the guard): one retry, both times kept.
        if (cell.result === "ok" && cell.ms !== undefined && cell.ms > limit) { const slow = cell.ms; cell = await runCell(live, world, tool, state, worldDepth); cell.slowFirstMs = slow; }
        cells.push(cell);
        const applies = !cell.result.startsWith("n/a");
        if (applies) {
          live.check("matrix", `${tool.label} with ${state.label} selected: returns, geometry right, selection ${cell.expected ?? "?"}, no active command`, cell.result === "ok", cell.result === "ok" ? undefined : cell);
          live.check("matrix", `${tool.label} with ${state.label} selected returns within ${limit} ms`, cell.ms !== undefined && cell.ms <= limit, { ms: cell.ms, slowFirstMs: cell.slowFirstMs });
        }
        console.log(`${tool.label.padEnd(22)} | ${state.label.padEnd(28)} | ${String(cell.ms ?? "-").padStart(5)} ms${cell.slowFirstMs ? ` (first try ${cell.slowFirstMs} ms)` : ""} | after: ${cell.selectionAfter ?? "-"} | ${cell.result}`);
      }
    }
  } finally {
    await live.clearSelection().catch(() => undefined);
    await live.undoTo(baseDepth);
  }
  live.evidence.matrix = cells;
  const applicable = cells.filter((cell) => !cell.result.startsWith("n/a"));
  live.check("matrix", `${applicable.length} cells ran (${TOOLS.length} tools x ${STATES.length} selection states, ${cells.length - applicable.length} not applicable)`, applicable.length >= TOOLS.length * (STATES.length - 2));
}

// ---------- 20 edits in a row ----------
async function repeat(live: Live): Promise<void> {
  const baseDepth = (await live.status()).undoDepth;
  try {
    const untouched = await live.box([X0, 0, 0], [10, 10, 10]);
    const moved = await live.box(T0, [20, 10, 5]);
    const faceId = String((await live.faces(untouched))[0].id);
    await selectFaces(live, [[untouched, faceId]]);
    // A renderer garbage collection stalls one call in a few dozen for seconds, with or without the guard and with
    // nothing selected (the server before the guard: 3,411 ms on move 21 of 45). The used heap is read around every
    // move: a move during which it fell by more than 5 MB ran through a collection and is listed, not judged for time.
    const usedHeap = async () => Number(((await live.native.cdp("Runtime.getHeapUsage")) as { usedSize?: number }).usedSize);
    const times: number[] = [];
    const collections: Array<{ move: number; ms: number; freedMb: number }> = [];
    let bad: unknown;
    for (let index = 0; index < 20 && bad === undefined; index += 1) {
      const heapBefore = await usedHeap();
      const { ms } = await live.edit("plasticity_move", { ids: [moved], deltaMm: [1, 0, 0], intent: "20 in a row" });
      const freedMb = round1((heapBefore - await usedHeap()) / 1_048_576);
      if (freedMb > 5) { collections.push({ move: index + 1, ms: Math.round(ms), freedMb }); continue; }
      times.push(round1(ms));
      const view = await live.view();
      const selection = await live.selection();
      if (view.active || selection.faces.length !== 1 || selection.faces[0] !== `${untouched}:${faceId}`) bad = { index, active: view.active, selection };
    }
    live.check("repeat", "20 moves in a row with a face of an untouched body selected: each returns with that face selected and no command active", bad === undefined && times.length + collections.length === 20, bad ?? undefined);
    live.check("repeat", `at most 2 of the 20 moves ran through a renderer garbage collection (${collections.length}: ${collections.map((entry) => `move ${entry.move}, ${entry.ms} ms, ${entry.freedMb} MB freed`).join("; ") || "none"})`, collections.length <= 2, collections);
    live.check("repeat", "the body moved 20 mm", (await expectBounds(live, moved, [T0[0] + 20, 0, 0], [T0[0] + 40, 10, 5])) === undefined);
    // The control for "no slowdown": 5 more moves straight after, with nothing selected. The renderer has slow
    // stretches of its own (before a garbage collection), which the control shares and a cost of the selection would not.
    await live.clearSelection();
    const control: number[] = [];
    for (let index = 0; index < 5; index += 1) control.push(round1((await live.edit("plasticity_move", { ids: [moved], deltaMm: [1, 0, 0], intent: "20 in a row: control" })).ms));
    const [first, last, unselected] = [median(times.slice(0, 5)), median(times.slice(-5)), median(control)];
    live.check("repeat", `no slowdown: median of the last 5 moves (${last} ms) is within 15 ms of the first 5 (${first} ms) or of 5 moves made straight after with nothing selected (${unselected} ms)`, last <= Math.max(first, unselected) + 15, { times, control });
    live.check("repeat", `every other move returned within ${SINGLE_EDIT_LIMIT_MS} ms (slowest ${Math.max(...times)} ms)`, Math.max(...times) <= SINGLE_EDIT_LIMIT_MS, { times });
    live.evidence.repeat = { times, collections, control, medianFirst5: first, medianLast5: last, medianControl: unselected, median: round1(median(times)) };
    console.log(`20 moves with a face of an untouched body selected: median ${round1(median(times))} ms, first 5 ${first} ms, last 5 ${last} ms, slowest ${Math.max(...times)} ms; 5 moves straight after with nothing selected ${unselected} ms${collections.length > 0 ? `; during a renderer garbage collection: ${collections.map((entry) => `move ${entry.move} ${entry.ms} ms (${entry.freedMb} MB freed)`).join(", ")}` : ""}`);
  } finally {
    await live.clearSelection().catch(() => undefined);
    await live.undoTo(baseDepth);
  }
}

// ---------- entry states ----------
async function entry(live: Live): Promise<void> {
  const baseDepth = (await live.status()).undoDepth;
  try {
    const untouched = await live.box([X0, 0, 0], [10, 10, 10]);
    const moved = await live.box(T0, [20, 10, 5]);
    const faceId = String((await live.faces(untouched))[0].id);
    const edgeId = String((await live.edges(untouched))[0].id);

    // 1. The state of a person who clicked a face: the default command of the selection idles in Awaiting.
    await selectFaces(live, [[untouched, faceId]]);
    const chained = await live.native.read<string>(NATIVE_COMMAND_SOURCE, [{ mode: "leave" }], 15_000);
    const atEntry = await live.view();
    live.check("entry", `set-up: ${chained} (agent automatic) is Awaiting with the face selected`, atEntry.active?.agent === "automatic" && atEntry.active.state === "Awaiting" && atEntry.selection.length === 1, atEntry);
    const first = await live.edit("plasticity_move", { ids: [moved], deltaMm: [5, 0, 0], intent: "entry: default command awaiting" });
    const afterFirst = await live.view();
    live.check("entry", `a move with ${chained} Awaiting at entry returns (${Math.round(first.ms)} ms) and moves the body`, first.ms <= SINGLE_EDIT_LIMIT_MS && (await expectBounds(live, moved, [T0[0] + 5, 0, 0], [T0[0] + 25, 10, 5])) === undefined, { ms: first.ms });
    live.check("entry", "afterwards the same face is selected and no command is active", afterFirst.active === null && JSON.stringify((await live.selection()).faces) === JSON.stringify([`${untouched}:${faceId}`]), afterFirst);
    // The same for a tool that refuses any active command by itself (the Dimension command).
    const chainedAgain = await live.native.read<string>(NATIVE_COMMAND_SOURCE, [{ mode: "leave" }], 15_000);
    const faces = await live.faces(moved);
    const facing = (x: number) => faces.find((face) => face.planar && Math.abs(face.normal[0] - x) < 1e-9);
    const driven = await live.edit("plasticity_set_driving_distance", { bodyId: moved, movingFaceId: String(facing(1).id), referenceFaceId: String(facing(-1).id), distanceMm: 30, intent: "entry: default command awaiting" });
    live.check("entry", `plasticity_set_driving_distance with ${chainedAgain} Awaiting at entry returns (${Math.round(driven.ms)} ms) and sets 30 mm`, (await expectBounds(live, moved, [T0[0] + 5, 0, 0], [T0[0] + 35, 10, 5])) === undefined && (await live.view()).active === null);
    live.evidence.entryDefault = { command: chained, moveMs: Math.round(first.ms), drivingMs: Math.round(driven.ms) };

    // 2. A command of the user (agent user) that awaits its dialog: the guard stands aside, the edit runs as it did before.
    await live.native.read(NATIVE_CLEAR_SOURCE, [], 15_000);
    await live.call("plasticity_select_edges", { edges: [{ bodyId: untouched, edgeId }], revision: (await live.status()).revision });
    const userCommand = await live.native.read<string>(NATIVE_COMMAND_SOURCE, [{ mode: "leave", user: "FilletShellCommand" }], 15_000);
    const userEntry = await live.view();
    live.check("entry", `set-up: the user's ${userCommand} (agent user) is Awaiting with an edge selected`, userEntry.active?.agent === "user" && userEntry.active.state === "Awaiting", userEntry);
    const second = await live.edit("plasticity_move", { ids: [moved], deltaMm: [0, 5, 0], intent: "entry: user command awaiting" });
    const afterSecond = await live.view();
    live.check("entry", `a move with the user's ${userCommand} Awaiting at entry returns its normal reply (${Math.round(second.ms)} ms) and moves the body`, second.ms <= SINGLE_EDIT_LIMIT_MS && typeof second.result.revision === "string" && (await expectBounds(live, moved, [T0[0] + 5, 5, 0], [T0[0] + 35, 15, 5])) === undefined, { ms: second.ms });
    // Plasticity's exec() interrupted the user's command (as before the guard), which sends the selection back to the
    // last history step. Here that is nothing (the edge was selected by a tool), so the guard puts the edge back.
    const selectionAfterSecond = await live.selection();
    live.check("entry", "afterwards no command of the server is active and the edge is selected again", afterSecond.active === null && JSON.stringify(selectionAfterSecond.edges) === JSON.stringify([`${untouched}:${edgeId}`]), { afterSecond, selectionAfterSecond });
    live.evidence.entryUser = { command: userCommand, moveMs: Math.round(second.ms), activeAfter: afterSecond.active, selectionAfter: afterSecond.selection };
    console.log(`entry: default ${chained} awaiting -> move ${Math.round(first.ms)} ms, driving distance ${Math.round(driven.ms)} ms; user ${userCommand} awaiting -> move ${Math.round(second.ms)} ms, afterwards active ${afterSecond.active ? afterSecond.active.name : "none"}, selection ${afterSecond.selection.length} item(s)`);
  } finally {
    await live.native.read(NATIVE_CLEAR_SOURCE, [], 15_000).catch(() => undefined);
    await live.undoTo(baseDepth);
  }
}

// ---------- failure, history, reconcile ----------
async function recovery(live: Live, baseline: Client | undefined): Promise<void> {
  const baseDepth = (await live.status()).undoDepth;
  try {
    const untouched = await live.box([X0, 0, 0], [10, 10, 10]);
    const edited = await live.box(T0, [20, 20, 20]);
    const curve = await live.make("plasticity_create_rectangle", { centerMm: [X0 + 110, 5, 0], widthMm: 20, heightMm: 10 });
    const faceId = String((await live.faces(untouched))[0].id);

    // 1. A failing edit with a face selected: a certain error, nothing changed, the selection back, no command active.
    await selectFaces(live, [[untouched, faceId]]);
    const depth = (await live.status()).undoDepth;
    // A difference with a tool that does not touch the target: Plasticity refuses the command ("Operation has no effect").
    const revisionBefore = (await live.status()).revision;
    const started = performance.now();
    let failure = "";
    try { await live.call("plasticity_boolean", { targetIds: [edited], toolIds: [untouched], operation: "difference", keepTools: true, intent: "a difference that cuts nothing", revision: revisionBefore }); } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    const failMs = Math.round(performance.now() - started);
    const afterFailure = await live.view();
    live.check("recovery", `a Boolean that Plasticity refuses fails with Plasticity's own error in ${failMs} ms (not a timeout)`, /Operation has no effect/.test(failure) && !/timed out|uncertain/i.test(failure) && failMs <= SINGLE_EDIT_LIMIT_MS, { failure: failure.slice(0, 300), failMs });
    live.check("recovery", "after the failure: the Undo depth is unchanged, the face is still selected, no command is active", afterFailure.undoDepth === depth && afterFailure.active === null && JSON.stringify((await live.selection()).faces) === JSON.stringify([`${untouched}:${faceId}`]), afterFailure);
    const next = await live.edit("plasticity_move", { ids: [edited], deltaMm: [1, 0, 0], intent: "the edit after a failure" });
    live.check("recovery", `the next edit runs (${Math.round(next.ms)} ms): the session is not uncertain`, typeof next.result.revision === "string");

    // 2. A history step whose state holds a face selection: Undo restores that selection and Plasticity chains its
    //    default command. Two native commands with the face selected put it into the history.
    await live.native.read(NATIVE_COMMAND_SOURCE, [{ mode: "cancel" }], 15_000);
    await live.native.read(NATIVE_COMMAND_SOURCE, [{ mode: "cancel" }], 15_000);
    await live.call("plasticity_select_curves", { ids: [curve], revision: (await live.status()).revision });
    const beforeUndo = await live.view();
    const selectionBeforeUndo = await live.selection();
    const undone = await live.edit("plasticity_undo", { steps: 1, intent: "undo over a history step that holds a face selection" });
    const afterUndo = await live.view();
    const selectionAfterUndo = await live.selection();
    live.check("recovery", `Undo over a history step that holds a face selection returns (${Math.round(undone.ms)} ms) and lowers the Undo depth by one`, undone.ms <= SINGLE_EDIT_LIMIT_MS && afterUndo.undoDepth === beforeUndo.undoDepth - 1, { ms: undone.ms, before: beforeUndo.undoDepth, after: afterUndo.undoDepth });
    const curveSelected = (selection: Selection) => JSON.stringify(selection) === JSON.stringify(selectionBeforeUndo);
    live.check("recovery", "afterwards the curve selected before the Undo is selected again (not the face of the history step) and no default command is active", afterUndo.active === null && selectionBeforeUndo.bodyIds.includes(curve) && selectionBeforeUndo.curveIds.length === 1 && curveSelected(selectionAfterUndo), { afterUndo, selectionBeforeUndo, selectionAfterUndo });
    const redone = await live.edit("plasticity_redo", { steps: 1, intent: "redo the same step" });
    const afterRedo = await live.view();
    live.check("recovery", `Redo of that step returns (${Math.round(redone.ms)} ms) with the curve selected and no command active`, afterRedo.active === null && afterRedo.undoDepth === beforeUndo.undoDepth && curveSelected(await live.selection()), afterRedo);

    // 3. The leftover of a call that hung before the guard: an edit committed, the default command Awaiting.
    await selectFaces(live, [[untouched, faceId]]);
    const leftover = await live.native.read<string>(NATIVE_COMMAND_SOURCE, [{ mode: "leave" }], 15_000);
    const beforeReconcile = await live.view();
    const reconciled = await live.call("plasticity_reconcile", {});
    const afterReconcile = await live.view();
    live.check("recovery", `plasticity_reconcile cancels the ${leftover} left Awaiting and says so in recovery`, JSON.stringify(reconciled.recovery?.cancelledDefaultCommands) === JSON.stringify([leftover]) && typeof reconciled.recovery?.note === "string" && reconciled.recovery.activeCommand === undefined, reconciled.recovery);
    live.check("recovery", "reconcile changed nothing else: the Undo depth and the selection are as before, no command is active", afterReconcile.active === null && afterReconcile.undoDepth === beforeReconcile.undoDepth && JSON.stringify(afterReconcile.selection) === JSON.stringify(beforeReconcile.selection), { beforeReconcile, afterReconcile });
    const idle = await live.call("plasticity_reconcile", {});
    live.check("recovery", "with nothing left behind, the reconcile reply has no recovery field", idle.recovery === undefined);

    // 4. The real thing: the server of --baseline-root (before the guard) hangs on the selected face. Its renderer
    //    function is then still pending behind the default command. plasticity_reconcile on this tree's server clears it.
    if (baseline) {
      await selectFaces(live, [[untouched, faceId]]);
      const revision = (await callTool(baseline, "plasticity_status", {})).revision;
      const hangStarted = performance.now();
      let hang = "";
      try { await callTool(baseline, "plasticity_move", { ids: [edited], deltaMm: [0, 0, 1], intent: "the hang before the guard", revision }); } catch (error) { hang = error instanceof Error ? error.message : String(error); }
      const hangMs = Math.round(performance.now() - hangStarted);
      const hung = await live.view();
      if (!/timed out/i.test(hang)) {
        console.log(`recovery: the server of --baseline-root did not hang (${hangMs} ms): it already has the guard; the real-hang check was skipped`);
        live.evidence.realHang = { skipped: true, hangMs };
      } else {
        live.check("recovery", `before the guard: a move with a face of an untouched body selected times out (${hangMs} ms) and leaves a default command Awaiting`, hung.active?.agent === "automatic" && hung.active.state === "Awaiting", { hang: hang.slice(0, 200), hung });
        const repaired = await live.call("plasticity_reconcile", {});
        const afterRepair = await live.view();
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const later = await live.view();
        live.check("recovery", `plasticity_reconcile on this tree cancels the ${hung.active?.name} that hang left behind`, JSON.stringify(repaired.recovery?.cancelledDefaultCommands) === JSON.stringify([hung.active?.name]), repaired.recovery);
        live.check("recovery", "nothing was undone or repeated (the Undo depth is as the hang left it, also 1 s later), the face is still selected, no command is active", afterRepair.active === null && later.active === null && afterRepair.undoDepth === hung.undoDepth && later.undoDepth === hung.undoDepth && JSON.stringify(later.selection) === JSON.stringify(hung.selection), { hung, afterRepair, later });
        const afterHang = await live.edit("plasticity_move", { ids: [edited], deltaMm: [0, 0, 1], intent: "the edit after the repair" });
        live.check("recovery", `the next edit on this tree runs (${Math.round(afterHang.ms)} ms) with the face still selected`, typeof afterHang.result.revision === "string" && (await live.view()).active === null);
        // The baseline server marked its own session uncertain; its reconcile (a read) lets the speed section use it.
        await callTool(baseline, "plasticity_reconcile", {});
        live.evidence.realHang = { hangMs, hang: hang.slice(0, 200), leftover: hung.active, recovery: repaired.recovery };
        console.log(`recovery: before the guard the same move timed out after ${hangMs} ms with ${hung.active?.name} Awaiting; reconcile on this tree: ${repaired.recovery?.note}`);
      }
    }
    live.evidence.recovery = { failure: failure.split("\n")[0]!.slice(0, 300), failMs, undoMs: Math.round(undone.ms), redoMs: Math.round(redone.ms), reconcile: reconciled.recovery };
    console.log(`recovery: refused Boolean ${failMs} ms; undo over a selection-holding step ${Math.round(undone.ms)} ms; reconcile: ${reconciled.recovery?.note}`);
  } finally {
    await live.native.read(NATIVE_CLEAR_SOURCE, [], 15_000).catch(() => undefined);
    await live.undoTo(baseDepth);
  }
}

// ---------- a gizmo the user is using; a call that was given up ----------
// The gizmo is made as a person makes it: real mouse events (Input.dispatchMouseEvent) on the viewport select an edge or
// a face of a box, Plasticity starts the default command of that selection, and a press-and-drag on its handle gives the
// factory a preview. The camera is set for the click and put back afterwards.
interface Gizmo { serial: number; name: string; agent: string | null; state: string | null; factory: string | null; temps: number | null; distanceMm: number | null; changed: boolean | null }
const GIZMO_SOURCE = `function () {
  const tag = value => value === null || value === undefined ? null : typeof value === 'string' ? value : (value.tag ?? value.constructor?.name ?? null);
  const command = this.executor.active?.command;
  if (!command) return null;
  const book = (globalThis.__selectionLive ??= { marks: new WeakMap(), next: 0 });
  if (!book.marks.has(command)) book.marks.set(command, ++book.next);
  const factory = Array.from(command.resources ?? []).find(resource => resource && typeof resource === 'object' && '_state' in resource && 'temps' in resource) ?? null;
  const state = factory?._state;
  const temps = factory?.temps?.length ?? factory?.temps?.size ?? null;
  return {
    serial: book.marks.get(command), name: command.constructor?.name ?? 'unknown', agent: command.agent ?? null, state: tag(command._state),
    factory: factory ? tag(state !== null && typeof state === 'object' && 'value' in state ? state.value : state) : null, temps,
    distanceMm: typeof factory?.distance === 'number' ? Math.round(factory.distance * 1e6) / 1e3 : null, changed: command._isFactoryChanged ?? null,
  };
}`;
const CAMERA_SOURCE = `function () { const viewport = Array.from(this.viewports)[0]; const controls = viewport.orbitControls; return { target: controls.target.toArray(), q: controls.quaternion.toArray(), radius: controls.radius, zoom: controls.zoom }; }`;
// Sets the first viewport's camera (a saved one with q, or a new one that looks at target from the direction eye) and
// returns where the given points (mm) lie in the window, in CSS pixels.
const SET_CAMERA_SOURCE = `async function (args) {
  const viewport = Array.from(this.viewports)[0], camera = viewport.camera, controls = viewport.orbitControls, Vector = camera.position.constructor;
  const target = new Vector(...args.target);
  let q;
  if (args.q) q = camera.quaternion.clone().fromArray(args.q);
  else { camera.position.copy(target).addScaledVector(new Vector(...args.eye).normalize(), args.radius); camera.up.set(0, 0, 1); camera.lookAt(target); q = camera.quaternion.clone(); }
  controls.target.copy(target); controls.targetEnd.copy(target); controls.targetVelocity.set(0, 0, 0); controls.deltaTarget.set(0, 0, 0);
  controls.quaternion.copy(q); controls.quaternionEnd.copy(q);
  for (const key of ['focalOffset', 'focalOffsetEnd', 'focalOffsetVelocity', '_focalOffset', '_inverseFocalOffset']) controls[key]?.set?.(0, 0, 0);
  controls.radius = controls.radiusEnd = args.radius; controls.zoom = controls.zoomEnd = args.zoom;
  controls.setNeedsUpdate?.(); controls.update?.(); viewport.setNeedsRender();
  await new Promise(resolve => setTimeout(resolve, 700));
  camera.updateMatrixWorld();
  const rect = viewport.renderer.domElement.getBoundingClientRect();
  return (args.points ?? []).map(point => { const projected = new Vector(point[0] / 1000, point[1] / 1000, point[2] / 1000).project(camera); return [rect.left + (projected.x + 1) / 2 * rect.width, rect.top + (1 - projected.y) / 2 * rect.height]; });
}`;
// What Escape does for a person: every active command is cancelled; then the selection is emptied.
const NATIVE_ESCAPE_SOURCE = `async function () {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let round = 0; round < 5 && this.executor.active; round += 1) { this.executor.cancelActiveCommand(); const deadline = Date.now() + 1000; while (this.executor.active && Date.now() < deadline) await sleep(5); }
  this.selection.selected.removeAll(); this.selection.hits?.clear?.();
  return this.executor.active?.command?.constructor?.name ?? null;
}`;
// A source that a call gives up on: it waits until the script lets it go. With command: true it then runs a command
// (so mutate() sends it with the guard); without, it is a source that runs none (mutate() sends it as it is).
const hungSource = (command: boolean) => `async function () {
  await new Promise(resolve => { globalThis.__selectionLiveRelease = resolve; });
  ${command ? "const command = new this.commands.GroupSelectedCommand(this); command.remember = false; command.execute = async function () {}; await this.exec(command);" : ""}
  return 1;
}`;
const RELEASE_SOURCE = `function () { const release = globalThis.__selectionLiveRelease; delete globalThis.__selectionLiveRelease; if (release) release(); return !!release; }`;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const gizmoText = (gizmo: Gizmo | null) => gizmo ? `${gizmo.name} #${gizmo.serial} (${gizmo.agent}, ${gizmo.state}; factory ${gizmo.factory}, ${gizmo.temps} temp(s), ${gizmo.distanceMm} mm)` : "no command";

async function gizmo(live: Live, output: string): Promise<void> {
  const baseDepth = (await live.status()).undoDepth;
  const sectionsAtStart = (await live.call("plasticity_list_section_analyses", {})).sectionAnalyses?.length ?? 0;
  if (sectionsAtStart > 0) throw new Error("A section analysis is active in the instance; the gizmo section would replace it. Nothing was created.");
  const camera = await live.native.read<{ target: number[]; q: number[]; radius: number; zoom: number }>(CAMERA_SOURCE);
  const mouse = (type: string, x: number, y: number, buttons: number) => live.native.cdp("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? (buttons ? "left" : "none") : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
  const read = async () => await live.native.read<Gizmo | null>(GIZMO_SOURCE);
  const same = (a: Gizmo | null, b: Gizmo | null) => JSON.stringify(a) === JSON.stringify(b);
  // One tool call that may be refused: the error text or the parsed reply.
  const attempt = async (name: string, args: Record<string, unknown>): Promise<{ error?: string; result?: any; ms: number }> => {
    const started = performance.now();
    const response = await live.client.callTool({ name, arguments: args });
    const ms = Math.round(performance.now() - started);
    const text = toolText(response);
    if ((response as { isError?: boolean }).isError) return { error: text, ms };
    try { return { result: JSON.parse(text), ms }; } catch { return { result: text, ms }; }
  };
  const raw = async (source: string, timeoutMs?: number): Promise<{ error?: string; value?: unknown }> => {
    try { return { value: await live.native.mutate(source, [], [], timeoutMs) }; } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  };
  const QUIET = "async function () { return 1; }"; // what plasticity_save_copy, the exports and the section analyses send: no command
  const COMMAND = "async function () { const command = new this.commands.GroupSelectedCommand(this); command.remember = false; command.execute = async function () {}; await this.exec(command); return 1; }";
  const editing = /Plasticity is busy: the user is editing/;
  let pressed: [number, number] | undefined;
  try {
    const user = await live.box([X0 + 100, 0, 0], [20, 20, 20]); // the body the person works on
    const moved = await live.box(T0, [20, 20, 20]); // the body the tools edit
    const faceId = String((await live.faces(user))[0].id);
    const [point] = await live.native.read<Array<[number, number]>>(SET_CAMERA_SOURCE, [{ target: [(X0 + 110) / 1000, 0.01, 0.01], eye: [1, -1, 0.8], radius: 0.2, zoom: 90, points: [[X0 + 110, 10, 20]] }], 15_000);
    const [x, y] = point!;
    const click = async () => { for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) { await mouse(type, x, y, type === "mousePressed" ? 1 : 0); await pause(type === "mouseMoved" ? 150 : 60); } };
    // Waits for a state of the gizmo with a bound (a renderer garbage collection can take seconds), then lets it settle.
    const until = async (test: (now: Gizmo | null) => boolean, limitMs = 6_000) => { for (const deadline = Date.now() + limitMs; Date.now() < deadline && !test(await read());) await pause(50); await pause(200); };
    // The first click gives the viewport the pointer, the second selects; Plasticity then starts the default command.
    const clickBox = async () => { await click(); await pause(600); await click(); await pause(500); await until((now) => now?.agent === "automatic" && now.state === "Awaiting"); };
    const drag = async () => {
      await mouse("mouseMoved", x, y, 0); await pause(150);
      await mouse("mousePressed", x, y, 1); pressed = [x, y]; await pause(100);
      for (let step = 1; step <= 8; step += 1) { await mouse("mouseMoved", x + 6 * step, y - 6 * step, 1); pressed = [x + 6 * step, y - 6 * step]; await pause(40); }
      await until((now) => !!now && (now.factory !== "none" || (now.temps ?? 0) > 0));
      await pause(300);
    };
    const release = async () => { if (pressed) { await mouse("mouseReleased", pressed[0], pressed[1], 0); pressed = undefined; await pause(400); } };

    // ----- 1. A gizmo nobody has changed: tools that run no command leave it; an edit cancels it and puts the selection back.
    await clickBox();
    const idle = await read();
    const idleView = await live.view();
    live.check("gizmo", `set-up: a real click selects ${idleView.selection.join(" ")} and Plasticity starts ${gizmoText(idle)}`, idle?.agent === "automatic" && idle.state === "Awaiting" && idle.factory === "none" && idle.temps === 0 && idleView.selection.length === 1, { idle, idleView });
    const quietCalls: Record<string, unknown> = {};
    for (const [label, call] of [
      ["plasticity_status", () => attempt("plasticity_status", {})],
      ["plasticity_export_step", async () => attempt("plasticity_export_step", { ids: [moved], path: join(output, "gizmo-idle.step"), revision: (await live.status()).revision })],
      ["plasticity_create_section_analysis", async () => attempt("plasticity_create_section_analysis", { originMm: [T0[0] + 10, 10, 10], normal: [0, 0, 1], intent: "gizmo: section", revision: (await live.status()).revision })],
      ["plasticity_delete_section_analysis", async () => attempt("plasticity_delete_section_analysis", { id: (await live.call("plasticity_list_section_analyses", {})).sectionAnalyses?.[0]?.id, intent: "gizmo: section", revision: (await live.status()).revision })],
      ["plasticity_screenshot", () => attempt("plasticity_screenshot", { path: join(output, "gizmo-idle.png"), captureMode: "viewport" })],
      ["a source without a command (as plasticity_save_copy sends)", async () => { const reply = await raw(QUIET); return { ...(reply.error ? { error: reply.error } : { result: reply.value }), ms: 0 }; }],
    ] as Array<[string, () => Promise<{ error?: string; result?: any; ms: number }>]>) {
      const reply = await call();
      const after = await read();
      quietCalls[label] = { error: reply.error?.slice(0, 300), ms: reply.ms, after };
      live.check("gizmo", `untouched gizmo: ${label} returns${reply.error ? ` AN ERROR (${reply.error.slice(0, 160)})` : ""} and leaves ${gizmoText(after)}`, reply.error === undefined && same(after, idle) && JSON.stringify((await live.view()).selection) === JSON.stringify(idleView.selection), { reply: reply.error ?? "ok", after });
    }
    const idleEdit = await live.edit("plasticity_move", { ids: [moved], deltaMm: [0, 0, 1], intent: "gizmo: an edit with an untouched gizmo" });
    const afterIdleEdit = await live.view();
    live.check("gizmo", `untouched gizmo: an edit cancels it, runs (${Math.round(idleEdit.ms)} ms) and puts the selection back`, afterIdleEdit.active === null && JSON.stringify(afterIdleEdit.selection) === JSON.stringify(idleView.selection) && (await expectBounds(live, moved, [T0[0], 0, 1], [T0[0] + 20, 20, 21])) === undefined, afterIdleEdit);
    live.evidence.gizmoIdle = { gizmo: idle, calls: quietCalls, editMs: Math.round(idleEdit.ms) };

    // ----- 2. The person drags the gizmo's handle: the factory holds a preview. Nothing cancels it.
    await live.native.read(NATIVE_ESCAPE_SOURCE, [], 15_000);
    await clickBox();
    const before = await live.status(); // the last state Plasticity lets anybody read until the preview is gone
    const beforeView = await live.view();
    await drag();
    const dragged = await read();
    live.check("gizmo", `set-up: a real press and drag on the handle, button held: ${gizmoText(dragged)}`, dragged?.agent === "automatic" && dragged.state === "Awaiting" && (dragged.factory !== "none" || (dragged.temps ?? 0) > 0), dragged);
    const unchanged = async () => { const now = await read(); const view = await live.view(); return { ok: same(now, dragged) && view.undoDepth === beforeView.undoDepth && JSON.stringify(view.selection) === JSON.stringify(beforeView.selection), now, view }; };
    const refused: Record<string, unknown> = {};
    const toolCalls = (phase: string): Array<[string, () => Promise<{ error?: string; result?: any; ms: number }>, RegExp | null]> => [
      ["plasticity_status", () => attempt("plasticity_status", {}), editing],
      ["plasticity_reconcile", () => attempt("plasticity_reconcile", {}), /Plasticity is busy: the user is editing, so the document cannot be read and the session was not reconciled\. \S+ is active and holds changes the user made \(the preview of its gizmo\); it was not touched\./],
      ["plasticity_export_step", () => attempt("plasticity_export_step", { ids: [moved], path: join(output, `gizmo-${phase}.step`), revision: before.revision }), editing],
      ["plasticity_create_section_analysis", () => attempt("plasticity_create_section_analysis", { originMm: [T0[0] + 10, 10, 10], normal: [0, 0, 1], intent: "gizmo: section", revision: before.revision }), editing],
      // A screenshot to a file reads no state first; its own source refuses a busy executor in Plasticity's older words.
      ["plasticity_screenshot", () => attempt("plasticity_screenshot", { path: join(output, `gizmo-${phase}.png`), captureMode: "viewport" }), /Plasticity is busy/],
      ["a source without a command (as plasticity_save_copy sends)", async () => { const reply = await raw(QUIET); return { ...(reply.error ? { error: reply.error } : { result: reply.value }), ms: 0 }; }, null],
      ["plasticity_move (an edit)", () => attempt("plasticity_move", { ids: [moved], deltaMm: [0, 0, 1], intent: "gizmo: an edit while the user is editing", revision: before.revision }), editing],
      ["plasticity_undo (an edit)", () => attempt("plasticity_undo", { steps: 1, intent: "gizmo: an edit while the user is editing", revision: before.revision }), editing],
      ["plasticity_batch of two moves", () => attempt("plasticity_batch", { steps: [1, 2].map(() => ({ toolName: "plasticity_move", arguments: { ids: [moved], deltaMm: [0, 0, 1], intent: "gizmo: an edit while the user is editing" } })) }), editing],
      ["a command source sent straight to the guard", async () => { const reply = await raw(COMMAND); return { ...(reply.error ? { error: reply.error } : { result: reply.value }), ms: 0 }; }, /Plasticity is busy: the user is editing with the \S+ gizmo \(it holds a preview with changes that are not committed\)\. Finish or cancel that gizmo in Plasticity, then repeat this call\. Nothing was changed/],
    ];
    for (const phase of ["held", "released"]) {
      if (phase === "released") {
        await release();
        const afterRelease = await read();
        live.check("gizmo", `the button is released: the preview stays (${gizmoText(afterRelease)})`, same(afterRelease, dragged), afterRelease);
      }
      for (const [label, call, expected] of toolCalls(phase)) {
        const reply = await call();
        const state = await unchanged();
        refused[`${phase}: ${label}`] = { error: reply.error?.slice(0, 400), ms: reply.ms, gizmo: state.now };
        live.check("gizmo", `preview ${phase}: ${label} ${expected ? `is refused (${(reply.error ?? "NOT REFUSED").slice(0, 110)}...)` : "returns"}; the gizmo, its preview, the selection and the Undo depth are as they were`,
          (expected ? reply.error !== undefined && expected.test(reply.error) : reply.error === undefined) && state.ok, { error: reply.error?.slice(0, 400), state });
      }
    }
    // The person cancels the gizmo (Escape): the document can be read again, nothing of the refused calls happened, edits run.
    await live.native.read(NATIVE_ESCAPE_SOURCE, [], 15_000);
    const afterCancel = await live.status();
    live.check("gizmo", "after the person cancels the gizmo the document reads as before the drag: no refused call changed anything", afterCancel.undoDepth === before.undoDepth && afterCancel.revision === before.revision && (await expectBounds(live, moved, [T0[0], 0, 1], [T0[0] + 20, 20, 21])) === undefined, { before: before.revision, after: afterCancel.revision });
    const afterCancelEdit = await live.edit("plasticity_move", { ids: [moved], deltaMm: [0, 0, 1], intent: "gizmo: the edit after the user's cancel" });
    live.check("gizmo", `the same edit then runs (${Math.round(afterCancelEdit.ms)} ms)`, (await expectBounds(live, moved, [T0[0], 0, 2], [T0[0] + 20, 20, 22])) === undefined && (await live.view()).active === null);
    live.evidence.gizmoEdited = { gizmo: dragged, calls: refused };

    // ----- 3. A call that was given up (its CDP request timed out, the source is still pending in the window).
    // 3a. The person selects something after the timeout and keeps the gizmo; the selection is still theirs when the source settles.
    await live.native.read(NATIVE_ESCAPE_SOURCE, [], 15_000);
    await selectFaces(live, [[user, faceId]]);
    const saved = (await live.view()).selection;
    const givenUp = await raw(hungSource(true), 700);
    const afterTimeout = await live.view();
    live.check("gizmo", `set-up: a guarded call is given up after 700 ms (${givenUp.error?.slice(0, 60)}); the guard had set the selection (${saved.join(" ")}) aside`, /timed out/i.test(givenUp.error ?? "") && live.native.isUncertain() && afterTimeout.selection.length === 0 && afterTimeout.active === null, { givenUp, afterTimeout });
    await clickBox(); // about 0.7 s after the timeout
    const clicked = await read();
    const clickedView = await live.view();
    await pause(1_000);
    const later = await read();
    live.check("gizmo", `a real click after the timeout keeps its gizmo: ${gizmoText(clicked)}, and 1 s later ${gizmoText(later)}`, clicked?.agent === "automatic" && same(clicked, later) && clickedView.selection.length === 1 && JSON.stringify(clickedView.selection) !== JSON.stringify(saved), { clicked, later, clickedView });
    // An edit of the server while that source is still pending: it runs in its normal time, cancels the untouched
    // gizmo as any edit does, and puts the person's selection back.
    const pendingEdit = await live.edit("plasticity_move", { ids: [moved], deltaMm: [0, 0, 1], intent: "gizmo: an edit while a given-up source is pending" });
    const afterPendingEdit = await live.view();
    live.check("gizmo", `an edit while the given-up source is still pending returns (${Math.round(pendingEdit.ms)} ms); the person's selection is back and no command is active`, pendingEdit.ms <= SINGLE_EDIT_LIMIT_MS && afterPendingEdit.active === null && JSON.stringify(afterPendingEdit.selection) === JSON.stringify(clickedView.selection) && (await expectBounds(live, moved, [T0[0], 0, 3], [T0[0] + 20, 20, 23])) === undefined, afterPendingEdit);
    await live.native.read(RELEASE_SOURCE);
    await pause(700);
    const settled = await live.view();
    live.check("gizmo", `the source settles: the selection made after the timeout is still there (${settled.selection.join(" ")}), not the one the guard had saved`, JSON.stringify(settled.selection) === JSON.stringify(clickedView.selection), settled);
    await live.native.read(NATIVE_ESCAPE_SOURCE, [], 15_000);
    await clickBox();
    const afterSettle = await read();
    await pause(1_000);
    live.check("gizmo", `a real click after the source settled keeps its gizmo (${gizmoText(afterSettle)})`, afterSettle?.agent === "automatic" && afterSettle.state === "Awaiting" && same(afterSettle, await read()), afterSettle);
    const repair = await live.native.reconcile();
    live.check("gizmo", "reconcile afterwards has no selection to put back", repair.recovery?.restoredSelection === undefined && !live.native.isUncertain(), repair.recovery);

    // 3b. Nobody selects anything: reconcile puts the saved selection back, and the late source does not put it back twice.
    await live.native.read(NATIVE_ESCAPE_SOURCE, [], 15_000);
    await selectFaces(live, [[user, faceId]]);
    const givenUpAgain = await raw(hungSource(true), 700);
    const emptied = await live.view();
    const restored = await live.native.reconcile();
    const afterRestore = await live.view();
    live.check("gizmo", `a call is given up and nobody selects anything: reconcile puts the selection back and says so (${restored.recovery?.note})`, /timed out/i.test(givenUpAgain.error ?? "") && emptied.selection.length === 0 && restored.recovery?.restoredSelection === 1 && JSON.stringify(afterRestore.selection) === JSON.stringify(saved) && afterRestore.active === null, { emptied, recovery: restored.recovery, afterRestore });
    await live.native.read(RELEASE_SOURCE);
    await pause(700);
    const settledAgain = await live.view();
    live.check("gizmo", "the source settles: the selection is the one reconcile put back", JSON.stringify(settledAgain.selection) === JSON.stringify(saved), settledAgain);

    // 3c. The same with a source that runs no command (the reviewer's): it is not guarded, so nothing is set aside at all.
    await live.native.read(NATIVE_ESCAPE_SOURCE, [], 15_000);
    if (live.native.isUncertain()) await live.native.reconcile();
    await selectFaces(live, [[user, faceId]]);
    const quietGivenUp = await raw(hungSource(false), 700);
    const quietView = await live.view();
    live.check("gizmo", "a given-up source that runs no command: the selection was never set aside", /timed out/i.test(quietGivenUp.error ?? "") && JSON.stringify(quietView.selection) === JSON.stringify(saved), { quietGivenUp, quietView });
    await clickBox();
    const quietClicked = await read();
    await pause(1_000);
    live.check("gizmo", `a real click after that timeout keeps its gizmo (${gizmoText(quietClicked)})`, quietClicked?.agent === "automatic" && same(quietClicked, await read()), quietClicked);
    const quietSelection = (await live.view()).selection;
    await live.native.read(RELEASE_SOURCE);
    await pause(500);
    live.check("gizmo", "that source settles: the gizmo and the selection are as the person left them", same(quietClicked, await read()) && JSON.stringify((await live.view()).selection) === JSON.stringify(quietSelection));
    live.evidence.givenUp = { saved, clicked, clickedSelection: clickedView.selection, settled: settled.selection, reconcile: restored.recovery };
    console.log(`gizmo: untouched ${idle?.name}: 6 calls without a command left it, an edit cancelled it and put the selection back; dragged (${dragged?.factory}, ${dragged?.temps} temp, ${dragged?.distanceMm} mm): 18 tool calls and 2 raw sources left it and its preview, edits were refused; given-up call: the later click kept its gizmo and its selection; reconcile: ${restored.recovery?.note}`);
  } finally {
    await live.native.read(RELEASE_SOURCE).catch(() => undefined);
    if (pressed) await mouse("mouseReleased", pressed[0], pressed[1], 0).catch(() => undefined);
    await pause(300);
    await live.native.read(NATIVE_ESCAPE_SOURCE, [], 15_000).catch(() => undefined);
    await live.native.read("function () { delete globalThis.__selectionLive; return true; }").catch(() => undefined);
    await live.native.read(SET_CAMERA_SOURCE, [{ target: camera.target, q: camera.q, radius: camera.radius, zoom: camera.zoom }], 15_000).catch(() => undefined);
    if (live.native.isUncertain()) await live.native.reconcile().catch(() => undefined);
    await attempt("plasticity_delete_section_analysis", { all: true, intent: "gizmo: restore", revision: (await live.status()).revision }).catch(() => undefined);
    await live.undoTo(baseDepth);
  }
}

// ---------- speed, nothing selected: this tree against the tree before the guard ----------
/**
 * The native time of the batch's five calls with the selection guard on and off, interleaved, in this process: this
 * tree's PlasticityOperations on one CDP connection, with runtime.mutate() timed and its selectionGuard option set per run.
 */
async function nativeBatchCost(native: PlasticityRuntime, rounds: number): Promise<{ plainMs: number; guardedMs: number; pairedMs: number; samples: number }> {
  let guard = true;
  let bucket: number[] | undefined;
  const mutate = native.mutate.bind(native);
  const timedRuntime = new Proxy(native, { get(target, key) {
    if (key !== "mutate") { const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; }
    return async (source: string, bindings: string[], values: unknown[], timeoutMs?: number) => {
      const started = performance.now();
      try { return await mutate(source, bindings, values, timeoutMs, { selectionGuard: guard }); } finally { bucket?.push(performance.now() - started); }
    };
  } });
  const operations = new PlasticityOperations(timedRuntime, "selection-live-speed");
  const sums: { on: number[]; off: number[] } = { on: [], off: [] };
  for (let round = 0; round < rounds + 2; round += 1) {
    for (const mode of (round % 2 === 0 ? ["off", "on"] : ["on", "off"]) as Array<"on" | "off">) {
      guard = mode === "on";
      const times: number[] = [];
      let state = await operations.state();
      const known = new Set(state.bodies.map((body) => body.id));
      bucket = times;
      state = await operations.createBox([X0 + 400, 0, 0], [10, 10, 10], undefined, state.revision);
      const id = state.bodies.find((body) => !known.has(body.id))!.id;
      state = await operations.move([id], [1, 0, 0], state.revision);
      state = await operations.move([id], [0, 1, 0], state.revision);
      state = await operations.move([id], [0, 0, 1], state.revision);
      await operations.remove([id], state.revision);
      bucket = undefined;
      if (round >= 2) sums[mode].push(times.reduce((total, value) => total + value, 0)); // the first two rounds warm up
    }
  }
  return { plainMs: round1(median(sums.off)), guardedMs: round1(median(sums.on)), pairedMs: round1(median(sums.on.map((value, index) => value - sums.off[index]!))), samples: rounds };
}

// `current` is a server of this tree that was started for this section only, like the baseline one: the server that
// ran the other sections carries their journal and history, which would count against the guard.
async function speed(live: Live, baseline: Client, current: Client, rounds: { move: number; batch: number }): Promise<void> {
  const baseDepth = (await live.status()).undoDepth;
  const batchSteps = (x: number) => ({ steps: [
    { toolName: "plasticity_create_box", arguments: { originMm: [x, 0, 0], sizeMm: [10, 10, 10], intent: "speed" } },
    { toolName: "plasticity_move", arguments: { ids: ["$0.added[0]"], deltaMm: [1, 0, 0], intent: "speed" } },
    { toolName: "plasticity_move", arguments: { ids: ["$0.added[0]"], deltaMm: [0, 1, 0], intent: "speed" } },
    { toolName: "plasticity_move", arguments: { ids: ["$0.added[0]"], deltaMm: [0, 0, 1], intent: "speed" } },
    { toolName: "plasticity_delete", arguments: { ids: ["$0.added[0]"], intent: "speed" } },
  ] });
  try {
    await live.clearSelection();
    // The guard's own cost, measured where it lives: one native call (a tagged read of the document) with and without
    // the guard around it, interleaved over one CDP connection. No edit, so no noise from the renderer's history.
    const plain = nativeFunction`async function () { return nativeApi.geo.geometryModel.size; }`;
    const guardedSource = selectionSafeSource(plain);
    const direct: { plain: number[]; guarded: number[] } = { plain: [], guarded: [] };
    for (let index = 0; index < 300; index += 1) {
      for (const [source, bucket] of (index % 2 === 0 ? [[plain, direct.plain], [guardedSource, direct.guarded]] : [[guardedSource, direct.guarded], [plain, direct.plain]]) as Array<[string, number[]]>) {
        const started = performance.now();
        await live.native.read(source);
        bucket.push(performance.now() - started);
      }
    }
    const perCall = { plainMs: Math.round(median(direct.plain) * 1000) / 1000, guardedMs: Math.round(median(direct.guarded) * 1000) / 1000 };
    live.check("speed", `the guard itself, nothing selected: a native call takes ${perCall.guardedMs} ms inside it against ${perCall.plainMs} ms without (300 interleaved calls each); it adds less than 1 ms per call`, perCall.guardedMs - perCall.plainMs < 1, perCall);
    console.log(`speed, the guard itself: ${perCall.plainMs} ms per native call without it, ${perCall.guardedMs} ms inside it (a 5-step batch makes 5 such calls)`);
    // The same for the five native calls of the batch below (create a box, move it three times, delete it), run by
    // this tree's own operations over one CDP connection with the guard on and off in turn. Only the time inside
    // runtime.mutate() is counted: it is the only place where the two trees differ for these tools.
    const native5 = await nativeBatchCost(live.native, 40);
    live.check("speed", `5-step batch, nothing selected, its five native calls: median ${native5.guardedMs} ms inside the guard against ${native5.plainMs} ms without (${native5.samples} interleaved runs each, paired difference ${native5.pairedMs} ms); the rise is at most ${SPEED_LIMIT_MS} ms`, native5.guardedMs - native5.plainMs <= SPEED_LIMIT_MS, native5);
    console.log(`speed, the five native calls of the batch: ${native5.plainMs} ms without the guard, ${native5.guardedMs} ms inside it (paired difference ${native5.pairedMs} ms)`);
    // A renderer garbage collection stalls one call for seconds and slows the next few. Both servers get the same
    // treatment: a collection before the samples and after every block of rounds. A block has an odd number of
    // rounds, so the server that runs first after a collection changes from block to block.
    const collect = async () => { await live.native.cdp("HeapProfiler.collectGarbage").catch(() => undefined); await live.native.cdp("Runtime.getHeapUsage").catch(() => undefined); };
    await collect();
    const moved = await live.box(T0, [10, 10, 10]);
    const servers: Array<{ name: "before" | "after"; client: Client; move: number[]; batch: number[] }> = [
      { name: "before", client: baseline, move: [], batch: [] }, { name: "after", client: current, move: [], batch: [] },
    ];
    const timed = async (client: Client, name: string, args: (revision: string) => Record<string, unknown>) => {
      const revision = (await callTool(client, "plasticity_status", {})).revision;
      const started = performance.now();
      await callTool(client, name, args(revision));
      return performance.now() - started;
    };
    // Warm both servers (the first calls connect and compile), then alternate, changing who goes first every round.
    for (const server of servers) for (let index = 0; index < 3; index += 1) await timed(server.client, "plasticity_move", (revision) => ({ ids: [moved], deltaMm: [1, 0, 0], intent: "speed warm-up", revision }));
    for (let round = 0; round < rounds.move; round += 1) {
      if (round > 0 && round % 15 === 0) await collect();
      for (const server of round % 2 === 0 ? servers : [...servers].reverse()) server.move.push(await timed(server.client, "plasticity_move", (revision) => ({ ids: [moved], deltaMm: [round % 2 === 0 ? 1 : -1, 0, 0], intent: "speed", revision })));
    }
    for (const server of servers) await timed(server.client, "plasticity_batch", () => batchSteps(X0 + 400));
    await collect();
    for (let round = 0; round < rounds.batch; round += 1) {
      if (round > 0 && round % 5 === 0) await collect();
      for (const server of round % 2 === 0 ? servers : [...servers].reverse()) server.batch.push(await timed(server.client, "plasticity_batch", () => batchSteps(X0 + 400)));
    }
    const [before, after] = servers as [typeof servers[number], typeof servers[number]];
    // pairedMs: the median of (after - before) within one round, where both calls saw the same renderer state.
    const paired = (key: "move" | "batch") => round1(median(after[key].map((value, index) => value - before[key][index]!)));
    const numbers = {
      move: { beforeMs: round1(median(before.move)), afterMs: round1(median(after.move)), pairedMs: paired("move"), samples: rounds.move },
      batch: { beforeMs: round1(median(before.batch)), afterMs: round1(median(after.batch)), pairedMs: paired("batch"), samples: rounds.batch },
    };
    live.check("speed", `plasticity_move, nothing selected: median ${numbers.move.afterMs} ms against ${numbers.move.beforeMs} ms before the guard (${rounds.move} interleaved calls each); the rise is at most ${SPEED_LIMIT_MS} ms`, numbers.move.afterMs - numbers.move.beforeMs <= SPEED_LIMIT_MS, numbers.move);
    // The whole batch call through both servers is reported, not judged: on this renderer its median moves by 10 to 30
    // ms from run to run between two servers of the SAME tree (a collection of the 230 MB heap takes 6 s and the calls
    // after it are slow), in both directions. The five native calls above are where the two trees differ, and they are judged.
    console.log(`speed, 5-step batch through both servers (reported, not judged: see the script): median before ${numbers.batch.beforeMs} ms, after ${numbers.batch.afterMs} ms (paired difference ${numbers.batch.pairedMs} ms, ${rounds.batch} calls each)`);
    live.evidence.speed = { ...numbers, perCall, native5, moveSamples: { before: before.move.map(round1), after: after.move.map(round1) }, batchSamples: { before: before.batch.map(round1), after: after.batch.map(round1) } };
    console.log(`speed, nothing selected: plasticity_move median before ${numbers.move.beforeMs} ms, after ${numbers.move.afterMs} ms (paired difference ${numbers.move.pairedMs} ms, ${rounds.move} calls each)`);
  } finally {
    await live.undoTo(baseDepth);
  }
}

async function main(): Promise<void> {
  const options = parseSelectionArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const endpoint = process.env.PLASTICITY_CDP_URL;
  if (!endpoint) throw new Error("PLASTICITY_CDP_URL is mandatory and must name the isolated Plasticity instance; nothing was created");
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 }); // fails when the directory exists: evidence is never overwritten
  const target = (await discoverPlasticityTargets(endpoint)).find((candidate) => candidate.id === options.target);
  if (!target) throw new Error("Explicit Plasticity target was not found on PLASTICITY_CDP_URL");
  const native = await PlasticityRuntime.connect(target);
  const client = await startMcp(projectRoot, output, "plasticity-selection-live");
  const withSpeed = options.sections.includes("speed") && !options.skipSpeed;
  const baseline = withSpeed ? await startMcp(options.baselineRoot!, join(output, "baseline"), "plasticity-selection-live-baseline") : undefined;
  const speedServer = withSpeed ? await startMcp(projectRoot, join(output, "speed"), "plasticity-selection-live-speed") : undefined;
  const live = new Live(client, native);
  let last = "";
  try {
    await live.call("plasticity_connect", { targetId: options.target });
    if (baseline) await callTool(baseline, "plasticity_connect", { targetId: options.target });
    if (speedServer) await callTool(speedServer, "plasticity_connect", { targetId: options.target });
    const start = await live.status();
    const startView = await live.view();
    const startBodies = start.bodies.map((body: { id: number }) => body.id).sort((a: number, b: number) => a - b);
    if (startView.active || startView.selection.length > 0) throw new Error(`The instance is not idle: ${startView.active ? `${startView.active.name} is active` : `${startView.selection.length} item(s) are selected`}; nothing was created`);
    live.documentBodies = new Set(startBodies);
    live.evidence.start = { undoDepth: start.undoDepth, bodies: startBodies, revision: start.revision };
    try {
      // Speed first: the other sections add some 1,500 edits to the renderer's history, and with them garbage collections.
      if (withSpeed) await speed(live, baseline!, speedServer!, { move: 80, batch: 60 });
      if (options.sections.includes("matrix")) await matrix(live);
      if (options.sections.includes("repeat")) await repeat(live);
      if (options.sections.includes("entry")) await entry(live);
      if (options.sections.includes("recovery")) await recovery(live, baseline);
      if (options.sections.includes("gizmo")) await gizmo(live, output);
    } finally {
      await native.read(NATIVE_CLEAR_SOURCE, [], 15_000).catch(() => undefined);
      await live.undoTo(start.undoDepth).catch((error) => { live.check("restore", "the Undo depth of the start is restored", false, String(error)); });
    }
    const end = await live.status();
    const endView = await live.view();
    const endBodies = end.bodies.map((body: { id: number }) => body.id).sort((a: number, b: number) => a - b);
    live.check("restore", `the document is as it was found: Undo depth ${start.undoDepth}, bodies ${startBodies.join(", ")}`, end.undoDepth === start.undoDepth && JSON.stringify(endBodies) === JSON.stringify(startBodies), { undoDepth: end.undoDepth, bodies: endBodies });
    live.check("restore", "no selection and no active command at the end", endView.selection.length === 0 && endView.active === null, endView);
    const failed = live.checks.filter((check) => !check.ok);
    last = `${failed.length === 0 ? "PASS" : "FAIL"}: ${live.checks.length - failed.length} of ${live.checks.length} checks pass; undo depth ${end.undoDepth}; bodies ${endBodies.join(", ")}; selection ${endView.selection.length === 0 ? "none" : endView.selection.join(" ")}; active command ${endView.active ? endView.active.name : "none"}`;
    live.evidence.end = { undoDepth: end.undoDepth, bodies: endBodies, selection: endView.selection, active: endView.active };
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await writeFile(join(output, "evidence.json"), JSON.stringify({ checks: live.checks, ...live.evidence }, null, 1)).catch(() => undefined);
    await client.close().catch(() => undefined);
    await baseline?.close().catch(() => undefined);
    await speedServer?.close().catch(() => undefined);
    native.close();
  }
  console.log(last);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
