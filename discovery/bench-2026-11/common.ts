// Shared helpers for the bench-2026-11 harness: MCP session against the FROZEN server tree, small utils.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";

export const ALLOWED_PORT = "57291";
export const TARGET = "E634FD207384F0F8D6EB10D2D01D46F2";
export const ENDPOINT = "http://127.0.0.1:57291";
export const FROZEN_TREE = `${process.env.HOME}/Projects/plasticity-mcp-bench`; // the frozen server tree (commit 496c478)

export type V3 = [number, number, number];
export const r3 = (v: number) => Math.round(v * 1000) / 1000;
export const near = (a: number, b: number, tol = 0.05) => Math.abs(a - b) <= tol;
export const sum = (xs: number[]) => xs.reduce((t, v) => t + v, 0);
export const median = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
export const byteLen = (v: unknown) => Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Check = { check: string; ok: boolean; soft?: boolean; tol?: string; expected?: unknown; actual?: unknown };
export type Body = { id: number; name: string; type: string; boundsMm: { min: number[]; max: number[] }; faceCount: number; edgeCount: number };
export type Status = { targetId: string; revision: string; undoDepth: number; redoDepth: number; bodies: Body[] };

export function serverEnv(endpoint: string, historyRoot: string): Record<string, string> {
  return {
    PLASTICITY_CDP_URL: endpoint,
    PLASTICITY_AUTO_LAUNCH: "0",
    PLASTICITY_HUD: "0",
    PLASTICITY_HUD_NOTIFY: "0",
    PLASTICITY_CONSTRUCTION_HISTORY_ROOT: historyRoot,
    PLASTICITY_CODEX_EXECUTABLE: "/nonexistent/codex",
  };
}

export type Ctx = { tree: string; endpoint: string; target: string; historyRoot: string; emptyCwd: string; base: { undoDepth: number; ids: string; bodyCount: number } };

export class Session {
  client!: Client;
  ctx: Ctx;
  constructor(ctx: Ctx) { this.ctx = ctx; }
  async open() {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(this.ctx.tree, "scripts/run-server.ts"), "--compact-tools"],
      env: { ...(process.env as Record<string, string>), ...serverEnv(this.ctx.endpoint, this.ctx.historyRoot) },
      cwd: this.ctx.emptyCwd,
      stderr: "ignore",
    });
    this.client = new Client({ name: "bench-2026-11", version: "0" });
    await this.client.connect(transport);
    return this;
  }
  // Direct MCP tool call (compact list) or a catalog tool through plasticity_call. Returns parsed JSON.
  async raw(name: string, args: Record<string, unknown> = {}) {
    const r = await this.client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("");
    if (r.isError) throw new Error(`${name} failed: ${text.slice(0, 1500)}`);
    try { return JSON.parse(text); } catch { return text; }
  }
  async call(name: string, args: Record<string, unknown> = {}) {
    // The compact tool list has these as direct tools; everything else goes through plasticity_call.
    const direct = new Set(DIRECT);
    if (direct.has(name)) return this.raw(name, args);
    return this.raw("plasticity_call", { toolName: name, arguments: args });
  }
  async status(): Promise<Status> {
    const st = await this.raw("plasticity_status", { bodyLimit: 200 });
    if (st.targetId !== this.ctx.target) throw new Error(`refusing: connected to ${st.targetId}, not ${this.ctx.target}`);
    return st;
  }
  async rev() { return (await this.status()).revision as string; }
  // Run steps through plasticity_batch. Later steps may use $N.added[0] and $N.result... references.
  async batch(steps: Array<{ toolName: string; arguments: Record<string, unknown> }>, extra: Record<string, unknown> = {}) {
    return this.raw("plasticity_batch", { steps, ...extra });
  }
  async close() { try { await this.client.close(); } catch { /* ignore */ } }
}

