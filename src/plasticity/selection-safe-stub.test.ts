import assert from "node:assert/strict";
import { test } from "node:test";

import type { CdpClient } from "../cdp/client.ts";
import { PlasticityRuntime } from "./runtime.ts";

// A stub of the parts of Plasticity's renderer that decide whether a call hangs on a selection, as measured live on
// 26.1.3 (discovery/probes-2026-11-pick/FINDINGS.md, "Selection and default commands"):
//  - exec() runs the command; when it FINISHED and a face or an edge is selected, the executor starts the default
//    command for the selection (agent "automatic"), which awaits the user, and the exec() that owns the chain stays
//    pending until that command is cancelled;
//  - a command that fails is cancelled, the selection goes back to the selection of the last history step, and no
//    default command is started;
//  - exec() while another command is active interrupts that command (the selection goes back to that of the last
//    history step, as after a failure) and resolves when its own command has ended; the chain then belongs to the
//    exec() that was active first;
//  - cancelling a default command keeps the selection and starts no other default command;
//  - a selection id is "<kind>:<versionId>"; a stale id makes the typed getters and validate() throw.

class Solid { versionId: number; constructor(versionId: number) { this.versionId = versionId; } }
class Sheet { versionId: number; constructor(versionId: number) { this.versionId = versionId; } }
class Wire { versionId: number; constructor(versionId: number) { this.versionId = versionId; } }
class Face { versionId: string; constructor(versionId: string) { this.versionId = versionId; } }
class CurveEdge { versionId: string; constructor(versionId: string) { this.versionId = versionId; } }
const BODY_CLASSES = { Solid, Sheet, Wire } as const;
const KIND = { edge: "0", face: "2", solid: "4", sheet: "5", curve: "7" } as const;

class RefCounter {
  counts = new Map<number, number>();
  values = new Map<number, string[]>();
  cb = () => undefined;
}
class SelectionMemento {
  ids: Set<string>;
  parentsWithSelectedChildren: RefCounter;
  constructor(ids: Set<string>, parents: RefCounter) { this.ids = ids; this.parentsWithSelectedChildren = parents; }
}

export interface StubCommand { agent: string; _state: string; resources: unknown[]; execute?: () => Promise<unknown>; constructor: { name: string } }
export interface StubOptions {
  /** Bodies of the document: version id, stable id and type. */
  bodies?: Array<{ version: number; stableId: number; type: keyof typeof BODY_CLASSES }>;
  /** restoreFromMemento always throws. */
  restoreThrows?: boolean;
  /** add() always throws. */
  addThrows?: boolean;
}

