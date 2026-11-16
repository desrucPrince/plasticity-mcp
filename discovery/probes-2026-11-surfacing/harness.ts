// Shared harness for the 2026-11 surfacing probes. Only ever talks to the isolated test instance.
import { discoverPlasticityTargets } from "../../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../../src/plasticity/runtime.ts";
import { nativeFunction } from "../../src/plasticity/native-function.ts";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The endpoint and target come from the environment (see env.sh). Only a 127.0.0.1 endpoint is accepted.
export const CDP = process.env.PLASTICITY_CDP_URL ?? "";
export const TARGET = process.env.PLASTICITY_TARGET_ID ?? "";
export const HERE = dirname(fileURLToPath(import.meta.url));
const endpoint = (() => { try { return new URL(CDP); } catch { return undefined; } })();
if (!endpoint || endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port) throw new Error(`Refusing: PLASTICITY_CDP_URL must be http://127.0.0.1:PORT (got "${CDP}")`);
if (!/^[0-9A-F]{32}$/i.test(TARGET)) throw new Error("Refusing: PLASTICITY_TARGET_ID must name the isolated window (32 hex characters)");

export async function connect() {
  const targets = await discoverPlasticityTargets(CDP);
  const target = targets.find((t: any) => t.id === TARGET || t.targetId === TARGET);
  if (!target) throw new Error(`Isolated target ${TARGET} not found`);
  if (!String((target as any).webSocketDebuggerUrl).includes(`127.0.0.1:${endpoint!.port}/`)) throw new Error("wrong ws endpoint");
  return await PlasticityRuntime.connect(target as any);
}

export function save(name: string, data: unknown) {
  const path = join(HERE, name);
  writeFileSync(path, JSON.stringify(data, null, 1));
  console.log("wrote", path);
}

export { nativeFunction };

// Ported from ../probes-2026-11-pick/harness.ts (no hardcoded port or scratch path).
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
export async function newBodies(session: any, baseIds: Set<number>) {
  const st = await session.status();
  return { revision: st.revision as string, undoDepth: st.undoDepth as number, bodies: (st.bodies as any[]).filter((b) => !baseIds.has(b.id)).map((b) => ({ id: b.id, type: b.type, name: b.name, boundsMm: b.boundsMm, faceCount: b.faceCount, edgeCount: b.edgeCount, vertexCount: b.vertexCount })) };
}

export function errText(error: unknown) { return String((error as Error)?.message ?? error).slice(0, 1200); }

/** Setup snippet: log prototype-chain property reads on `factory` (own fields are not logged). */
export const TRACE = `const __reads = []; { const __proto = Object.getPrototypeOf(factory);
Object.setPrototypeOf(factory, new Proxy(__proto, { get(t, k, r) { if (typeof k === 'string' && !__reads.includes(k)) __reads.push(k); return Reflect.get(t, k, r); } })); }`;
export const TRACED_COMMIT = `await factory.commit().then(r => { globalThis.__probeReads = __reads.slice(); return r; }, e => { globalThis.__probeReads = __reads.slice(); e.message = String(e.message) + ' | proto reads: ' + __reads.join(','); throw e; })`;
export async function lastReads(runtime: PlasticityRuntime) { return await runtime.read<string[] | null>(`function () { const r = globalThis.__probeReads ?? null; globalThis.__probeReads = null; return r; }`); }

