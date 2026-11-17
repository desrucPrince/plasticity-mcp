import { CdpClient } from "../cdp/client.ts";
import type { PlasticityTarget } from "../cdp/discovery.ts";
import type { ConstructionPlaneDescriptor } from "./construction.ts";
import { NATIVE_BODY_BOUNDS } from "./native-bounds.ts";
import { nativeFunction } from "./native-function.ts";
import { discoverStoreBindings } from "./native-discovery.ts";

export const NATIVE_STATE_READ_TIMEOUT_MS = 300_000;
export const LONG_NATIVE_IMPORT_TIMEOUT_MS = 300_000;

interface RemoteObject {
  objectId?: string;
  value?: unknown;
  description?: string;
}

interface PropertyDescriptor {
  name: string;
  value?: RemoteObject;
}

interface CallResult {
  result?: RemoteObject;
  exceptionDetails?: { text?: string; exception?: RemoteObject };
}

// ---- Selection guard (discovery/probes-2026-11-pick/FINDINGS.md, "Selection and default commands")
// After a command that FINISHED, Plasticity's executor starts the default command for the current selection (a face:
// PushFace, then OffsetFace or RefilletFace; an edge: FilletShell; a whole body or a curve: none). That command awaits
// the user (a gizmo), so the exec() call that owns the chain never resolves and the CDP call times out. undo()/redo()
// chain the same way when the history state they restore holds a selection. A default command carries agent
// "automatic"; a command the server builds carries "user".
//
// Every mutate() source therefore runs inside this guard:
//  entry  the user's selection is saved (Plasticity's own selection memento); a default command that idles in Awaiting
//         is cancelled (it keeps the selection and does not chain again); the selection is emptied, so the server's
//         command starts, and ends, with the selection its own source sets.
//  exit   (success or failure) a default command chained by a history step is cancelled the same way; the saved
//         selection is put back, without the items whose body version is gone (a whole body follows its stable id).
// The guard only ever cancels a command that is a default command (agent "automatic"), in state Awaiting, with no
// factory at work. With any other command active at entry (a command of the user that awaits its dialog, a gizmo
// that is being dragged) it stands aside: the source runs as it did before the guard, where Plasticity's exec()
// interrupts that command, runs the source's command and resolves; the chain then belongs to the exec() that was
// active first, so the call cannot hang on it. That interrupt sends the selection back to that of the last history
// step, so afterwards the saved selection is put back when nothing is selected and nothing is active.
// It never throws: a failure inside it leaves the source's own result or error untouched.
//
// A source that runs no command at all can opt out with mutate(..., { selectionGuard: false }) (the measurement
// overlay refresh of a state read: a read must not touch the selection). selection-safe-sites.test.ts fails when a
// source that runs a command opts out.

// Renderer helpers shared by the guard and by the recovery step of reconcile(). `executor` is editor.executor.
const EXECUTOR_TOOLS_SOURCE = `function (executor) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const stateTag = value => value === null || value === undefined ? null : typeof value === 'string' ? value : (value.tag ?? value.constructor?.name ?? null);
  // 26.1.3: executor.active is { command, finished }. A build that keeps the command itself there is read the same way.
  const active = () => { const entry = executor.active; return entry ? (entry.command ?? entry) : null; };
  const nameOf = command => command?.constructor?.name ?? 'unknown';
  const isDefault = command => command?.agent === 'automatic';
  // A factory of the command that is updating or committing: the command reads Awaiting meanwhile (FINDINGS surfacing 8.2).
  const computing = command => {
    try {
      for (const resource of command.resources ?? []) {
        const state = resource?._state;
        const tag = stateTag(state !== null && typeof state === 'object' && 'value' in state ? state.value : state);
        if (typeof tag === 'string' && tag !== 'Awaiting' && /ing$/.test(tag)) return true;
      }
      return false;
    } catch { return true; }
  };
  const idleDefault = command => isDefault(command) && stateTag(command._state) === 'Awaiting' && !computing(command);
  // A cancel settles within a few microtask turns (measured: 12); timers are the fallback (a hidden page throttles them).
  const untilIdle = async budgetMs => {
    for (let turn = 0; turn < 256 && executor.active; turn += 1) await Promise.resolve();
    const deadline = Date.now() + budgetMs;
    while (executor.active && Date.now() < deadline) await sleep(4);
    return !executor.active;
  };
  // Cancels the active command while it is an idle default command, and returns the names it cancelled. A default
  // command that is still starting (PushFace before OffsetFace) is waited for; nothing else is ever cancelled.
  const cancelIdleDefaults = async budgetMs => {
    const cancelled = [];
    const deadline = Date.now() + budgetMs;
    for (let round = 0; round < 4; round += 1) {
      let command = active();
      while (command && isDefault(command) && stateTag(command._state) !== 'Awaiting' && Date.now() < deadline) { await sleep(4); command = active(); }
      if (!command || !idleDefault(command)) break;
      executor.cancelActiveCommand();
      cancelled.push(nameOf(command));
      if (!(await untilIdle(Math.max(0, deadline - Date.now())))) break;
    }
    return cancelled;
  };
  return { stateTag, active, nameOf, isDefault, idleDefault, untilIdle, cancelIdleDefaults };
}`;

/** How long the guard waits for a default command to reach Awaiting, or to end after its cancel. */
export const SELECTION_GUARD_SETTLE_MS = 1_500;

/** While the wrapped source is pending, an idle default command is cancelled once it is seen on two checks this far apart. */
export const SELECTION_GUARD_WATCH_MS = 50;
/** The key of the envelope the guarded source returns: { [key]: report, value: <the source's own result> }. */
export const SELECTION_GUARD_KEY = "plasticityMcpSelectionGuard";

/** What the guard did in one mutate() call. */
export interface SelectionGuardReport {
  /** "guarded": selection saved, emptied and put back. "pass-through": the source ran as it would without the guard. */
  mode: "guarded" | "pass-through";
  /** Why the guard stood aside (another command was active, or this build lacks the selection API). */
  passThrough?: string;
  /** Default commands cancelled before the source ran, while it ran, and after it. */
  cancelledAtEntry: string[];
  cancelledWhileRunning: string[];
  cancelledAtExit: string[];
  /** Selection ids at entry, and how many are selected again (dropped: their entities are gone). */
  saved: number;
  restored: number;
  dropped: number;
  /** How the selection was put back: Plasticity's memento, one id at a time, or by adding the items again. */
  restoredBy?: "memento" | "per-id" | "items" | "nothing-to-restore" | "left" | "deferred";
  /** A failure inside the guard. The source's own result or error is never replaced by it. */
  problems: string[];
  /** Guard problems of an earlier call whose source threw, reported now. */
  earlierProblems?: string[];
}

