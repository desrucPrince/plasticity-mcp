// Shared harness for the 2026-11 gap probes. Only ever talks to the isolated test instance.
import { discoverPlasticityTargets } from "../../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../../src/plasticity/runtime.ts";
import { nativeFunction } from "../../src/plasticity/native-function.ts";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CDP = "http://127.0.0.1:56453";
export const TARGET = "3FDC93BEB98D54E51A091068A9142583";
export const HERE = dirname(fileURLToPath(import.meta.url));
if (process.env.PLASTICITY_CDP_URL !== CDP) throw new Error(`Refusing: PLASTICITY_CDP_URL must be ${CDP}`);

export async function connect() {
  const targets = await discoverPlasticityTargets(CDP);
  const target = targets.find((t: any) => t.id === TARGET || t.targetId === TARGET);
  if (!target) throw new Error(`Isolated target ${TARGET} not found: ${JSON.stringify(targets)}`);
  if (!String((target as any).webSocketDebuggerUrl).includes("127.0.0.1:56453")) throw new Error("wrong ws endpoint");
  return await PlasticityRuntime.connect(target as any);
}

export async function depth(runtime: PlasticityRuntime) {
  return await runtime.read<{ undo: number; redo: number; bodies: number; busy: boolean }>(nativeFunction`function () {
    let bodies = 0;
    for (const [versionId] of nativeApi.geo.geometryModel) if (!nativeApi.geo.automatics.has(versionId)) bodies += 1;
    return { undo: this.history.undoStack.length, redo: this.history.redoStack.length, bodies, busy: !!this.executor.isBusy };
  }`);
}

export async function undoTo(runtime: PlasticityRuntime, target: number) {
  for (let i = 0; i < 50; i++) {
    const d = await depth(runtime);
    if (d.undo <= target) return d;
    await runtime.mutate(`async function () {
      const before = this.history.undoStack.length;
      let settled = false, failure = null;
      this.undo().then(() => { settled = true; }, e => { failure = e; });
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        if (settled) return;
        if (this.history.undoStack.length < before && !this.executor.isBusy) return;
        await new Promise(r => setTimeout(r, 25));
      }
      throw new Error('undo timeout');
    }`, []);
  }
  throw new Error("undoTo did not converge");
}

export function save(name: string, data: unknown) {
  const path = join(HERE, name);
  writeFileSync(path, JSON.stringify(data, null, 1));
  console.log("wrote", path);
}

export { nativeFunction };

// Describe a class: own static keys, prototype chain method/accessor names, and the own fields of a fresh instance.
export const describeClassesSource = `function (...classes) {
  const names = this.__probeNames;
  const show = (v) => v === null || v === undefined ? String(v) : typeof v === 'object' ? (v.constructor?.name ?? 'object') + (Array.isArray(v) ? '[' + v.length + ']' : '') : typeof v === 'function' ? 'fn' : v;
  const out = {};
  classes.forEach((cls, i) => {
    const info = { exists: typeof cls === 'function' };
    if (!info.exists) { out[names[i]] = info; return; }
    const chain = [];
    let p = cls.prototype;
    while (p && p !== Object.prototype) {
      const entry = { name: p.constructor?.name, methods: [], accessors: [] };
      for (const key of Object.getOwnPropertyNames(p)) {
        if (key === 'constructor') continue;
        const d = Object.getOwnPropertyDescriptor(p, key);
        if (d.get || d.set) entry.accessors.push(key + (d.get ? 'g' : '') + (d.set ? 's' : '')); else if (typeof d.value === 'function') entry.methods.push(key);
      }
      chain.push(entry);
      p = Object.getPrototypeOf(p);
    }
    info.chain = chain;
    info.statics = Object.getOwnPropertyNames(cls).filter(k => !['length','name','prototype'].includes(k));
    out[names[i]] = info;
  });
  return out;
}`;

// MCP session (through discovery/mcp-client.ts) pinned to the isolated instance; state files go to a scratch dir.
import { openSession } from "../mcp-client.ts";
const SCRATCH = process.env.PROBE_SCRATCH ?? "/private/tmp/claude-501/plasticity-probe-state";
export async function mcp() {
  const session = await openSession({ full: true, env: {
    PLASTICITY_CDP_URL: CDP, PLASTICITY_HUD: "0", PLASTICITY_AUTO_LAUNCH: "0",
    PLASTICITY_MCP_STATE_DIR: SCRATCH + "/state", PLASTICITY_CONSTRUCTION_HISTORY_ROOT: SCRATCH + "/history",
  } });
  const text = JSON.stringify(session.connected) + JSON.stringify(session.windows);
  if (!text.includes(TARGET)) { await session.close(); throw new Error("MCP session is not on the isolated target: " + text.slice(0, 400)); }
  const others = JSON.stringify(session.windows).match(/[0-9A-F]{32}/g)?.filter((id) => id !== TARGET) ?? [];
  if (others.length) { await session.close(); throw new Error("Unexpected extra windows: " + others.join(",")); }
  return session;
}

