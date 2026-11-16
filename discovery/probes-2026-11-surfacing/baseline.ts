// Record (or re-check) the instance baseline: bodies, undo depth, shader state. usage: node baseline.ts [outName]
import { connect, save } from "./harness.ts";
import { startMcp, status } from "./mcp.ts";
const out = process.argv[2] ?? "baseline.json";
const client = await startMcp();
const st = await status(client);
const runtime = await connect();
const native = await runtime.read<any>(`function () {
  const sh = this.shading;
  const mode = sh.mode;
  return { undo: this.history.undoStack.length, redo: this.history.redoStack.length,
    modeTag: mode?.tag ?? null, shader: sh.shader === undefined ? 'undefined' : (sh.shader === null ? null : (sh.shader?.constructor?.name ?? sh.shader)),
    isUsingShader: sh.isUsingShader, isUsingMatcap: sh.isUsingMatcap, isUsingEnvironment: sh.isUsingEnvironment,
    measurements: (this.measurements && typeof this.measurements[Symbol.iterator] === 'function') ? [...this.measurements].length : null,
    active: this.executor.active?.command?.constructor?.name ?? null };
}`);
const record = { at: new Date().toISOString(), revision: st.revision, undoDepth: st.undoDepth, bodies: (st.bodies as any[]).map((b) => ({ id: b.id, versionId: b.versionId, type: b.type, name: b.name, boundsMm: b.boundsMm, faceCount: b.faceCount, edgeCount: b.edgeCount })), measurements: st.measurements ?? null, native };
console.log(JSON.stringify(record, null, 1));
save(out, record);
runtime.close(); await client.close(); process.exit(0);