// The guard itself: `this` is the editor, `run` starts the wrapped source. It returns { [SELECTION_GUARD_KEY]: report,
// value } and rethrows the source's own error; nothing it does itself can throw past it.
// It is not a nativeFunction source: the two things it needs from the document (the geometry model and the stable id
// of a body version) are read here for both editor layouts, which keeps the 16 KB nativeApi prelude out of every call.
export const SELECTION_GUARD_SOURCE = `async function (run) {
  const report = { mode: 'pass-through', cancelledAtEntry: [], cancelledWhileRunning: [], cancelledAtExit: [], saved: 0, restored: 0, dropped: 0, problems: [] };
  // Problems of an earlier call whose source threw (it had no envelope to carry them) are reported by this one.
  const pendingKey = Symbol.for('plasticity-mcp.selection-guard-problems');
  try { if (Array.isArray(globalThis[pendingKey])) { report.earlierProblems = globalThis[pendingKey]; delete globalThis[pendingKey]; } } catch {}
  const envelope = value => ({ ${SELECTION_GUARD_KEY}: report, value });
  const message = error => String(error?.message ?? error);
  const executor = this.executor;
  const selected = this.selection?.selected;
  if (!executor || !selected || typeof selected.saveToMemento !== 'function' || typeof selected.restoreFromMemento !== 'function' || typeof selected.removeAll !== 'function') {
    report.passThrough = 'this Plasticity build has no executor or selection memento';
    return envelope(await run());
  }
  const tools = (${EXECUTOR_TOOLS_SOURCE})(executor);
  // 26.1 keeps the model and the stable ids on editor.geo / editor.db; 26.2 on editor.geo.read / editor.geo (as nativeFunction's prelude).
  const legacy = !this.geo?.read?.geometryModel || !!this.geo.geometryModel;
  // Read anew every time: a history step replaces the geometry model object (measured live: Undo of a move).
  const geometry = () => legacy ? this.geo?.geometryModel : this.geo.read.geometryModel;
  const alive = version => typeof geometry()?.has === 'function' && geometry().has(version);
  const bodyOfStableId = stableId => {
    const model = geometry();
    if (!Number.isInteger(stableId) || typeof model?.[Symbol.iterator] !== 'function') return null;
    for (const [version, item] of model) if (stableOf(version) === stableId) return { version, view: item?.view, type: item?.view?.constructor?.name ?? null };
    return null;
  };
  const idsOf = memento => memento?.ids instanceof Map ? [...memento.ids.keys()].map(String) : Array.from(memento?.ids ?? [], String);
  const currentIds = () => idsOf(selected.saveToMemento());
  const count = () => typeof selected.size === 'number' ? selected.size : currentIds().length;
  const stableOf = version => { try { return legacy ? this.db.lookupStableId(version) : this.geo.lookupStableId(version); } catch { return undefined; } };
  const typeOf = version => geometry()?.get?.(version)?.view?.constructor?.name ?? null;
  let saved;
  // Whole bodies of the selection, by memento id: the stable id and the body type they had at entry.
  const bodies = new Map();
  // The selected items themselves, for the last fallback of restore().
  const items = [];
  try {
    saved = selected.saveToMemento();
    const savedIds = idsOf(saved);
    report.saved = savedIds.length;
    if (savedIds.length > 0) {
      const numeric = new Map();
      for (const id of savedIds) {
        const match = /^[^:]+:([0-9]+)$/.exec(id);
        if (match) numeric.set(Number(match[1]), [...(numeric.get(Number(match[1])) ?? []), id]);
      }
      for (const version of selected.itemIds ?? []) {
        const ids = numeric.get(Number(version));
        // One numeric id with this number: it is the body. Two (a body and a group with the same number) are left as they are.
        if (ids?.length === 1) bodies.set(ids[0], { stableId: stableOf(version), type: typeOf(version) });
      }
      try {
        for (const key of ['solids', 'sheets', 'curves']) for (const item of selected[key] ?? []) items.push({ item, body: { stableId: stableOf(item.versionId), type: item.constructor?.name ?? null } });
        for (const key of ['faces', 'edges', 'segments', 'regions', 'curveVertices', 'curveCVs', 'shellCVs', 'groups', 'empties', 'measurements', 'planes']) for (const item of selected[key] ?? []) items.push({ item });
      } catch { items.length = 0; }
    }
    if (executor.active) report.cancelledAtEntry = await tools.cancelIdleDefaults(${SELECTION_GUARD_SETTLE_MS});
    // Another command is active (the user's own, or a default command that is computing): change nothing.
    const other = tools.active();
    if (other) report.passThrough = tools.nameOf(other) + ' is active (state ' + String(tools.stateTag(other._state)) + ')';
    else {
      if (count() > 0) selected.removeAll();
      report.mode = 'guarded';
    }
  } catch (error) {
    report.problems.push('entry: ' + message(error));
    // The selection may already be empty: put it back before the source runs without the guard.
    if (saved !== undefined && report.mode !== 'guarded') { try { if (idsOf(saved).length > 0 && count() === 0) selected.restoreFromMemento(saved); } catch {} }
    if (report.mode !== 'guarded') saved = undefined;
  }
  const stash = problems => { try { globalThis[pendingKey] = [...(Array.isArray(globalThis[pendingKey]) ? globalThis[pendingKey] : []), ...problems].slice(-20); } catch {} };
  const currentId = id => {
    const split = id.indexOf(':');
    if (split < 0) return id;
    const rest = id.slice(split + 1);
    // Topology of a body version ("1f234", "4v330", "54c10"): it exists as long as that version does.
    const topology = /^([0-9]+)[A-Za-z]+[0-9]+$/.exec(rest);
    if (topology) return alive(Number(topology[1])) ? id : null;
    const body = bodies.get(id);
    if (!body || alive(Number(rest))) return id;
    // The edit replaced the body version: the same body (stable id, same type) stays selected.
    const now = bodyOfStableId(body.stableId);
    return now && now.type === body.type ? id.slice(0, split + 1) + now.version : null;
  };
  const mementoOf = ids => {
    const keep = new Set(ids);
    const memento = Object.create(Object.getPrototypeOf(saved));
    Object.assign(memento, saved, { ids: saved.ids instanceof Map ? new Map(ids.map(id => [id, saved.ids.get(id)])) : keep });
    const parents = saved.parentsWithSelectedChildren;
    if (parents && parents.counts instanceof Map && parents.values instanceof Map) {
      const copy = Object.create(Object.getPrototypeOf(parents));
      Object.assign(copy, parents, { counts: new Map(), values: new Map() });
      for (const [parent, children] of parents.values) {
        const rest = Array.from(children ?? []).filter(child => keep.has(String(child)));
        if (rest.length === 0) continue;
        copy.values.set(parent, children instanceof Set ? new Set(rest) : rest);
        copy.counts.set(parent, rest.length);
      }
      memento.parentsWithSelectedChildren = copy;
    }
    return memento;
  };
  // A stale id makes every typed getter of the selection throw, so a restored selection is read once before it is kept.
  const verify = () => {
    if (typeof selected.validate === 'function') selected.validate();
    for (const key of ['solids', 'sheets', 'faces', 'edges', 'segments', 'regions', 'curves', 'curveVertices', 'curveCVs', 'shellCVs', 'groups', 'empties', 'measurements', 'planes']) {
      const value = selected[key];
      if (value && typeof value[Symbol.iterator] === 'function') for (const item of value) void item;
    }
  };
  const sameIds = (left, right) => left.length === right.length && left.every(id => right.includes(id));
  // The item as it is now: the same object while its body version exists, the current view of a replaced whole body.
  const currentItem = entry => {
    const versionId = entry.item?.versionId;
    const version = Number((/^[0-9]+/.exec(String(versionId)) ?? [])[0]);
    if (!entry.body) return typeof versionId === 'string' && !alive(version) ? null : entry.item;
    if (alive(version)) return entry.item;
    const now = bodyOfStableId(entry.body.stableId);
    return now && now.type === entry.body.type ? now.view : null;
  };
  // Puts the saved selection back. Three ways, in order; the selection is left empty only when none of them works.
  const restore = () => {
    const ids = idsOf(saved);
    if (ids.length === 0) { if (count() > 0) selected.removeAll(); report.restoredBy = 'nothing-to-restore'; return; }
    const kept = ids.map(currentId).filter(id => id !== null);
    report.dropped = ids.length - kept.length;
    if (kept.length === 0) { if (count() > 0) selected.removeAll(); report.restoredBy = 'nothing-to-restore'; return; }
    const unchanged = kept.length === ids.length && kept.every((id, index) => id === ids[index]);
    // 1. Plasticity's own memento (one selectionChanged, the order kept).
    try {
      try { selected.restoreFromMemento(unchanged ? saved : mementoOf(kept)); }
      catch (error) {
        // A listener of selectionChanged can throw after the selection is already back.
        if (!sameIds(currentIds(), kept)) throw error;
        report.problems.push('restore: restoreFromMemento threw after the selection was put back: ' + message(error));
      }
      verify();
      report.restored = kept.length; report.restoredBy = 'memento';
      return;
    } catch (error) { report.problems.push('restore: the selection memento was not accepted: ' + message(error)); }
    // 2. An id of a kind the rule above does not know is stale: keep the ids Plasticity accepts one by one.
    try {
      const valid = [];
      for (const id of kept) { try { selected.restoreFromMemento(mementoOf([id])); verify(); valid.push(id); } catch {} }
      if (valid.length > 0) {
        selected.restoreFromMemento(mementoOf(valid)); verify();
        report.restored = valid.length; report.dropped = ids.length - valid.length; report.restoredBy = 'per-id';
        return;
      }
    } catch (error) { report.problems.push('restore: the ids were not accepted one by one: ' + message(error)); }
    // 3. Add the items again, as a selection tool does.
    let added = 0;
    try {
      selected.removeAll();
      for (const entry of items) {
        try { const item = currentItem(entry); if (item) { selected.add(item); added += 1; } } catch {}
      }
      verify();
    } catch (error) {
      report.problems.push('restore: adding the items again failed: ' + message(error));
      added = 0;
      try { selected.removeAll(); } catch {}
    }
    report.restored = added; report.dropped = ids.length - added; report.restoredBy = added > 0 ? 'items' : 'left';
    if (added === 0) report.problems.push('restore: the selection could not be put back and is empty (' + kept.length + ' of its ' + ids.length + ' items still exist)');
  };
  // While the source is pending, a default command that idles in Awaiting keeps an exec() of the source pending (a
  // selection made during the call, or a command of the user that ended between the entry check and the source's
  // exec()). It is cancelled once it has been seen idle on two checks.
  let seen = null;
  const watch = setInterval(() => {
    try {
      const command = tools.active();
      if (!command || !tools.idleDefault(command)) { seen = null; return; }
      if (seen !== command) { seen = command; return; }
      seen = null;
      executor.cancelActiveCommand();
      report.cancelledWhileRunning.push(tools.nameOf(command));
    } catch (error) { if (report.problems.length < 10) report.problems.push('watch: ' + message(error)); }
  }, ${SELECTION_GUARD_WATCH_MS});
  let returned = false;
  try {
    const value = await run();
    returned = true;
    return envelope(value);
  } finally {
    clearInterval(watch);
    if (saved !== undefined && report.mode === 'guarded') {
      try {
        if (executor.active) report.cancelledAtExit = await tools.cancelIdleDefaults(${SELECTION_GUARD_SETTLE_MS});
        // A command that is not an idle default command is still active (a pick command left to finish): the selection is its own.
        if (executor.active && !tools.isDefault(tools.active())) await tools.untilIdle(250);
        if (!executor.active) restore();
        else {
          // The selection is put back when that command has ended (watched for 15 s), unless something is selected by then.
          report.restoredBy = 'deferred';
          report.problems.push('exit: ' + tools.nameOf(tools.active()) + ' is still active; the selection is put back when it ends');
          const until = Date.now() + 15000;
          const later = setInterval(() => {
            try {
              if (executor.active) { if (Date.now() > until) { clearInterval(later); stash(['exit: the command was still active after 15 s; the selection was not put back']); } return; }
              clearInterval(later);
              const known = report.problems.length;
              if (count() === 0) restore();
              if (report.problems.length > known) stash(report.problems.slice(known));
            } catch (error) { clearInterval(later); stash(['exit: ' + message(error)]); }
          }, 100);
        }
      } catch (error) { report.problems.push('exit: ' + message(error)); }
    } else if (saved !== undefined) {
      // Pass-through: exec() interrupted the other command, which sends the selection back to that of the last history
      // step. When that left nothing selected and nothing is active, the saved selection is put back; otherwise the
      // selection is Plasticity's own (the chain of the first exec() may show its gizmo again) and is left alone.
      try {
        if (!executor.active && count() === 0 && idsOf(saved).length > 0) restore();
        else report.restoredBy = 'left';
      } catch (error) { report.problems.push('exit: ' + message(error)); }
    }
    // A source that throws has no envelope: its guard problems wait for the next guarded call or reconcile().
    if (!returned && report.problems.length > 0) stash(report.problems);
  }
}`;