export function stubPlasticity(options: StubOptions = {}) {
  const geometryModel = new Map<number, { view: Solid | Sheet | Wire }>();
  const stable = new Map<number, number>();
  const setBody = (version: number, stableId: number, type: keyof typeof BODY_CLASSES) => { geometryModel.set(version, { view: new BODY_CLASSES[type](version) }); stable.set(version, stableId); };
  for (const body of options.bodies ?? [{ version: 1, stableId: 1, type: "Solid" as const }, { version: 2, stableId: 5, type: "Solid" as const }]) setBody(body.version, body.stableId, body.type);
  const signals = { selectionChanged: 0 };
  const bodyVersion = (rest: string) => Number((/^[0-9]+/.exec(rest) ?? [])[0]);
  const lookup = (id: string) => {
    const [kind, rest] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
    if (!editor.geo.geometryModel.has(bodyVersion(rest))) throw new Error(`invalid precondition: object ${bodyVersion(rest)} missing from geometry model`);
    if (kind === KIND.face) return new Face(rest);
    if (kind === KIND.edge) return new CurveEdge(rest);
    return editor.geo.geometryModel.get(Number(rest))!.view;
  };
  const parentsOf = (ids: Iterable<string>) => {
    const parents = new RefCounter();
    for (const id of ids) {
      const rest = id.slice(id.indexOf(":") + 1);
      if (/^[0-9]+$/.test(rest)) continue;
      const parent = bodyVersion(rest);
      parents.values.set(parent, [...(parents.values.get(parent) ?? []), id]);
      parents.counts.set(parent, parents.values.get(parent)!.length);
    }
    return parents;
  };
  const selected = {
    ids: new Set<string>(),
    restoreCalls: 0,
    get size() { return this.ids.size; },
    get itemIds() { return [...this.ids].filter((id) => /^[457]:[0-9]+$/.test(id)).map((id) => Number(id.slice(2))); },
    of(kind: string) { return [...this.ids].filter((id) => id.startsWith(`${kind}:`)).map(lookup); },
    get solids() { return this.of(KIND.solid); },
    get sheets() { return this.of(KIND.sheet); },
    get curves() { return this.of(KIND.curve); },
    get faces() { return this.of(KIND.face); },
    get edges() { return this.of(KIND.edge); },
    validate() { for (const id of this.ids) lookup(id); },
    add(item: { versionId: number | string }) {
      if (options.addThrows) throw new Error("add refused");
      const kind = item instanceof Face ? KIND.face : item instanceof CurveEdge ? KIND.edge : item instanceof Sheet ? KIND.sheet : item instanceof Wire ? KIND.curve : KIND.solid;
      this.ids.add(`${kind}:${item.versionId}`);
      signals.selectionChanged += 1;
    },
    removeAll() { if (this.ids.size > 0) signals.selectionChanged += 1; this.ids = new Set(); },
    saveToMemento() { return new SelectionMemento(new Set(this.ids), parentsOf(this.ids)); },
    restoreFromMemento(memento: SelectionMemento) {
      this.restoreCalls += 1;
      if (options.restoreThrows) throw new Error("restore refused");
      this.ids = new Set(memento.ids);
      signals.selectionChanged += 1;
    },
  };
  const select = (...ids: string[]) => { selected.ids = new Set(ids); };
  const hasDefault = () => [...selected.ids].some((id) => id.startsWith(`${KIND.face}:`) || id.startsWith(`${KIND.edge}:`));

  /** Every cancelActiveCommand() call: the command and its state at that moment. */
  const cancelCalls: Array<{ name: string; agent: string; state: string }> = [];
  /** Default commands the executor started. */
  const defaultsStarted: StubCommand[] = [];
  /** Commands that ran, with the selection they started with. */
  const executed: Array<{ name: string; selectionAtStart: string[]; activeAtStart: string | null }> = [];
  let lastCommitSelection = new Set<string>();
  type HistoryEntry = { selection: Set<string>; replace?: Array<[number, number]> };
  const history = { undoStack: [] as HistoryEntry[], redoStack: [] as HistoryEntry[] };
  // The document of a history state: a fresh Map with the listed body versions swapped (the stable ids stay).
  const restoreModel = (entry: HistoryEntry) => {
    const model = new Map(editor.geo.geometryModel);
    for (const [from, to] of entry.replace ?? []) { const item = model.get(from); if (!item) continue; model.delete(from); const type = item.view.constructor.name as keyof typeof BODY_CLASSES; model.set(to, { view: new BODY_CLASSES[type](to) }); stable.set(to, stable.get(from)!); stable.delete(from); }
    editor.geo.geometryModel = model;
  };
  const waiters = new Map<StubCommand, () => void>();
  const executor = {
    active: undefined as { command: StubCommand } | undefined,
    isBusy: false,
    cancelActiveCommand() {
      const command = this.active?.command;
      if (!command) return;
      cancelCalls.push({ name: command.constructor.name, agent: command.agent, state: command._state });
      end(command, "Cancelled");
    },
  };
  // Ends a command that awaits: it leaves the executor a few microtask turns later, as live.
  const end = (command: StubCommand, state: string) => {
    command._state = state;
    void Promise.resolve().then(() => Promise.resolve()).then(() => {
      if (executor.active?.command === command) executor.active = undefined;
      waiters.get(command)?.();
      waiters.delete(command);
    });
  };
  const awaitCommand = (command: StubCommand) => new Promise<void>((resolve) => { waiters.set(command, resolve); });
  const startDefault = (name = "OffsetFaceCommand", state = "Awaiting", resources: unknown[] = []): StubCommand => {
    const command: StubCommand = { agent: "automatic", _state: state, resources, constructor: { name } };
    defaultsStarted.push(command);
    executor.active = { command };
    return command;
  };
  /** The chain after a finished command or a history step: pending until the default command is cancelled. */
  const chain = async () => {
    if (!hasDefault()) return;
    await awaitCommand(startDefault());
  };
  const editor = {
    executor,
    selection: { selected },
    geo: { geometryModel },
    db: { lookupStableId: (version: number) => stable.get(version) },
    history,
    commands: {} as Record<string, unknown>,
    marker: "editor",
    async exec(command: StubCommand) {
      const interrupted = executor.active?.command;
      if (interrupted) { interrupted._state = "Cancelled"; selected.ids = new Set(lastCommitSelection); }
      executed.push({ name: command.constructor.name, selectionAtStart: [...selected.ids], activeAtStart: interrupted ? interrupted.constructor.name : null });
      executor.active = { command };
      let finished = false;
      try { await command.execute!(); command._state = "Finished"; finished = true; }
      catch { command._state = "Cancelled"; selected.ids = new Set(lastCommitSelection); }
      if (executor.active?.command === command) executor.active = undefined;
      if (finished) { lastCommitSelection = new Set(selected.ids); history.undoStack.push({ selection: new Set(selected.ids) }); history.redoStack.length = 0; }
      if (interrupted) {
        // The exec() that was active first owns the chain: this one resolves now, and that one goes on (its command ended).
        waiters.get(interrupted)?.();
        waiters.delete(interrupted);
        if (finished) void chain();
        return;
      }
      if (finished) await chain();
    },
    // A history step puts a NEW geometry model object in place (measured live), restores the selection its state holds
    // and chains like a finished command; the promise stays pending meanwhile.
    async undo() { const entry = history.undoStack.pop(); if (!entry) return; history.redoStack.push(entry); restoreModel(entry); selected.ids = new Set(entry.selection); await chain(); },
    async redo() { const entry = history.redoStack.pop(); if (!entry) return; history.undoStack.push(entry); restoreModel(entry); selected.ids = new Set(entry.selection); await chain(); },
  };
  class ServerCommand {
    agent = "user"; _state = "None"; resources: unknown[] = []; remember = true;
    execute = async (): Promise<unknown> => undefined;
  }
  editor.commands.ServerCommand = ServerCommand;

  let calls = 0;
  const client = {
    async send(method: string, params: Record<string, unknown> = {}) {
      assert.equal(method, "Runtime.callFunctionOn");
      calls += 1;
      const execute = new Function(`return (${String(params.functionDeclaration)})`)() as (...values: unknown[]) => unknown;
      const args = (params.arguments as Array<{ value?: unknown }>).map((argument) => argument.value);
      try {
        const value = await execute.apply(editor, args);
        return { result: { value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) } };
      } catch (error) {
        return { exceptionDetails: { exception: { description: error instanceof Error ? `Error: ${error.message}` : String(error) } } };
      }
    },
    close() {},
  } as unknown as CdpClient;
  const RuntimeConstructor = PlasticityRuntime as unknown as new (client: CdpClient, target: { id: string; title: string; webSocketDebuggerUrl: string }, editorId: string) => PlasticityRuntime;
  const runtime = new RuntimeConstructor(client, { id: "window-1", title: "Part", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/1" }, "editor");
  const log: string[] = [];
  // The guard's log setter exists only with the fix; the stub also runs against the code before it.
  (runtime as unknown as { setSelectionGuardLog?: (log: (line: string) => void) => void }).setSelectionGuardLog?.((line) => { log.push(line); });

  /** Replaces a body version, as an edit does: the stable id stays. Without `next` the body is deleted. */
  const replaceBody = (version: number, next?: number) => {
    const model = editor.geo.geometryModel;
    const type = model.get(version)!.view.constructor.name as keyof typeof BODY_CLASSES;
    const stableId = stable.get(version)!;
    model.delete(version); stable.delete(version);
    if (next !== undefined && next !== null) { model.set(next, { view: new BODY_CLASSES[type](next) }); stable.set(next, stableId); }
  };
  (editor as unknown as { __replace: typeof replaceBody }).__replace = replaceBody;

  return {
    editor, executor, selected, geometryModel, runtime, log, signals, cancelCalls, defaultsStarted, executed, history,
    select, setBody, startDefault, awaitCommand, replaceBody,
    selection: () => [...selected.ids],
    cdpCalls: () => calls,
    setLastCommitSelection(...ids: string[]) { lastCommitSelection = new Set(ids); },
  };
}

/**
 * Lets runtime.getState() (and so reconcile() and PlasticityOperations.state()) read the stub document: the editor
 * parts the state read asks for, the native bindings it takes, and a seeded topology cache for the stub bodies (their
 * kernel models do not exist here).
 */
export function enableStateRead(stub: ReturnType<typeof stubPlasticity>): void {
  const plane = { name: "p", p: { x: 0, y: 0, z: 0 }, n: { x: 0, y: 0, z: 1 }, x: { x: 1, y: 0, z: 0 }, y: { x: 0, y: 1, z: 0 } };
  Object.assign(stub.editor, {
    planes: { snapshot: () => ({ ids: new Map(), planes: [] }) }, viewports: [], materials: { list: () => [] },
    measurements: { snapshot: () => ({ repo: { measurements: [] } }) }, document: { uuid: "document-1" },
  });
  Object.assign(stub.editor.geo, { automatics: new Set() });
  Object.assign(stub.editor.db, {
    version: 1,
    nodes: { item2key: () => 1, getName: () => null, getMaterialId: () => 0, isVisible: () => true, isHidden: () => false, isLocked: () => false },
    empties: { snapshot: () => ({ empties: [], infos: [] }) }, groups: { snapshot: () => ({ groupIds: [], children: [], currentGroupId: 0 }) },
  });
  const cacheKey = Symbol.for("plasticity-mcp.body-topology");
  const cache: WeakMap<object, unknown> = Reflect.get(globalThis, cacheKey) ?? new WeakMap();
  Reflect.set(globalThis, cacheKey, cache);
  for (const [versionId, item] of stub.editor.geo.geometryModel) cache.set(item.view, { format: 3, versionId, topology: { boundsMm: null, boundsMethod: "native-box", faces: [], edges: [], vertices: [], faceIds: [], edgeIds: [] } });
  const natives: Record<string, unknown> = { ConstructionPlaneDatabase: { Top: plane, Bottom: plane, Left: plane, Right: plane, Front: plane, Back: plane }, Vector3: class {}, Quaternion: class {}, pk_default: { a: {} } };
  const bindings = (stub.runtime as unknown as { bindings: Map<string, string> }).bindings;
  const client = (stub.runtime as unknown as { client: { send(method: string, params: Record<string, unknown>): Promise<unknown> } }).client;
  const send = client.send.bind(client);
  client.send = async (method, params) => await send(method, { ...params, arguments: (params.arguments as Array<{ objectId?: string; value?: unknown }>).map((argument) => (argument.objectId ? { value: natives[argument.objectId] } : argument)) });
  for (const name of Object.keys(natives)) bindings.set(name, name);
}

/** Rejects when the promise is still pending after ms: a call that hangs fails its test instead of stalling the run. */
export async function within<T>(promise: Promise<T>, ms = 2_000, what = "the call"): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not return within ${ms} ms`)), ms); })]);
  } finally { clearTimeout(timer); }
}

/** A server-style source: one command with an overridden execute(), run through exec(), like commandStart/commandEnd. */
export const COMMAND_SOURCE = `async function (args) {
  const editor = this;
  let failure;
  const command = new this.commands.ServerCommand();
  command.execute = async function () {
    try {
      if (args?.replace) for (const [from, to] of args.replace) editor.__replace(from, to);
      if (args?.select) for (const id of args.select) editor.selection.selected.ids.add(id);
      if (args?.fail) throw new Error(args.fail);
    } catch (error) { failure = error; throw error; }
  };
  await this.exec(command);
  if (failure) throw failure;
  return { ok: true, echo: args?.echo ?? null };
}`;

test("the stub chains a default command after a finished command with a face selected, and only then", async () => {
  const stub = stubPlasticity();
  stub.select("2:1f1");
  const command = new (stub.editor.commands.ServerCommand as new () => StubCommand)();
  let resolved = false;
  void stub.editor.exec(command).then(() => { resolved = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(resolved, false, "exec() stays pending behind the default command");
  assert.equal(stub.executor.active?.command.constructor.name, "OffsetFaceCommand");
  stub.executor.cancelActiveCommand();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(resolved, true);
  assert.equal(stub.executor.active, undefined);
  assert.deepEqual(stub.selection(), ["2:1f1"], "a cancelled default command keeps the selection");
  // A whole body or nothing selected: no default command.
  stub.select("4:1");
  await within(stub.editor.exec(new (stub.editor.commands.ServerCommand as new () => StubCommand)()), 500);
  assert.equal(stub.defaultsStarted.length, 1);
});