// Tools that the compact server exposes directly (everything else is reached through plasticity_call).
export const DIRECT = ["plasticity_call", "plasticity_batch", "plasticity_list_windows", "plasticity_connect", "plasticity_status", "plasticity_current_selection", "plasticity_check_interference", "plasticity_capture_snapshot", "plasticity_changes_since", "plasticity_list_bodies", "plasticity_body_info", "plasticity_describe_body", "plasticity_find_faces", "plasticity_find_edges", "plasticity_measure_parallel_planar_face_clearance", "plasticity_reconcile", "plasticity_create_box", "plasticity_create_cylinder", "plasticity_create_countersink_pattern", "plasticity_create_through_hole_pattern", "plasticity_create_screw_boss_pattern", "plasticity_create_rib", "plasticity_create_connector_opening", "plasticity_create_sphere", "plasticity_create_control_point_curve", "plasticity_move", "plasticity_rotate", "plasticity_scale", "plasticity_boolean", "plasticity_cut_with_curves", "plasticity_knife_curve", "plasticity_fillet", "plasticity_chamfer", "plasticity_extrude_faces", "plasticity_extrude_profile", "plasticity_extrude_curves", "plasticity_fillet_curves", "plasticity_set_driving_distance", "plasticity_mirror", "plasticity_delete", "plasticity_undo", "plasticity_redo", "plasticity_screenshot"];

export async function withSession<T>(ctx: Ctx, fn: (s: Session) => Promise<T>): Promise<T> {
  const s = await new Session(ctx).open();
  try { return await fn(s); } finally { await s.close(); }
}

export const idsOf = (s: { bodies: Array<{ id: number }> }) => s.bodies.map((b) => b.id).sort((x, y) => x - y).join(",");

// Undo back to the starting depth and assert depth + body ids. Never leaves the baseline un-asserted.
export async function restore(ctx: Ctx) {
  return withSession(ctx, async (s) => {
    for (let guard = 0; guard < 40; guard++) {
      const st = await s.status();
      const extra = st.undoDepth - ctx.base.undoDepth;
      if (extra <= 0) break;
      const n = Math.min(extra, 50);
      await s.batch([{ toolName: "plasticity_undo", arguments: { steps: n } }]);
    }
    const end = await s.status();
    return { ok: end.undoDepth === ctx.base.undoDepth && idsOf(end) === ctx.base.ids, undoDepth: end.undoDepth, bodyCount: end.bodies.length, redoDepth: end.redoDepth };
  });
}

export function makeCtx(tree = FROZEN_TREE, historyRoot: string, emptyCwd: string): Ctx {
  return { tree, endpoint: ENDPOINT, target: TARGET, historyRoot, emptyCwd, base: { undoDepth: 0, ids: "", bodyCount: 0 } };
}

// ---- face / edge reads (always with an explicit limit: direct find replies are cut at 8 KB otherwise) ----
export type Face = { bodyId: number; id: string; surfaceType: string; planar: boolean; centerMm: number[]; normal: number[] | null; radiusMm: number | null; axisOriginMm: number[] | null; axisDirection: number[] | null; boundsMm: { min: number[]; max: number[] }; areaMm2?: number };
export type Edge = { bodyId: number; id: string; curveType: string; lengthMm?: number; centerMm: number[]; radiusMm?: number | null; boundsMm: { min: number[]; max: number[] }; [k: string]: unknown };

export async function facesOf(s: Session, bodyId: number, extra: Record<string, unknown> = {}): Promise<Face[]> {
  const rev = await s.rev();
  const r = await s.raw("plasticity_find_faces", { revision: rev, query: { bodyIds: [bodyId], ...extra }, limit: 1000 });
  return r.matches as Face[];
}
export async function edgesOf(s: Session, bodyId: number, extra: Record<string, unknown> = {}): Promise<Edge[]> {
  const rev = await s.rev();
  const r = await s.raw("plasticity_find_edges", { revision: rev, query: { bodyIds: [bodyId], ...extra }, limit: 1000 });
  return r.matches as Edge[];
}
export const bnd = (label: string, got: { min: number[]; max: number[] }, min: number[], max: number[], tol = 0.06): Check => ({ check: `${label} bounds`, tol: `+-${tol} mm`, ok: min.every((v, i) => near(got.min[i]!, v, tol)) && max.every((v, i) => near(got.max[i]!, v, tol)), expected: { min, max }, actual: { min: got.min.map(r3), max: got.max.map(r3) } });