/** Wraps a mutate() source so that it runs inside the selection guard. The wrapped source keeps its `this` and arguments. */
export function selectionSafeSource(functionDeclaration: string): string {
  return `async function (...mcpArguments) {
  const mcpSource = (
${functionDeclaration}
  );
  return await (${SELECTION_GUARD_SOURCE}).call(this, () => mcpSource.apply(this, mcpArguments));
}`;
}

/** What reconcile() found in the executor and did about it. */
export interface ReconcileRecovery {
  /** The idle default command(s) that a timed-out call left awaiting input, and that reconcile cancelled. */
  cancelledDefaultCommands?: string[];
  /** A command that is still active after reconcile; it was not touched. */
  activeCommand?: { name: string; state: string | null; default: boolean };
  note: string;
}

// The recovery step of reconcile(): cancels a default command that idles in Awaiting (what a timed-out call leaves
// behind when the chain described above ran), and reports any other active command without touching it. It leaves the
// selection as Plasticity keeps it and never undoes or repeats an edit.
export const DEFAULT_COMMAND_RECOVERY_SOURCE = `async function () {
  const pendingKey = Symbol.for('plasticity-mcp.selection-guard-problems');
  let problems = [];
  try { if (Array.isArray(globalThis[pendingKey])) { problems = globalThis[pendingKey]; delete globalThis[pendingKey]; } } catch {}
  const executor = this.executor;
  if (!executor || !executor.active) return problems.length > 0 ? { cancelled: [], active: null, problems } : null;
  const tools = (${EXECUTOR_TOOLS_SOURCE})(executor);
  const cancelled = await tools.cancelIdleDefaults(${SELECTION_GUARD_SETTLE_MS});
  const command = tools.active();
  return {
    cancelled,
    active: command ? { name: tools.nameOf(command), state: tools.stateTag(command._state), default: tools.isDefault(command) } : null,
    problems,
  };
}`;

export function mutationOutcomeIsUncertain(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /^(?:CDP request timed out:|CDP connection (?:is closed|closed before the request completed))/i.test(error.message);
}

// readRevisionProbe(): the parts of a state read that a cached state must match to be reused.
export interface RevisionProbe {
  documentToken: string;
  revision: string;
  viewStateToken: string;
  activePlaneId: string | null;
  bodyNames: Array<[number, string | null]>;
  regions: RuntimeState["regions"];
}

export interface RuntimeState {
  targetId: string;
  title: string;
  documentToken: string;
  revision: string;
  dbVersion: number | null;
  undoDepth: number;
  redoDepth: number;
  materials?: Array<{
    id: number;
    name: string;
    colorHex: string | null;
    roughness: number | null;
    metalness: number | null;
    opacity: number | null;
  }>;
  measurements?: Array<{
    id: number;
    versionId: number;
    type: string;
    name: string | null;
    measurementSource: "native-brep";
    first: { bodyId: number | null; topologyId: number; landmark: number; topologyType?: "vertex" | "edge" | "face" | null; topologyRefId?: number | string | null; positionMm: [number, number, number] | null } | null;
    second: { bodyId: number | null; topologyId: number; landmark: number; topologyType?: "vertex" | "edge" | "face" | null; topologyRefId?: number | string | null; positionMm: [number, number, number] | null } | null;
    distanceMm: number | null;
    direction: [number, number, number] | null;
    normal: [number, number, number] | null;
    offsetMm: number[];
    radiusMm?: number | null;
    diameterMm?: number | null;
  }>;
  sectionAnalyses?: Array<{
    id: number;
    versionId: number;
    name: string | null;
    originMm: [number, number, number];
    normal: [number, number, number];
    visible: boolean;
    registeredViewportCount: number;
  }>;
  instances?: Array<{
    id: number;
    type: "Instance";
    targetKey: number;
    targetName: string | null;
    sourceBodyIds: number[];
    translationMm: [number, number, number];
    rotationQuaternion: [number, number, number, number];
    scale: [number, number, number];
    matrixWorldMm: number[];
    visible: boolean;
    hidden: boolean;
    locked: boolean;
  }>;
  referenceMeshes?: Array<{
    id: number;
    type: "ReferenceMesh";
    name: string | null;
    sourcePath: string;
    sourceFormat: "stl" | "obj" | "3mf" | "unknown";
    measurementSource: "reference-mesh";
    boundsMm: { min: [number, number, number]; max: [number, number, number] } | null;
    translationMm: [number, number, number];
    rotationQuaternion: [number, number, number, number];
    sceneScaleToMeters: [number, number, number];
    vertexEntries: number;
    triangles: number;
    visible: boolean;
    hidden: boolean;
    locked: boolean;
  }>;
  activeGroupId?: number;
  groups?: Array<{
    id: number;
    name: string | null;
    parentId: number | null;
    childGroupIds: number[];
    bodyIds: number[];
    instanceIds: number[];
    referenceMeshIds: number[];
    otherNodeKeys: number[];
    visible: boolean;
    hidden: boolean;
    locked: boolean;
  }>;
  construction: {
    planes: ConstructionPlaneDescriptor[];
    activePlaneId: string | null;
    planeStateToken: string;
    viewStateToken: string;
  };
  regions: Array<{
    id: string;
    entityId: number;
    islandVersionId: number;
    sketchId: number;
    sketchWireIds: number[];
    measurementSource: "render-mesh";
    displayBoundsMm: { min: [number, number, number]; max: [number, number, number] };
  }>;
  bodies: Array<{
    id: number;
    versionId: number;
    type: string;
    name: string | null;
    materialId?: number;
    visible?: boolean;
    hidden?: boolean;
    locked?: boolean;
    boundsMm: { min: [number, number, number]; max: [number, number, number] } | null;
    boundsMethod?: "native-box" | "native-extrema";
    faceIds: string[];
    edgeIds: string[];
    faces: Array<{
      id: string;
      surfaceType: string;
      planar: boolean;
      centerMm: [number, number, number];
      normal: [number, number, number];
      radiusMm: number | null;
      blendRadiusMm: number | null;
      axisOriginMm: [number, number, number] | null;
      axisDirection: [number, number, number] | null;
      coneBasisRadiusMm?: number;
      coneSemiAngleRad?: number;
      boundsMm: { min: [number, number, number]; max: [number, number, number] };
      edgeIds: string[];
    }>;
    edges: Array<{
      id: string;
      curveType: string;
      line: boolean;
      circle: boolean;
      lengthMm: number;
      centerMm: [number, number, number];
      tangent: [number, number, number];
      boundsMm: { min: [number, number, number]; max: [number, number, number] };
      faceIds: string[];
      vertexIds: number[];
      circleGeometry?: {
        centerMm: [number, number, number];
        radiusMm: number;
        normal: [number, number, number];
        reference: [number, number, number];
        startMm: [number, number, number];
        midpointMm: [number, number, number];
        endMm: [number, number, number];
      };
    }>;
    vertices?: Array<{
      id: number;
      positionMm: [number, number, number];
      edgeIds: string[];
      faceIds: string[];
    }>;
  }>;
}

export class PlasticityRuntime {
  private client: CdpClient;
  private readonly target: PlasticityTarget;
  private editorId: string;
  private readonly bindings = new Map<string, string>();
  private operationTail: Promise<void> = Promise.resolve();
  private uncertain = false;
  // Counts mutate() calls, bumped before each one starts. A state read taken at one count is known to predate no
  // mutation of this process while the count is unchanged (the batch state reuse in PlasticityOperations).
  private mutations = 0;
  private lastGuard: SelectionGuardReport | undefined;
  private guardLog: (line: string) => void = (line) => { process.stderr.write(`${line}\n`); };
  private readonly connectClient: (url: string) => Promise<CdpClient>;

