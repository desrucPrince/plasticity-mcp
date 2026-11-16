// Shared harness for the 2026-11 speed audit. Measurement only: never edits src/.
// Every run is pinned to the isolated Plasticity on 127.0.0.1:57147 (target EDEF123A...).
// Two ways in:
//  - openInProcess(): the real compact server in this process over an in-memory MCP transport,
//    with a session subclass that logs every native state read / mutation / read and the
//    start of every tool callback (ensureConnected marker), so batch steps can be segmented.
//  - stdio timing lives in fixed-costs.ts (spawns scripts/run-server.ts like a real client).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

export const ENDPOINT = "http://127.0.0.1:57147";
export const TARGET = "EDEF123AC89B15D2277092367F48F3AC";
export const OUT_DIR = new URL(".", import.meta.url).pathname;
// Journal writes go to scratch, never into the repo (the default root is <cwd>/.plasticity-mcp).
export const HISTORY_ROOT = process.env.SPEED_HISTORY_ROOT
  ?? "/private/tmp/claude-501/-Users-neocortez-Documents-APP-DEV-neoHQ-v2/d1d90249-76be-49b7-9d4d-ed691ee223fe/scratchpad/history";

export function guardEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = {
    PLASTICITY_CDP_URL: ENDPOINT,
    PLASTICITY_AUTO_LAUNCH: "0",
    PLASTICITY_HUD: "0",
    PLASTICITY_HUD_NOTIFY: "0",
    PLASTICITY_TIMING: "1",
    PLASTICITY_CONSTRUCTION_HISTORY_ROOT: HISTORY_ROOT,
    // No Codex analysis/reference-search children: they are not part of CAD work and could reach the network.
    PLASTICITY_CODEX_EXECUTABLE: "/nonexistent/codex",
    ...extra,
  };
  Object.assign(process.env, env);
  if (process.env.PLASTICITY_CDP_URL !== ENDPOINT) throw new Error("refusing: wrong CDP endpoint");
  mkdirSync(HISTORY_ROOT, { recursive: true });
  return env;
}

export type OpEvent = { kind: "step" | "state" | "mutate" | "read" | "journal" | "cdp"; t0: number; ms: number; bytes?: number };

export const bytes = (value: unknown) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));