const showSource = `const show = (v) => v === null || v === undefined ? String(v) : Array.isArray(v) ? v.map(show) : typeof v === 'object' ? (v.constructor?.name ?? 'object') : typeof v === 'function' ? 'fn' : v;`;

const findSource = `const find = id => {
  for (const [versionId, item] of nativeApi.geo.geometryModel) {
    if (nativeApi.db.lookupStableId(versionId) === id) return item.view;
  }
  throw new Error('Unknown body ID: ' + id);
};
const findItem = id => {
  for (const [versionId, item] of nativeApi.geo.geometryModel) {
    if (nativeApi.db.lookupStableId(versionId) === id) return item;
  }
  throw new Error('Unknown body ID: ' + id);
};
const edgeOf = (id, edgeId) => { const v = find(id); const i = v.high.edges.versionIds.indexOf(edgeId); if (i < 0) throw new Error('edge ' + edgeId); return v.high.edges.get(i); };
const faceOf = (id, faceId) => { const v = find(id); const i = v.high.faces.versionIds.indexOf(faceId); if (i < 0) throw new Error('face ' + faceId); return v.high.faces.get(i); };`;

/**
 * Drive one factory inside one command and commit it. `setup` is renderer JS with access to
 * factory, editor, args, B (bindings by name), find, findItem, edgeOf, faceOf, nativeApi.
 * command: { binding: "XCommand" } or { name: "XCommand" } (editor.commands) .
 */
export async function drive(runtime: PlasticityRuntime, opts: {
  command: { binding?: string; name?: string };
  factory: string;
  bindings?: string[];
  setup: string;
  args?: unknown;
  timeoutMs?: number;
  commit?: string; // override commit expression, default 'await factory.commit()'
}) {
  const names = [opts.factory, ...(opts.command.binding ? [opts.command.binding] : []), ...(opts.bindings ?? [])];
  return await runtime.mutate<unknown>(nativeFunction`async function (...bound) {
    const args = bound.pop();
    const B = {}; args.__names.forEach((n, i) => { B[n] = bound[i]; });
    ${showSource}
    ${findSource}
    if (this.executor.isBusy) throw new Error('Plasticity is busy');
    const editor = this;
    const Command = args.__command.binding ? B[args.__command.binding] : this.commands[args.__command.name];
    if (!Command) throw new Error('command class unavailable');
    let failure, summary;
    const command = new Command(editor);
    command.remember = false;
    command.execute = async function () {
      try {
        const factory = new B[args.__factory](editor).resource(this);
        ${opts.setup}
        const result = ${opts.commit ?? "await factory.commit()"};
        summary = show(result);
        return result;
      } catch (error) { failure = error; throw error; }
    };
    await this.exec(command);
    if (failure) throw failure;
    return { committed: true, result: summary };
  }`, names, [{ ...(opts.args as object ?? {}), __names: names, __factory: opts.factory, __command: opts.command }], opts.timeoutMs ?? 30000);
}

/** Bodies that are not in `baseIds`, read through MCP status (mm). */
export async function newBodies(session: Awaited<ReturnType<typeof mcp>>, baseIds: Set<number>) {
  const st = await session.raw("plasticity_status", { bodyLimit: 200 });
  return { revision: st.revision as string, undoDepth: st.undoDepth as number, bodies: (st.bodies as any[]).filter((b) => !baseIds.has(b.id)).map((b) => ({ id: b.id, type: b.type, name: b.name, boundsMm: b.boundsMm, faceCount: b.faceCount, edgeCount: b.edgeCount, vertexCount: b.vertexCount })) };
}

export function errText(error: unknown) { return String((error as Error)?.message ?? error).slice(0, 1200); }

/** Setup snippet: log prototype-chain property reads on `factory` (own fields are not logged). */
export const TRACE = `const __reads = []; { const __proto = Object.getPrototypeOf(factory);
Object.setPrototypeOf(factory, new Proxy(__proto, { get(t, k, r) { if (typeof k === 'string' && !__reads.includes(k)) __reads.push(k); return Reflect.get(t, k, r); } })); }`;
export const TRACED_COMMIT = `await factory.commit().then(r => { globalThis.__probeReads = __reads.slice(); return r; }, e => { globalThis.__probeReads = __reads.slice(); e.message = String(e.message) + ' | proto reads: ' + __reads.join(','); throw e; })`;
export async function lastReads(runtime: PlasticityRuntime) { return await runtime.read<string[] | null>(`function () { const r = globalThis.__probeReads ?? null; globalThis.__probeReads = null; return r; }`); }