  private constructor(client: CdpClient, target: PlasticityTarget, editorId: string, connectClient = CdpClient.connect) {
    this.client = client;
    this.target = target;
    this.editorId = editorId;
    this.connectClient = connectClient;
  }

  static async connect(target: PlasticityTarget): Promise<PlasticityRuntime> {
    const client = await CdpClient.connect(target.webSocketDebuggerUrl);
    const runtime = new PlasticityRuntime(client, target, "", CdpClient.connect);
    try {
      await client.send("Runtime.enable");
      await runtime.refreshNativeReferences();
      return runtime;
    } catch (error) {
      runtime.close();
      throw error;
    }
  }

  getCapabilities(): string[] {
    return [...this.bindings.keys()].sort();
  }

  isUncertain(): boolean {
    return this.uncertain;
  }

  markUncertain(): void {
    this.uncertain = true;
  }

  async reconnect(): Promise<void> {
    await this.enqueue(async () => {
      if (this.uncertain) throw new Error("Previous mutation outcome is uncertain; reconcile before reconnecting");
      const replacement = await this.connectClient(this.target.webSocketDebuggerUrl);
      const previousClient = this.client;
      const previousEditorId = this.editorId;
      const previousBindings = new Map(this.bindings);
      try {
        await replacement.send("Runtime.enable");
        this.client = replacement;
        this.editorId = "";
        this.bindings.clear();
        await this.refreshNativeReferences();
        previousClient.close();
      } catch (error) {
        if (this.client === replacement) {
          this.client = previousClient;
          this.editorId = previousEditorId;
          this.bindings.clear();
          for (const [name, objectId] of previousBindings) this.bindings.set(name, objectId);
        }
        replacement.close();
        throw error;
      }
    });
  }

  async read<T>(functionDeclaration: string, values: unknown[] = [], timeoutMs?: number): Promise<T> {
    return await this.enqueue(() => this.call<T>(functionDeclaration, [], values, timeoutMs));
  }

  async readNative<T>(
    functionDeclaration: string,
    bindingNames: string[],
    values: unknown[] = [],
    timeoutMs?: number,
  ): Promise<T> {
    return await this.enqueue(() => this.call<T>(functionDeclaration, bindingNames, values, timeoutMs));
  }

  async mutate<T>(
    functionDeclaration: string,
    bindingNames: string[],
    values: unknown[] = [],
    timeoutMs?: number,
    // selectionGuard false: only for a source that runs no command (selection-safe-sites.test.ts checks every such site).
    options: { selectionGuard?: boolean } = {},
  ): Promise<T> {
    this.mutations += 1;
    return await this.enqueue(async () => {
      if (this.uncertain) throw new Error("Previous mutation outcome is uncertain; call reconcile before another mutation");
      try {
        // Every command the server runs goes through here, inside the selection guard (see SELECTION_GUARD_SOURCE).
        if (options.selectionGuard === false) return await this.call<T>(functionDeclaration, bindingNames, values, timeoutMs);
        return this.unwrapGuarded<T>(await this.call<unknown>(selectionSafeSource(functionDeclaration), bindingNames, values, timeoutMs));
      } catch (error) {
        if (mutationOutcomeIsUncertain(error)) this.uncertain = true;
        throw error;
      }
    });
  }

  /** What the selection guard did in the last mutate() that returned (undefined before the first one). */
  selectionGuardReport(): SelectionGuardReport | undefined {
    return this.lastGuard;
  }

  /** Where guard problems are written (one line each); the default is the server's stderr. */
  setSelectionGuardLog(log: (line: string) => void): void {
    this.guardLog = log;
  }

  // The guarded source returns { [SELECTION_GUARD_KEY]: report, value }. A problem inside the guard (a selection that
  // could not be put back) never replaces the source's result: it is logged, and the result is returned as it is.
  private unwrapGuarded<T>(raw: unknown): T {
    if (raw === null || typeof raw !== "object" || !(SELECTION_GUARD_KEY in raw)) return raw as T;
    const envelope = raw as { [SELECTION_GUARD_KEY]?: SelectionGuardReport; value?: unknown };
    const report = envelope[SELECTION_GUARD_KEY];
    if (report && typeof report === "object") {
      this.lastGuard = report;
      this.logGuardProblems([...(report.earlierProblems ?? []), ...(report.problems ?? [])]);
    }
    return envelope.value as T;
  }

  private logGuardProblems(problems: readonly unknown[]): void {
    for (const problem of problems) {
      try { this.guardLog(`[plasticity-mcp] selection guard: ${String(problem)}`); } catch { /* a failing log never fails the call */ }
    }
  }

  // Reads the document after a timeout or disconnect and allows later mutations. Before the read it clears the one
  // leftover that is known to be harmless: a default command idling in Awaiting (the gizmo of the selection), which
  // keeps a timed-out exec() pending. Nothing is undone or repeated; any other active command is reported, not touched.
  async reconcile(timeoutMs = NATIVE_STATE_READ_TIMEOUT_MS): Promise<RuntimeState & { recovery?: ReconcileRecovery }> {
    const recovery = await this.recoverIdleDefaultCommand();
    const state = await this.getState(timeoutMs);
    this.uncertain = false;
    return recovery ? { ...state, recovery } : state;
  }

  private async recoverIdleDefaultCommand(): Promise<ReconcileRecovery | undefined> {
    let found: { cancelled?: unknown; active?: { name?: unknown; state?: unknown; default?: unknown } | null; problems?: unknown } | null;
    try {
      found = await this.read<typeof found>(DEFAULT_COMMAND_RECOVERY_SOURCE, [], 10_000);
    } catch (error) {
      // A closed or timed-out connection fails the state read that follows as well; anything else must not block it.
      if (mutationOutcomeIsUncertain(error)) throw error;
      return undefined;
    }
    if (!found || typeof found !== "object") return undefined;
    if (Array.isArray(found.problems)) this.logGuardProblems(found.problems);
    const cancelled = Array.isArray(found.cancelled) ? found.cancelled.map(String) : [];
    const active = found.active && typeof found.active === "object"
      ? { name: String(found.active.name), state: found.active.state === null || found.active.state === undefined ? null : String(found.active.state), default: found.active.default === true }
      : undefined;
    if (cancelled.length === 0 && !active) return undefined;
    const notes: string[] = [];
    if (cancelled.length > 0) notes.push(`Cancelled ${cancelled.join(", ")}: an idle default command for the current selection (its gizmo) that was left awaiting input. No edit was undone or repeated, and the selection was kept.`);
    if (active) notes.push(`${active.name} is still active (state ${active.state ?? "unknown"}) and was not touched; finish or cancel it in Plasticity before the next edit.`);
    return { ...(cancelled.length > 0 ? { cancelledDefaultCommands: cancelled } : {}), ...(active ? { activeCommand: active } : {}), note: notes.join(" ") };
  }

  mutationCount(): number {
    return this.mutations;
  }

  async getState(timeoutMs = NATIVE_STATE_READ_TIMEOUT_MS): Promise<RuntimeState> {
    const result = await this.readStateNative<Omit<RuntimeState, "targetId" | "title">>(timeoutMs, []);
    return { targetId: this.target.id, title: this.target.title, ...result };
  }

  // The same native read as getState, but it sends back only what tells two reads apart: the revision (which hashes
  // the document, db version, undo/redo depth, body versions and flags, planes, materials, measurements, instances,
  // reference meshes, sections and groups) plus the state fields the revision does not hash (active workplane, body
  // names, regions). No topology crosses the wire, so it costs a fraction of a full read.
  async readRevisionProbe(timeoutMs = NATIVE_STATE_READ_TIMEOUT_MS): Promise<RevisionProbe> {
    return await this.readStateNative<RevisionProbe>(timeoutMs, [{ probe: true }]);
  }