export async function openInProcess() {
  guardEnv();
  const { createCompactServer, PlasticitySession } = await import("../../src/server.ts");
  const { ConstructionHistoryStore } = await import("../../src/plasticity/construction-history.ts");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  const events: OpEvent[] = [];
  let stateDepth = 0;
  const patched = new WeakSet<object>();
  const patchRuntime = (runtime: Record<string, unknown>) => {
    if (patched.has(runtime)) return;
    patched.add(runtime);
    const wrap = (name: string, kind: OpEvent["kind"], measureBytes = false) => {
      const original = (runtime[name] as (...args: unknown[]) => Promise<unknown>).bind(runtime);
      runtime[name] = async (...args: unknown[]) => {
        const nested = stateDepth > 0 && kind !== "state";
        if (kind === "state") stateDepth += 1;
        const t0 = performance.now();
        try {
          const value = await original(...args);
          if (!nested) events.push({ kind, t0, ms: performance.now() - t0, ...(measureBytes ? { bytes: bytes(value) } : {}) });
          return value;
        } finally {
          if (kind === "state") stateDepth -= 1;
        }
      };
    };
    wrap("getState", "state", true);
    wrap("mutate", "mutate");
    wrap("read", "read");
    wrap("readNative", "read");
    wrap("cdp", "cdp");
  };
  class TimedSession extends PlasticitySession {
    override get() {
      const ops = super.get();
      patchRuntime((ops as unknown as { runtime: Record<string, unknown> }).runtime);
      return ops;
    }
    override async ensureConnected() {
      events.push({ kind: "step", t0: performance.now(), ms: 0 });
      await super.ensureConnected();
    }
  }
  class TimedHistory extends ConstructionHistoryStore {
    override async append(entry: Parameters<ConstructionHistoryStore["append"]>[0]) {
      const t0 = performance.now();
      try { return await super.append(entry); } finally { events.push({ kind: "journal", t0, ms: performance.now() - t0 }); }
    }
  }
  const session = new TimedSession();
  const server = createCompactServer(session, undefined, undefined, undefined, new TimedHistory(HISTORY_ROOT));
  const client = new Client({ name: "speed-audit", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  return { client, server, events, close: async () => { await client.close(); await server.close(); } };
}

export type CallRecord = {
  turn: number;
  label: string;
  tool: string;
  routedTo?: string;
  reqBytes: number;
  respBytes: number;
  wallMs: number;
  isError: boolean;
  forced?: string;
  serverTiming?: unknown;
  ops: ReturnType<typeof summarizeOps>;
  stepOps?: Array<ReturnType<typeof summarizeOps> & { step: number; residualMs: number }>;
};

export function summarizeOps(events: OpEvent[]) {
  const sum = (kind: OpEvent["kind"]) => events.filter((e) => e.kind === kind);
  const ms = (list: OpEvent[]) => Math.round(list.reduce((t, e) => t + e.ms, 0) * 10) / 10;
  const states = sum("state");
  return {
    stateReads: states.length,
    stateMs: ms(states),
    stateBytesMax: states.reduce((m, e) => Math.max(m, e.bytes ?? 0), 0),
    mutates: sum("mutate").length,
    mutateMs: ms(sum("mutate")),
    reads: sum("read").length,
    readMs: ms(sum("read")),
    journalWrites: sum("journal").length,
    journalMs: ms(sum("journal")),
  };
}

export class Recorder {
  calls: CallRecord[] = [];
  results: unknown[] = [];
  h: Awaited<ReturnType<typeof openInProcess>>;
  scenario: string;
  constructor(h: Awaited<ReturnType<typeof openInProcess>>, scenario: string) { this.h = h; this.scenario = scenario; }

  async call(turn: number, label: string, tool: string, args: Record<string, unknown>, opts: { forced?: string; count?: boolean } = {}) {
    const from = this.h.events.length;
    const t0 = performance.now();
    const response = await this.h.client.callTool({ name: tool, arguments: args });
    const wallMs = Math.round((performance.now() - t0) * 10) / 10;
    const content = response.content as Array<{ type: string; text?: string; data?: string }>;
    const text = content.find((p) => p.type === "text")?.text ?? "";
    const respBytes = content.reduce((t, p) => t + bytes(p.text ?? p.data ?? ""), 0);
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
    const slice = this.h.events.slice(from);
    const record: CallRecord = {
      turn, label, tool,
      ...(tool === "plasticity_call" ? { routedTo: String(args.toolName) } : {}),
      reqBytes: bytes({ name: tool, arguments: args }),
      respBytes, wallMs, isError: response.isError === true,
      ...(opts.forced ? { forced: opts.forced } : {}),
      ...(parsed && typeof parsed === "object" && "timing" in (parsed as object) ? { serverTiming: (parsed as { timing: unknown }).timing } : {}),
      ops: summarizeOps(slice),
      stepOps: segmentSteps(slice),
    };
    if (opts.count !== false) this.calls.push(record);
    this.results.push(parsed);
    if (response.isError) throw Object.assign(new Error(`${label}: ${tool} failed: ${text.slice(0, 3000)}`), { record, parsed });
    return parsed as any;
  }

  totals() {
    const turns = new Set(this.calls.map((c) => c.turn)).size;
    const req = this.calls.reduce((t, c) => t + c.reqBytes, 0);
    const resp = this.calls.reduce((t, c) => t + c.respBytes, 0);
    // Parallel calls in one turn: the turn's server time is the slowest call in it.
    const byTurn = new Map<number, number>();
    for (const c of this.calls) byTurn.set(c.turn, Math.max(byTurn.get(c.turn) ?? 0, c.wallMs));
    const serverMs = Math.round([...byTurn.values()].reduce((t, v) => t + v, 0));
    return { turns, calls: this.calls.length, reqBytes: req, respBytes: resp, outTokens: Math.round(req / 4), inTokens: Math.round(resp / 4), serverMs, forcedExtra: this.calls.filter((c) => c.forced).map((c) => ({ turn: c.turn, label: c.label, cause: c.forced })) };
  }
}

// Split a call's op log at tool-callback markers. Marker 0 is the outer tool (or the batch);
// for a batch, marker i+1 starts step i. Residual = wall time not spent in native calls or journal writes.
function segmentSteps(slice: OpEvent[]) {
  const markers = slice.map((e, i) => (e.kind === "step" ? i : -1)).filter((i) => i >= 0);
  if (markers.length <= 2) return undefined;
  const out = [];
  for (let s = 1; s < markers.length; s++) {
    const start = markers[s]!;
    const end = s + 1 < markers.length ? markers[s + 1]! : slice.length;
    const part = slice.slice(start + 1, end);
    const t0 = slice[start]!.t0;
    const t1 = s + 1 < markers.length ? slice[markers[s + 1]!]!.t0 : (part.length ? Math.max(...part.map((e) => e.t0 + e.ms)) : t0);
    const ops = summarizeOps(part);
    out.push({ step: s - 1, ...ops, wallMs: Math.round((t1 - t0) * 10) / 10, residualMs: Math.round((t1 - t0 - ops.stateMs - ops.mutateMs - ops.readMs - ops.journalMs) * 10) / 10 });
  }
  return out;
}

export async function status(h: Awaited<ReturnType<typeof openInProcess>>) {
  const r = await h.client.callTool({ name: "plasticity_status", arguments: { bodyLimit: 200 } });
  const st = JSON.parse((r.content as Array<{ text: string }>)[0]!.text);
  if (st.targetId !== TARGET) throw new Error(`refusing: connected to ${st.targetId}, not ${TARGET}`);
  return st as { targetId: string; title: string; revision: string; undoDepth: number; redoDepth: number; bodies: Array<{ id: number; name: string; boundsMm: unknown }> } & Record<string, unknown>;
}

export async function restore(h: Awaited<ReturnType<typeof openInProcess>>, base: { undoDepth: number; bodies: Array<{ id: number }> }) {
  for (let guard = 0; guard < 20; guard++) {
    const st = await status(h);
    const extra = st.undoDepth - base.undoDepth;
    if (extra <= 0) break;
    const n = Math.min(extra, 50);
    const r = await h.client.callTool({ name: "plasticity_batch", arguments: { steps: Array.from({ length: n }, () => ({ toolName: "plasticity_undo", arguments: {} })) } });
    if (r.isError) throw new Error(`restore undo failed: ${(r.content as Array<{ text: string }>)[0]!.text.slice(0, 2000)}`);
  }
  const end = await status(h);
  const ids = (s: { bodies: Array<{ id: number }> }) => s.bodies.map((b) => b.id).sort((x, y) => x - y).join(",");
  const ok = end.undoDepth === base.undoDepth && ids(end) === ids(base);
  return { ok, undoDepth: end.undoDepth, bodyCount: end.bodies.length, redoDepth: end.redoDepth };
}

export function save(name: string, data: unknown) {
  const path = join(OUT_DIR, name);
  writeFileSync(path, JSON.stringify(data, null, 1));
  return path;
}
