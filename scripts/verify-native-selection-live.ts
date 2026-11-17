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
// 5. Speed with nothing selected. plasticity_move: this tree's server against the server of the tree before the
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
const SECTIONS = ["matrix", "repeat", "entry", "recovery", "speed"] as const;

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
history step that holds a face selection, plasticity_reconcile), speed (plasticity_move and a 5-step batch with nothing
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
      if ((await l.status()).bodies.some((body: { boundsMm?: { min: Vec } }) => body.boundsMm && body.boundsMm.min[0] >= X0 + 400)) return "the batch's own box is still there";
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
    live.evidence.start = { undoDepth: start.undoDepth, bodies: startBodies, revision: start.revision };
    try {
      // Speed first: the other sections add some 1,500 edits to the renderer's history, and with them garbage collections.
      if (withSpeed) await speed(live, baseline!, speedServer!, { move: 80, batch: 60 });
      if (options.sections.includes("matrix")) await matrix(live);
      if (options.sections.includes("repeat")) await repeat(live);
      if (options.sections.includes("entry")) await entry(live);
      if (options.sections.includes("recovery")) await recovery(live, baseline);
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