  private async readStateNative<T>(timeoutMs: number, values: unknown[]): Promise<T> {
    return await this.readNative<T>(nativeFunction`function (ConstructionPlaneDatabase, Vector, Quaternion, pk_default, options) {
      const mm = value => value * 1000;
      const vector = value => [mm(value.x), mm(value.y), mm(value.z)];
      const direction = value => [value.x, value.y, value.z];
      const stableNumber = value => (Object.is(value, -0) ? 0 : value).toPrecision(12);
      const token = value => {
        let hash = 14695981039346656037n;
        for (let index = 0; index < value.length; index += 1) {
          hash ^= BigInt(value.charCodeAt(index));
          hash = BigInt.asUintN(64, hash * 1099511628211n);
        }
        return hash.toString(16).padStart(16, '0');
      };
      const planeDescriptor = (id, nativeId, source, plane) => ({
        id,
        nativeId: String(nativeId),
        name: String(plane.name ?? id),
        source,
        originMm: vector(plane.p),
        normal: direction(plane.n),
        xDirection: direction(plane.x),
        yDirection: direction(plane.y),
      });
      const standardPlaneEntries = [
        ['top', 'Top'],
        ['bottom', 'Bottom'],
        ['left', 'Left'],
        ['right', 'Right'],
        ['front', 'Front'],
        ['back', 'Back'],
      ];
      const planeRecords = standardPlaneEntries.map(([id, key]) => ({
        object: ConstructionPlaneDatabase[key],
        descriptor: planeDescriptor('standard:' + id, key, 'standard', ConstructionPlaneDatabase[key]),
      }));
      const savedSnapshot = this.planes.snapshot();
      const savedIdEntries = savedSnapshot.ids instanceof Map
        ? Array.from(savedSnapshot.ids)
        : Object.entries(savedSnapshot.ids ?? {});
      const savedIds = savedIdEntries.map(([index, nativeId]) => [String(nativeId), Number(index)]);
      for (const [nativeId, index] of savedIds) {
        const plane = savedSnapshot.planes?.[index];
        if (plane) planeRecords.push({
          object: plane,
          descriptor: planeDescriptor('plane:' + nativeId, nativeId, 'saved', plane),
        });
      }
      const planes = planeRecords
        .map(record => record.descriptor)
        .sort((left, right) => (left.source + ':' + left.nativeId).localeCompare(right.source + ':' + right.nativeId));
      const planeStateToken = 'planes:' + token(JSON.stringify(planes.map(plane => [
        plane.id,
        plane.nativeId,
        plane.name,
        plane.source,
        ...plane.originMm.map(stableNumber),
        ...plane.normal.map(stableNumber),
        ...plane.xDirection.map(stableNumber),
        ...plane.yDirection.map(stableNumber),
      ])));
      const viewport = Array.from(this.viewports)[0];
      const active = viewport?.constructionPlane;
      const frameEqual = (left, right) => ['p', 'n', 'x', 'y'].every(key =>
        left?.[key] && right?.[key] && left[key].distanceToSquared(right[key]) <= 1e-24
      );
      const activeRecord = active
        ? (planeRecords.find(record => record.object === active) ?? planeRecords.find(record => frameEqual(record.object, active)))
        : undefined;
      const activePlaneId = activeRecord?.descriptor.id ?? null;
      const activeFrameToken = active
        ? [vector(active.p), direction(active.n), direction(active.x), direction(active.y)].flat().map(stableNumber).join(',')
        : 'none';
      const viewStateToken = ['workplane', activePlaneId ?? 'unregistered', activeFrameToken].join(':');
      // Plasticity's kernel binding never frees the native side of topology
      // wrappers (faces, edges, vertices, collections), even after GC, so
      // every walk of a large document's topology costs hundreds of MB. A
      // body version's topology is immutable: read it once per body view
      // and versionId and reuse it across state reads.
      // Invalidate descriptors from an older adapter even when the body view is unchanged.
      const topologyFormat = 3;
      const readBodyBounds = (${NATIVE_BODY_BOUNDS})(pk_default.a);
      const topologyCacheKey = Symbol.for('plasticity-mcp.body-topology');
      const topologyCache = globalThis[topologyCacheKey] ?? (globalThis[topologyCacheKey] = new WeakMap());
      const readTopology = (item, bodyType) => {
        const isBrepShell = bodyType === 'Solid' || bodyType === 'Sheet';
        const isWire = bodyType === 'Wire';
        let box = null;
        let boundsMethod = 'native-box';
        if (isWire) {
          try { box = item.model.FindBox(); } catch {}
        } else {
          const measured = readBodyBounds(item.model, bodyType);
          box = measured.box; boundsMethod = measured.method;
        }
        // Wire B-curve segments have their own segmentEntityId API. Some
        // Plasticity rebuild results expose transient high-edge views that are
        // not shell B-Rep topology and can make getBoundingBox throw
        // PK_ERROR_not_an_entity. Only Solid/Sheet topology belongs here.
        const faceViews = isBrepShell ? item.view?.high?.faces : null;
        const edgeViews = isBrepShell ? item.view?.high?.edges : null;
        const faceIdByEntity = new Map();
        const edgeIdByEntity = new Map();
        for (let index = 0; index < (faceViews?.versionIds?.length ?? 0); index += 1) {
          const view = faceViews.get(index);
          if (view) faceIdByEntity.set(view.entityId, String(faceViews.versionIds[index]));
        }
        for (let index = 0; index < (edgeViews?.versionIds?.length ?? 0); index += 1) {
          const view = edgeViews.get(index);
          if (view) edgeIdByEntity.set(view.entityId, String(edgeViews.versionIds[index]));
        }
        const modelFaces = isBrepShell ? item.model?.GetFaces?.() : null;
        const faces = [];
        for (let index = 0; index < (modelFaces?.Size?.() ?? 0); index += 1) {
          const face = modelFaces.Get(index);
          const id = faceIdByEntity.get(face.Id());
          if (!id) continue;
          const midpoint = face.FindMidpoint();
          const surface = face.GetSurface();
          if (!faceViews) continue;
          const viewIndex = faceViews.versionIds.indexOf(id);
          const faceView = viewIndex >= 0 ? faceViews.get(viewIndex) : null;
          if (!faceView) continue;
          const faceBox = faceView.getBoundingBox();
          const faceEdges = face.GetEdges();
          const adjacentEdgeIds = [];
          for (let edgeIndex = 0; edgeIndex < faceEdges.Size(); edgeIndex += 1) {
            const adjacentId = edgeIdByEntity.get(faceEdges.Get(edgeIndex).Id());
            if (adjacentId) adjacentEdgeIds.push(adjacentId);
          }
          const radius = face.GetRadius();
          const blendRadius = face.GetBlendRadius();
          const surfaceType = surface.surface?.constructor?.name ?? 'Unknown';
          let axisOriginMm = null;
          let axisDirection = null;
          let coneBasisRadiusMm = null;
          let coneSemiAngleRad = null;
          if (surfaceType === 'Cylinder' || surfaceType === 'Cone') {
            const info = surface.surface.GetInfo?.();
            const basis = info?.basis;
            if (basis?.Location && basis?.Axis) {
              axisOriginMm = vector(basis.Location);
              axisDirection = direction(basis.Axis);
            }
            if (surfaceType === 'Cone' && Number.isFinite(info?.semiAngle)) {
              coneSemiAngleRad = info.semiAngle;
            }
            if (surfaceType === 'Cone' && Number.isFinite(info?.radius) && info.radius > 0) {
              coneBasisRadiusMm = mm(info.radius);
            }
          }
          faces.push({
            id,
            surfaceType,
            planar: face.IsPlanar(),
            centerMm: vector(midpoint.position),
            normal: direction(midpoint.normal),
            radiusMm: Number.isFinite(radius) && radius > 0 ? mm(radius) : null,
            blendRadiusMm: Number.isFinite(blendRadius) && blendRadius >= 0 ? mm(blendRadius) : null,
            axisOriginMm,
            axisDirection,
            ...(coneBasisRadiusMm === null ? {} : { coneBasisRadiusMm }),
            ...(coneSemiAngleRad === null ? {} : { coneSemiAngleRad }),
            boundsMm: { min: vector(faceBox.min), max: vector(faceBox.max) },
            edgeIds: adjacentEdgeIds,
          });
        }
        const modelEdges = isBrepShell ? item.model?.GetEdges?.() : null;
        const edges = [];
        const verticesById = new Map();
        for (let index = 0; index < (modelEdges?.Size?.() ?? 0); index += 1) {
          const edge = modelEdges.Get(index);
          const id = edgeIdByEntity.get(edge.Id());
          if (!id) continue;
          const midpoint = edge.GetPointAndTangent(0.5);
          const length = edge.FindLength();
          const curve = edge.GetCurve();
          const nativeCurve = curve?.curve ?? curve;
          let circleGeometry = null;
          if (edge.IsCircle()) {
            const info = nativeCurve?.GetInfo?.();
            const basis = info?.basis;
            const location = basis?.Location;
            const axis = basis?.Axis;
            const reference = basis?.Ref;
            if (location && axis && reference && Number.isFinite(info?.radius) && info.radius > 0) {
              const start = edge.GetPointAndTangent(0).position;
              const end = edge.GetPointAndTangent(1).position;
              circleGeometry = {
                centerMm: vector(location),
                radiusMm: mm(info.radius),
                normal: direction(axis),
                reference: direction(reference),
                startMm: vector(start),
                midpointMm: vector(midpoint.position),
                endMm: vector(end),
              };
            }
          }
          if (!edgeViews) continue;
          const viewIndex = edgeViews.versionIds.indexOf(id);
          const edgeView = viewIndex >= 0 ? edgeViews.get(viewIndex) : null;
          if (!edgeView) continue;
          const edgeBox = edgeView.getBoundingBox();
          const adjacentFaces = edge.GetFaces();
          const adjacentFaceIds = [];
          for (let faceIndex = 0; faceIndex < adjacentFaces.Size(); faceIndex += 1) {
            const adjacentId = faceIdByEntity.get(adjacentFaces.Get(faceIndex).Id());
            if (adjacentId) adjacentFaceIds.push(adjacentId);
          }
          const vertices = edge.GetVertices();
          for (const vertex of [vertices.left, vertices.right]) {
            const vertexId = vertex?.Id?.();
            if (!Number.isInteger(vertexId) || verticesById.has(vertexId)) continue;
            const vertexEdges = vertex.GetEdges?.();
            const adjacentVertexEdgeIds = [];
            for (const collection of vertexEdges?.in && vertexEdges?.out ? [vertexEdges.in, vertexEdges.out] : [vertexEdges]) {
              for (let edgeIndex = 0; edgeIndex < (collection?.Size?.() ?? 0); edgeIndex += 1) {
                const adjacentId = edgeIdByEntity.get(collection.Get(edgeIndex).Id());
                if (adjacentId && !adjacentVertexEdgeIds.includes(adjacentId)) adjacentVertexEdgeIds.push(adjacentId);
              }
            }
            const vertexFaces = vertex.GetFaces?.();
            const adjacentVertexFaceIds = [];
            for (let faceIndex = 0; faceIndex < (vertexFaces?.Size?.() ?? 0); faceIndex += 1) {
              const adjacentId = faceIdByEntity.get(vertexFaces.Get(faceIndex).Id());
              if (adjacentId) adjacentVertexFaceIds.push(adjacentId);
            }
            verticesById.set(vertexId, {
              id: vertexId,
              positionMm: vector(vertex.GetPoint()),
              edgeIds: adjacentVertexEdgeIds.sort(),
              faceIds: adjacentVertexFaceIds.sort(),
            });
          }
          edges.push({
            id,
            curveType: curve.curve?.constructor?.name ?? 'Unknown',
            line: edge.IsLine(),
            circle: edge.IsCircle(),
            lengthMm: mm(length.length),
            centerMm: vector(midpoint.position),
            tangent: direction(midpoint.tangent),
            boundsMm: { min: vector(edgeBox.min), max: vector(edgeBox.max) },
            faceIds: adjacentFaceIds,
            vertexIds: [vertices.left?.Id?.(), vertices.right?.Id?.()].filter(Number.isInteger),
            ...(circleGeometry === null ? {} : { circleGeometry }),
          });
        }
        const faceIds = Array.from(faceViews?.versionIds ?? []).map(String);
        const edgeIds = Array.from(edgeViews?.versionIds ?? []).map(String);
        return {
          boundsMm: box ? { min: vector(box.min), max: vector(box.max) } : null,
          boundsMethod,
          faceIds,
          edgeIds,
          faces,
          edges,
          vertices: Array.from(verticesById.values()).sort((left, right) => left.id - right.id),
        };
      };
      const bodies = [...nativeApi.geo.geometryModel].map(([versionId, item]) => {
        const bodyType = item.view?.constructor?.name ?? 'Unknown';
        const view = item.view !== null && typeof item.view === 'object' ? item.view : null;
        const cached = view ? topologyCache.get(view) : undefined;
        let topology = cached?.format === topologyFormat && cached.versionId === versionId ? cached.topology : null;
        if (!topology) {
          topology = readTopology(item, bodyType);
          if (view) topologyCache.set(view, { format: topologyFormat, versionId, topology });
        }
        const key = nativeApi.db.nodes?.item2key?.(item.view);
        const name = key === undefined ? null : (nativeApi.db.nodes?.getName?.(key) ?? null);
        const materialId = key === undefined ? 0 : (nativeApi.db.nodes?.getMaterialId?.(key) ?? 0);
        return {
          id: nativeApi.db.lookupStableId(versionId),
          versionId,
          type: bodyType,
          name,
          materialId,
          visible: key === undefined ? true : Boolean(nativeApi.db.nodes?.isVisible?.(key)),
          hidden: key === undefined ? false : Boolean(nativeApi.db.nodes?.isHidden?.(key)),
          locked: key === undefined ? false : Boolean(nativeApi.db.nodes?.isLocked?.(key)),
          ...topology,
        };
      }).filter(item => Number.isInteger(item.id));
      const materials = this.materials.list().map(entry => {
        // 26.1 returns [id, info] pairs; 26.2 returns material-info objects.
        const [id, info] = Array.isArray(entry) ? entry : [entry?.id, entry];
        if ((typeof id !== 'number' && typeof id !== 'string') ||
            (typeof id === 'string' && !id.trim()) || !Number.isInteger(Number(id)) ||
            !info || typeof info !== 'object') {
          throw new Error('Unsupported native appearance material entry');
        }
        const material = this.materials.get(id);
        return {
          id: Number(id),
          name: String(info.name ?? ''),
          colorHex: typeof material.color?.getHexString === 'function' ? '#' + material.color.getHexString() : null,
          roughness: Number.isFinite(material.roughness) ? Number(material.roughness) : null,
          metalness: Number.isFinite(material.metalness) ? Number(material.metalness) : null,
          opacity: Number.isFinite(material.opacity) ? Number(material.opacity) : null,
        };
      }).filter(material => Number.isInteger(material.id)).sort((left, right) => left.id - right.id);
      const measurementTarget = target => {
        if (!target) return null;
        let bodyId = null;
        let topologyType = null;
        let topologyRefId = null;
        let positionMm = null;
        let radiusMm = null;
        for (const [versionId, item] of nativeApi.geo.geometryModel) {
          if (item.model?.Id?.() !== target.bodyId) continue;
          const stableId = nativeApi.db.lookupStableId(versionId);
          bodyId = Number.isInteger(stableId) ? stableId : null;
          try {
            const vertices = item.model.GetVertices?.();
            for (let index = 0; index < (vertices?.Size?.() ?? 0); index += 1) {
              const vertex = vertices.Get(index);
              if (vertex?.Id?.() !== target.topologyId) continue;
              positionMm = vector(vertex.GetPoint());
              topologyType = 'vertex';
              topologyRefId = Number(vertex.Id());
              break;
            }
          } catch {}
          if (!positionMm) try {
            const edges = item.model.GetEdges?.();
            for (let index = 0; index < (edges?.Size?.() ?? 0); index += 1) {
              const edge = edges.Get(index);
              if (edge?.Id?.() !== target.topologyId) continue;
              positionMm = vector(edge.GetPointAndTangent(0.5).position);
              topologyType = 'edge';
              const edgeViews = item.view?.high?.edges;
              const edgeViewIndex = Array.from({ length: edgeViews?.versionIds?.length ?? 0 }, (_, viewIndex) => viewIndex)
                .find(viewIndex => Number(edgeViews.get(viewIndex)?.entityId) === Number(target.topologyId));
              topologyRefId = edgeViewIndex === undefined ? null : String(edgeViews.versionIds[edgeViewIndex]);
              const circleRadius = edge.IsCircle?.() ? Number(edge.GetCurve?.()?.curve?.GetInfo?.()?.radius) : NaN;
              radiusMm = Number.isFinite(circleRadius) && circleRadius > 0 ? mm(circleRadius) : null;
              break;
            }
          } catch {}
          if (!positionMm) try {
            const faces = item.model.GetFaces?.();
            for (let index = 0; index < (faces?.Size?.() ?? 0); index += 1) {
              const face = faces.Get(index);
              if (face?.Id?.() !== target.topologyId) continue;
              positionMm = vector(face.FindMidpoint().position);
              topologyType = 'face';
              const faceViews = item.view?.high?.faces;
              const faceViewIndex = Array.from({ length: faceViews?.versionIds?.length ?? 0 }, (_, viewIndex) => viewIndex)
                .find(viewIndex => Number(faceViews.get(viewIndex)?.entityId) === Number(target.topologyId));
              topologyRefId = faceViewIndex === undefined ? null : String(faceViews.versionIds[faceViewIndex]);
              break;
            }
          } catch {}
          break;
        }
        return {
          descriptor: { bodyId, topologyId: Number(target.topologyId), landmark: Number(target.landmark), topologyType, topologyRefId, positionMm },
          radiusMm,
        };
      };
      const measurementSnapshot = this.measurements.snapshot();
      const measurements = Array.from(measurementSnapshot.repo?.measurements ?? []).map(measurement => {
        const firstTarget = measurementTarget(measurement.target1 ?? measurement.target);
        const secondTarget = measurementTarget(measurement.target2);
        const first = firstTarget?.descriptor ?? null;
        const second = secondTarget?.descriptor ?? null;
        const distanceMm = first?.positionMm && second?.positionMm
          ? Math.hypot(
            second.positionMm[0] - first.positionMm[0],
            second.positionMm[1] - first.positionMm[1],
            second.positionMm[2] - first.positionMm[2],
          )
          : null;
        const radial = measurement.constructor?.name === 'RadialMeasurement';
        const offsetMm = radial ? [] : ['x', 'y', 'z']
          .map(key => measurement.offset?.[key])
          .filter(Number.isFinite)
          .map(mm);
        return {
          id: Number(this.measurements.lookupStableId(measurement.versionId)),
          versionId: Number(measurement.versionId),
          type: String(measurement.constructor?.name ?? 'Measurement'),
          name: typeof measurement.userData?.name === 'string' ? measurement.userData.name : null,
          measurementSource: 'native-brep',
          first,
          second,
          distanceMm,
          direction: measurement.direction ? direction(measurement.direction) : null,
          normal: measurement.normal ? direction(measurement.normal) : null,
          offsetMm,
          ...(radial ? {
            radiusMm: firstTarget?.radiusMm ?? null,
            diameterMm: Number.isFinite(firstTarget?.radiusMm) ? firstTarget.radiusMm * 2 : null,
          } : {}),
        };
      }).filter(measurement => Number.isInteger(measurement.id)).sort((left, right) => left.id - right.id);
      const instanceSnapshot = nativeApi.db.empties.snapshot();
      const instanceEmpties = Array.from(instanceSnapshot.empties ?? []);
      const instanceInfos = Array.from(instanceSnapshot.infos ?? []);
      const referenceMeshes = instanceEmpties.map((empty, index) => {
        const info = instanceInfos[index];
        if (!empty || info?.tag !== 'Object') return null;
        const stable = nativeApi.db.lookupEmptyById(Number(empty.versionId));
        if (!nativeApi.isReferenceMesh(stable)) return null;
        const sourcePath = String(info.path ?? '');
        const lowerPath = sourcePath.toLowerCase();
        const sourceFormat = lowerPath.endsWith('.stl') ? 'stl' : lowerPath.endsWith('.obj') ? 'obj' : lowerPath.endsWith('.3mf') ? '3mf' : 'unknown';
        const localBox = stable.boundingBox?.clone?.();
        const worldBox = localBox?.applyMatrix4?.(stable.matrixWorld);
        const position = new Vector();
        const rotation = new Quaternion();
        const scale = new Vector();
        stable.matrixWorld.decompose(position, rotation, scale);
        let vertexEntries = 0;
        let triangles = 0;
        stable.traverse?.(node => {
          const geometry = node?.geometry;
          const positions = geometry?.attributes?.position;
          if (!positions || !Number.isFinite(positions.count)) return;
          vertexEntries += Number(positions.count);
          const indexCount = Number(geometry.index?.count);
          triangles += Number.isFinite(indexCount) ? indexCount / 3 : Number(positions.count) / 3;
        });
        const key = nativeApi.db.nodes?.item2key?.(stable);
        const pathName = sourcePath.split(/[\\/]/).pop() || null;
        return {
          id: Number(stable.versionId),
          type: 'ReferenceMesh',
          name: key === undefined ? pathName : (nativeApi.db.nodes?.getName?.(key) ?? pathName),
          sourcePath,
          sourceFormat,
          measurementSource: 'reference-mesh',
          boundsMm: worldBox ? { min: vector(worldBox.min), max: vector(worldBox.max) } : null,
          translationMm: vector(position),
          rotationQuaternion: [rotation.x, rotation.y, rotation.z, rotation.w],
          sceneScaleToMeters: direction(scale),
          vertexEntries,
          triangles,
          visible: key === undefined ? Boolean(stable.visible) : Boolean(nativeApi.db.nodes?.isVisible?.(key)),
          hidden: key === undefined ? !stable.visible : Boolean(nativeApi.db.nodes?.isHidden?.(key)),
          locked: key === undefined ? false : Boolean(nativeApi.db.nodes?.isLocked?.(key)),
        };
      }).filter(mesh => mesh && Number.isInteger(mesh.id)).sort((left, right) => left.id - right.id);
      const instances = instanceEmpties.map((empty, index) => {
        const info = instanceInfos[index];
        if (!empty || info?.tag !== 'Instance') return null;
        const targetKey = Number(info.targetKey ?? empty.targetKey);
        const sourceBodyIds = [...nativeApi.geo.geometryModel]
          .filter(([, item]) => nativeApi.db.nodes?.item2key?.(item.view) === targetKey)
          .map(([versionId]) => Number(nativeApi.db.lookupStableId(versionId)))
          .filter(Number.isInteger)
          .sort((left, right) => left - right);
        const sourceBodyName = sourceBodyIds
          .map(id => bodies.find(body => body.id === id)?.name)
          .find(name => typeof name === 'string' && name.length > 0) ?? null;
        const position = new Vector();
        const rotation = new Quaternion();
        const scale = new Vector();
        empty.matrixWorld.decompose(position, rotation, scale);
        const matrixWorldMm = Array.from(empty.matrixWorld.elements, Number);
        matrixWorldMm[12] = mm(matrixWorldMm[12]);
        matrixWorldMm[13] = mm(matrixWorldMm[13]);
        matrixWorldMm[14] = mm(matrixWorldMm[14]);
        return {
          id: Number(empty.versionId),
          type: 'Instance',
          targetKey,
          targetName: nativeApi.db.nodes?.getName?.(targetKey) || sourceBodyName,
          sourceBodyIds,
          translationMm: vector(position),
          rotationQuaternion: [rotation.x, rotation.y, rotation.z, rotation.w],
          scale: direction(scale),
          matrixWorldMm,
          visible: Boolean(nativeApi.db.nodes?.isVisible?.(nativeApi.db.nodes.item2key(empty))),
          hidden: Boolean(nativeApi.db.nodes?.isHidden?.(nativeApi.db.nodes.item2key(empty))),
          locked: Boolean(nativeApi.db.nodes?.isLocked?.(nativeApi.db.nodes.item2key(empty))),
        };
      }).filter(instance => instance && Number.isInteger(instance.id)).sort((left, right) => left.id - right.id);
      const bodyIdByNodeKey = new Map();
      for (const [versionId, item] of nativeApi.geo.geometryModel) {
        const stableId = Number(nativeApi.db.lookupStableId(versionId));
        if (!Number.isInteger(stableId)) continue;
        bodyIdByNodeKey.set(Number(nativeApi.db.nodes.item2key(item.view)), stableId);
      }
      const instanceIdByNodeKey = new Map();
      for (const empty of instanceEmpties) {
        if (!empty || empty.constructor?.name !== 'InstanceEmpty') continue;
        instanceIdByNodeKey.set(Number(nativeApi.db.nodes.item2key(empty)), Number(empty.versionId));
      }
      const referenceMeshIdByNodeKey = new Map();
      for (const empty of instanceEmpties) {
        if (!empty) continue;
        const stable = nativeApi.db.lookupEmptyById(Number(empty.versionId));
        if (!nativeApi.isReferenceMesh(stable)) continue;
        referenceMeshIdByNodeKey.set(Number(nativeApi.db.nodes.item2key(stable)), Number(stable.versionId));
      }
      const groupSnapshot = nativeApi.db.groups.snapshot();
      const groupIds = Array.from(groupSnapshot.groupIds ?? [], Number);
      const groupChildren = Array.from(groupSnapshot.children ?? [], children => Array.from(children ?? [], Number));
      const groupIdByNodeKey = new Map();
      for (const id of groupIds) {
        const group = nativeApi.db.groups.lookupById(id);
        if (group) groupIdByNodeKey.set(Number(nativeApi.db.nodes.item2key(group)), id);
      }
      const groups = groupIds.map((id, index) => {
        const group = nativeApi.db.groups.lookupById(id);
        if (!group) return null;
        const nodeKey = Number(nativeApi.db.nodes.item2key(group));
        const childKeys = groupChildren[index] ?? [];
        const childGroupIds = childKeys.map(key => groupIdByNodeKey.get(key)).filter(Number.isInteger).sort((left, right) => left - right);
        const bodyIds = childKeys.map(key => bodyIdByNodeKey.get(key)).filter(Number.isInteger).sort((left, right) => left - right);
        const instanceIds = childKeys.map(key => instanceIdByNodeKey.get(key)).filter(Number.isInteger).sort((left, right) => left - right);
        const referenceMeshIds = childKeys.map(key => referenceMeshIdByNodeKey.get(key)).filter(Number.isInteger).sort((left, right) => left - right);
        const knownKeys = new Set([
          ...childGroupIds.map(childId => Number(nativeApi.db.nodes.item2key(nativeApi.db.groups.lookupById(childId)))),
          ...childKeys.filter(key => bodyIdByNodeKey.has(key) || instanceIdByNodeKey.has(key) || referenceMeshIdByNodeKey.has(key)),
        ]);
        return {
          id,
          name: nativeApi.db.nodes.getName(nodeKey) ?? null,
          parentId: id === 0 ? null : Number(nativeApi.db.groups.getParentId(nodeKey)),
          childGroupIds,
          bodyIds,
          instanceIds,
          referenceMeshIds,
          otherNodeKeys: childKeys.filter(key => !knownKeys.has(key)).sort((left, right) => left - right),
          visible: Boolean(nativeApi.db.nodes.isVisible(nodeKey)),
          hidden: Boolean(nativeApi.db.nodes.isHidden(nodeKey)),
          locked: Boolean(nativeApi.db.nodes.isLocked(nodeKey)),
        };
      }).filter(group => group && Number.isInteger(group.id)).sort((left, right) => left.id - right.id);
      const activeGroupId = Number(groupSnapshot.currentGroupId ?? 0);
      const wireIdsBySketch = new Map();
      for (const [versionId, item] of nativeApi.geo.geometryModel) {
        if (item.view?.constructor?.name !== 'Wire') continue;
        const stableId = nativeApi.db.lookupStableId(versionId);
        if (!Number.isInteger(stableId)) continue;
        let basis;
        try { basis = this.curves.lookup(item.view); } catch { continue; }
        const sketchEntry = Array.from(this.curves.read.sketch2basis ?? [])
          .find(([, candidateBasis]) => candidateBasis === basis);
        const sketchId = Number(sketchEntry?.[0]);
        if (!Number.isInteger(sketchId)) continue;
        const ids = wireIdsBySketch.get(sketchId) ?? [];
        ids.push(stableId);
        wireIdsBySketch.set(sketchId, ids);
      }
      const regions = [];
      for (const [versionId, item] of nativeApi.geo.geometryModel) {
        if (!nativeApi.geo.automatics.has(versionId) || item.view?.constructor?.name !== 'SketchIsland') continue;
        let sketchId;
        try { sketchId = Number(this.sketches.getSketchId(item.view)); } catch { continue; }
        if (!Number.isInteger(sketchId)) continue;
        for (let index = 0; index < (item.view.regions?.length ?? 0); index += 1) {
          const region = item.view.regions.get(index);
          if (!region) continue;
          const box = region.getBoundingBox();
          regions.push({
            id: String(region.versionId),
            entityId: Number(region.entityId),
            islandVersionId: versionId,
            sketchId,
            sketchWireIds: [...(wireIdsBySketch.get(sketchId) ?? [])].sort((left, right) => left - right),
            measurementSource: 'render-mesh',
            displayBoundsMm: { min: vector(box.min), max: vector(box.max) },
          });
        }
      }
      regions.sort((left, right) => left.id.localeCompare(right.id));
      const viewports = Array.from(this.viewports ?? []);
      const sectionsByVersion = new Map();
      for (const viewport of viewports) {
        for (const section of viewport.sections ?? []) {
          if (Number.isInteger(Number(section?.versionId))) sectionsByVersion.set(Number(section.versionId), section);
        }
      }
      const sectionAnalyses = Array.from(sectionsByVersion, ([id, section]) => ({
        id,
        versionId: id,
        name: typeof section.name === 'string' && section.name.length > 0 ? section.name : null,
        originMm: vector(section.position),
        normal: direction(section.plane?.normal).map(value => -value),
        visible: Boolean(section.visible),
        registeredViewportCount: viewports.filter(viewport => viewport.sections?.includes(section)).length,
      })).sort((left, right) => left.id - right.id);
      const documentToken = String(this.document?.uuid ?? this.document?.filename ?? 'untitled');
      const dbVersion = Number.isFinite(nativeApi.db?.version) ? nativeApi.db.version : null;
      const undoDepth = this.history?.undoStack?.length ?? 0;
      const redoDepth = this.history?.redoStack?.length ?? 0;
      const bodyToken = 'bodies:v' + topologyFormat + ':' + token(bodies.map(x => [x.id, x.versionId, x.materialId, x.visible, x.hidden, x.locked, x.boundsMethod].join(':')).join(','));
      const materialToken = 'materials:' + token(JSON.stringify(materials));
      const measurementToken = 'measurements:' + token(JSON.stringify(measurements));
      const instanceToken = 'instances:' + token(JSON.stringify(instances));
      const referenceMeshToken = 'reference-meshes:' + token(JSON.stringify(referenceMeshes));
      const sectionToken = 'sections:' + token(JSON.stringify(sectionAnalyses));
      const groupToken = 'groups:' + token(JSON.stringify([activeGroupId, groups]));
      // Hash every component into a short token: agents echo the revision on every edit.
      const revision = 'r' + undoDepth + '.' + token([documentToken, dbVersion, undoDepth, redoDepth, bodyToken, planeStateToken, materialToken, measurementToken, instanceToken, referenceMeshToken, sectionToken, groupToken].join('|'));
      if (options?.probe === true) {
        return { documentToken, revision, viewStateToken, activePlaneId, bodyNames: bodies.map(body => [body.id, body.name]), regions };
      }
      return {
        documentToken,
        revision,
        dbVersion,
        undoDepth,
        redoDepth,
        materials,
        measurements,
        sectionAnalyses,
        instances,
        referenceMeshes,
        activeGroupId,
        groups,
        construction: { planes, activePlaneId, planeStateToken, viewStateToken },
        regions,
        bodies,
      };
    }`, ["ConstructionPlaneDatabase", "Vector3", "Quaternion", "pk_default"], values, timeoutMs);
  }

  close(): void {
    this.client.close();
  }

  // Draw-only evaluate for the activity HUD. It does not join the operation queue, so the badge can update while a
  // long operation holds the queue; it must never touch Plasticity state.
  async drawOverlay(expression: string): Promise<void> {
    await this.client.send("Runtime.evaluate", { expression, returnByValue: true, silent: true });
  }

  async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return await this.enqueue(() => this.client.send(method, params));
  }

  async captureScreenshot(): Promise<string> {
    return await this.enqueue(() => this.client.captureScreenshot());
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.operationTail;
    let release: (() => void) | undefined;
    this.operationTail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private async refreshNativeReferences(): Promise<void> {
    const handler = await this.client.send("Runtime.evaluate", {
      expression: "document.querySelector('command-log')?.handleCommandStarted",
      returnByValue: false,
    }) as CallResult;
    const handlerId = requireObjectId(handler.result, "Plasticity command log handler");
    const handlerProperties = await getProperties(this.client, handlerId);
    if (!handlerProperties.internalProperties?.some((property) => property.name === "[[Scopes]]" && property.value?.objectId)) {
      const discovered = await discoverStoreBindings(this.client);
      const previous = [this.editorId, ...this.bindings.values()].filter(Boolean);
      this.editorId = discovered.editorId;
      this.bindings.clear();
      for (const [name, id] of discovered.bindings) this.bindings.set(name, id);
      await this.releaseObjects([handlerId, ...objectIds(handlerProperties.result), ...objectIds(handlerProperties.internalProperties ?? []), ...previous], new Set([this.editorId, ...this.bindings.values()]));
      return;
    }
    const scopesId = requireObjectId(handlerProperties.internalProperties?.find((property) => property.name === "[[Scopes]]")?.value, "Plasticity command scopes");
    const scopes = await getProperties(this.client, scopesId);
    const scopeIds = scopes.result
      .filter((property) => /^\d+$/.test(property.name))
      .map((property) => property.value?.objectId)
      .filter((value): value is string => typeof value === "string");
    if (scopeIds.length < 2) throw new Error("Plasticity native command scopes were not found");

    const closure = await getProperties(this.client, scopeIds[0] as string);
    const editorId = requireObjectId(
      closure.result.find((property) => property.name === "editor")?.value,
      "Plasticity editor",
    );
    const nativeScope = await getProperties(this.client, scopeIds[1] as string);
    const bindings = new Map<string, string>();
    for (const property of nativeScope.result) {
      if (property.value?.objectId) bindings.set(property.name, property.value.objectId);
    }

    const retained = new Set([editorId, ...bindings.values()]);
    const previous = new Set([this.editorId, ...this.bindings.values()].filter(Boolean));
    this.editorId = editorId;
    this.bindings.clear();
    for (const [name, objectId] of bindings) this.bindings.set(name, objectId);
    const temporary = [
      handlerId,
      scopesId,
      ...objectIds(handlerProperties.result),
      ...objectIds(handlerProperties.internalProperties ?? []),
      ...objectIds(scopes.result),
      ...objectIds(closure.result),
      ...objectIds(nativeScope.result),
    ];
    await this.releaseObjects([...previous, ...temporary], retained);
  }

  private async releaseObjects(objectIds: readonly string[], retained: ReadonlySet<string>): Promise<void> {
    await Promise.all([...new Set(objectIds)].filter((id) => id && !retained.has(id)).map(async (objectId) => {
      await this.client.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
    }));
  }

  private async call<T>(functionDeclaration: string, bindingNames: string[], values: unknown[], timeoutMs?: number): Promise<T> {
    const args: Array<{ objectId?: string; value?: unknown }> = [];
    for (const name of bindingNames) {
      const objectId = this.bindings.get(name);
      if (!objectId) throw new Error(`Plasticity native binding is unavailable: ${name}`);
      args.push({ objectId });
    }
    for (const value of values) args.push({ value });
    const response = await this.client.send("Runtime.callFunctionOn", {
      objectId: this.editorId,
      functionDeclaration,
      arguments: args,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, timeoutMs) as CallResult;
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "unknown renderer error";
      throw new Error(`Plasticity command failed: ${detail}`);
    }
    return response.result?.value as T;
  }
}

async function getProperties(client: CdpClient, objectId: string): Promise<{
  result: PropertyDescriptor[];
  internalProperties?: PropertyDescriptor[];
}> {
  return await client.send("Runtime.getProperties", {
    objectId,
    ownProperties: true,
    accessorPropertiesOnly: false,
  }) as { result: PropertyDescriptor[]; internalProperties?: PropertyDescriptor[] };
}

function requireObjectId(value: RemoteObject | undefined, description: string): string {
  if (!value?.objectId) throw new Error(`${description} is unavailable`);
  return value.objectId;
}

function objectIds(properties: readonly PropertyDescriptor[]): string[] {
  return properties.flatMap((property) => property.value?.objectId ? [property.value.objectId] : []);
}
