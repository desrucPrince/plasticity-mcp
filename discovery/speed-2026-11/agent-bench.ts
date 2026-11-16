// agent-bench: a REAL Claude model builds reference parts through the Plasticity MCP server.
// Measurement only. Spawns headless `claude -p` restricted to the plasticity MCP tools, parses the
// stream-json, then verifies the part itself through a fresh MCP session and restores the document.
//
// Usage (Node 24):
//   node discovery/speed-2026-11/agent-bench.ts --server-tree <dir> --label baseline [--parts a,b,c,d,e] [--runs 2]
//        [--model <alias>] [--endpoint http://127.0.0.1:57291] [--target E634...] [--out <dir>] [--timeout-s 360] [--max-turns 40]
//   node discovery/speed-2026-11/agent-bench.ts --summarize agent-bench-baseline.json[,more.json]
//
// Claude command line (one per run; the temp config and the empty cwd are made fresh per run):
//   claude -p "<prompt>" --mcp-config <tmp.json> --strict-mcp-config --output-format stream-json --verbose
//          --tools "" --allowedTools "mcp__plasticity" --setting-sources "" --permission-mode dontAsk
//          --max-turns <N> --disable-slash-commands --no-session-persistence [--model <alias>]
//   --tools ""            removes every built-in tool (no Bash/Edit/Web); only MCP tools remain.
//   --setting-sources ""  loads no user/project/local settings, so the owner's hooks and rules do not leak.
//   --permission-mode dontAsk + --allowedTools mcp__plasticity   no prompt can block; other tools are denied.
//   --bare is NOT used: it ignores the OAuth login. Run from an empty temp cwd so no CLAUDE.md is found.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(new URL(import.meta.url).pathname);
const CLAUDE = process.env.AGENT_BENCH_CLAUDE ?? `${process.env.HOME}/.local/bin/claude`;
const ALLOWED_PORT = "57291";

// ---------- args ----------
const argv = process.argv.slice(2);
const arg = (name: string, dflt?: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };

// ---------- small utils ----------
type V3 = [number, number, number];
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const near = (a: number, b: number, tol = 0.05) => Math.abs(a - b) <= tol;
const median = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const sum = (xs: number[]) => xs.reduce((t, v) => t + v, 0);
const byteLen = (v: unknown) => Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v));

// ---------- MCP session (fresh server process from the given tree) ----------
type Check = { check: string; ok: boolean; soft?: boolean; expected?: unknown; actual?: unknown };
type Status = { targetId: string; revision: string; undoDepth: number; redoDepth: number; bodies: Array<{ id: number; name: string; type: string; boundsMm: { min: number[]; max: number[] }; faceCount: number; edgeCount: number }> };

function serverEnv(endpoint: string, historyRoot: string): Record<string, string> {
  return {
    PLASTICITY_CDP_URL: endpoint,
    PLASTICITY_AUTO_LAUNCH: "0",
    PLASTICITY_HUD: "0",
    PLASTICITY_HUD_NOTIFY: "0",
    PLASTICITY_CONSTRUCTION_HISTORY_ROOT: historyRoot,
    PLASTICITY_CODEX_EXECUTABLE: "/nonexistent/codex",
  };
}

class Session {
  client!: Client;
  tree: string; endpoint: string; target: string; historyRoot: string; cwd: string;
  constructor(tree: string, endpoint: string, target: string, historyRoot: string, cwd: string) { this.tree = tree; this.endpoint = endpoint; this.target = target; this.historyRoot = historyRoot; this.cwd = cwd; }
  async open() {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(this.tree, "scripts/run-server.ts"), "--compact-tools"],
      env: { ...(process.env as Record<string, string>), ...serverEnv(this.endpoint, this.historyRoot) },
      cwd: this.cwd,
      stderr: "ignore",
    });
    this.client = new Client({ name: "agent-bench-verify", version: "0" });
    await this.client.connect(transport);
    return this;
  }
  async call(name: string, args: Record<string, unknown> = {}) {
    const r = await this.client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("");
    if (r.isError) throw new Error(`${name} failed: ${text.slice(0, 1500)}`);
    try { return JSON.parse(text); } catch { return text; }
  }
  async status(): Promise<Status> {
    const st = await this.call("plasticity_status", { bodyLimit: 200 });
    if (st.targetId !== this.target) throw new Error(`refusing: connected to ${st.targetId}, not ${this.target}`);
    return st;
  }
  async close() { try { await this.client.close(); } catch { /* ignore */ } }
}

async function withSession<T>(ctx: Ctx, fn: (s: Session) => Promise<T>): Promise<T> {
  const s = await new Session(ctx.tree, ctx.endpoint, ctx.target, ctx.historyRoot, ctx.emptyCwd).open();
  try { return await fn(s); } finally { await s.close(); }
}

const ids = (s: { bodies: Array<{ id: number }> }) => s.bodies.map((b) => b.id).sort((x, y) => x - y).join(",");

// Undo back to the starting depth and assert depth + body ids. Never leaves the baseline un-asserted.
async function restore(ctx: Ctx) {
  return withSession(ctx, async (s) => {
    for (let guard = 0; guard < 20; guard++) {
      const st = await s.status();
      const extra = st.undoDepth - ctx.base.undoDepth;
      if (extra <= 0) break;
      const n = Math.min(extra, 50);
      await s.call("plasticity_batch", { steps: Array.from({ length: n }, () => ({ toolName: "plasticity_undo", arguments: {} })) });
    }
    const end = await s.status();
    return { ok: end.undoDepth === ctx.base.undoDepth && ids(end) === ctx.base.ids, undoDepth: end.undoDepth, bodyCount: end.bodies.length, redoDepth: end.redoDepth };
  });
}

// ---------- deterministic builds (copied from parts.ts: part (a) for the lid scenario) ----------
type Step = { toolName: string; arguments: Record<string, unknown> };
class Steps { list: Step[] = []; add(toolName: string, args: Record<string, unknown>) { this.list.push({ toolName, arguments: args }); return this.list.length - 1; } }
const ref = (i: number, k = 0) => `$${i}.added[${k}]`;
const stepIds = (i: number) => `$${i}.result.matches[*].id`;
type EnclosureParams = { x0: number; y0: number; L: number; W: number; H: number; t: number; rOut: number; chamfer: number; bossOd: number; pilotD: number; pilotDepth: number; lipDepth: number; open: { w: number; h: number; r: number } };
const A: EnclosureParams = { x0: 2000, y0: 0, L: 80, W: 50, H: 25, t: 2, rOut: 3, chamfer: 1, bossOd: 6, pilotD: 2.5, pilotDepth: 8, lipDepth: 1.5, open: { w: 12, h: 6, r: 2 } };
const E: EnclosureParams = { ...A, L: 100, W: 60, H: 30, t: 2.5 };
function bossCenters(p: EnclosureParams): Array<[number, number]> {
  const off = p.t + p.bossOd / 2 - 0.5;
  return [[p.x0 + off, p.y0 + off], [p.x0 + p.L - off, p.y0 + off], [p.x0 + off, p.y0 + p.W - off], [p.x0 + p.L - off, p.y0 + p.W - off]].map(([x, y]) => [r3(x!), r3(y!)]) as Array<[number, number]>;
}
function enclosureCompact(p: EnclosureParams) {
  const s = new Steps();
  const box = s.add("plasticity_create_box", { originMm: [p.x0, p.y0, 0], sizeMm: [p.L, p.W, p.H], name: "enclosure-base" });
  const B = ref(box);
  const v = s.add("plasticity_find_edges", { query: { bodyIds: [B], line: true, direction: { vector: [0, 0, 1] } } });
  s.add("plasticity_fillet", { id: B, edgeIds: stepIds(v), radiusMm: p.rOut });
  const top = s.add("plasticity_find_faces", { query: { bodyIds: [B], planar: true, normal: { vector: [0, 0, 1] } } });
  const te = s.add("plasticity_find_edges", { query: { bodyIds: [B], adjacentFaceIds: [`$${top}.result.matches[0].id`] } });
  s.add("plasticity_chamfer", { id: B, edgeIds: stepIds(te), distanceMm: p.chamfer });
  const inner = s.add("plasticity_create_box", { originMm: [p.x0 + p.t, p.y0 + p.t, p.t], sizeMm: [p.L - 2 * p.t, p.W - 2 * p.t, p.H] });
  const iv = s.add("plasticity_find_edges", { query: { bodyIds: [ref(inner)], line: true, direction: { vector: [0, 0, 1] } } });
  s.add("plasticity_fillet", { id: ref(inner), edgeIds: stepIds(iv), radiusMm: p.rOut - p.t });
  s.add("plasticity_boolean", { targetIds: [B], toolIds: [ref(inner)], operation: "difference" });
  const centers = bossCenters(p);
  const bossTop = p.H - p.lipDepth - 0.5;
  const bosses = centers.map(([x, y]) => s.add("plasticity_create_cylinder", { centerMm: [x, y, p.t - 0.5], radiusMm: p.bossOd / 2, heightMm: r3(bossTop - (p.t - 0.5)) }));
  s.add("plasticity_boolean", { targetIds: [B], toolIds: bosses.map((i) => ref(i)), operation: "union" });
  const pilots = centers.map(([x, y]) => s.add("plasticity_create_cylinder", { centerMm: [x, y, r3(bossTop - p.pilotDepth)], radiusMm: p.pilotD / 2, heightMm: p.pilotDepth + 0.5 }));
  s.add("plasticity_boolean", { targetIds: [B], toolIds: pilots.map((i) => ref(i)), operation: "difference" });
  const zc = r3(p.t + (bossTop - p.t) / 2);
  const cut = s.add("plasticity_create_box", { originMm: [r3(p.x0 + p.L / 2 - p.open.w / 2), p.y0 - 0.5, r3(zc - p.open.h / 2)], sizeMm: [p.open.w, p.t + 1, p.open.h] });
  const ce = s.add("plasticity_find_edges", { query: { bodyIds: [ref(cut)], line: true, direction: { vector: [0, 1, 0] } } });
  s.add("plasticity_fillet", { id: ref(cut), edgeIds: stepIds(ce), radiusMm: p.open.r });
  s.add("plasticity_boolean", { targetIds: [B], toolIds: [ref(cut)], operation: "difference" });
  return s.list;
}

// ---------- verification checks (read-back, from the harness, not the model) ----------
type Face = { bodyId: number; id: string; surfaceType: string; planar: boolean; centerMm: number[]; normal: number[] | null; radiusMm: number | null; axisOriginMm: number[] | null; axisDirection: number[] | null; boundsMm: { min: number[]; max: number[] } };
const alongAxis = (f: Face, k: number) => !!f.axisDirection && Math.abs(f.axisDirection[k]!) > 0.99;
const isCyl = (f: Face) => f.surfaceType === "Cylinder" && f.radiusMm != null && !!f.axisOriginMm && !!f.axisDirection;
// One hole/fillet can be split into several faces: dedupe by radius + axis position off the axis direction.
function uniqueCyl(faces: Face[], axis: number, rmin: number, rmax: number) {
  const seen = new Map<string, Face>();
  for (const f of faces) {
    if (!isCyl(f) || !alongAxis(f, axis) || f.radiusMm! < rmin || f.radiusMm! > rmax) continue;
    const o = f.axisOriginMm!.filter((_, i) => i !== axis).map((v) => Math.round(v / 0.05) * 0.05);
    seen.set(`${r3(f.radiusMm!)}|${o.map((v) => r3(v)).join(",")}`, f);
  }
  return [...seen.values()];
}
const planeAt = (faces: Face[], axis: number, value: number, tol = 0.06) => faces.filter((f) => f.planar && f.normal && Math.abs(f.normal[axis]!) > 0.99 && Math.abs(f.centerMm[axis]! - value) <= tol);
const bnd = (label: string, got: { min: number[]; max: number[] }, min: number[], max: number[], tol = 0.06): Check => ({ check: `${label} bounds`, ok: min.every((v, i) => near(got.min[i]!, v, tol)) && max.every((v, i) => near(got.max[i]!, v, tol)), expected: { min, max }, actual: { min: got.min.map(r3), max: got.max.map(r3) } });

function enclosureChecks(faces: Face[], bounds: { min: number[]; max: number[] }, p: EnclosureParams): Check[] {
  const out: Check[] = [bnd("enclosure", bounds, [p.x0, p.y0, 0], [p.x0 + p.L, p.y0 + p.W, p.H])];
  const wallSpots: Array<[number, number]> = [[0, p.x0 + p.t], [0, p.x0 + p.L - p.t], [1, p.y0 + p.t], [1, p.y0 + p.W - p.t]];
  const walls = wallSpots.map(([ax, v]) => planeAt(faces, ax, v).length > 0);
  out.push({ check: `inner wall faces at ${p.t} mm (x lo/hi, y lo/hi)`, ok: walls.every(Boolean), actual: walls });
  out.push({ check: "cavity floor present (open top proxy)", ok: faces.some((f) => f.planar && f.normal && f.normal[2]! > 0.99 && f.centerMm[2]! > 0.9 && f.centerMm[2]! < 6 && f.boundsMm.max[0]! - f.boundsMm.min[0]! > p.L * 0.3) });
  // outer vertical fillets r3 on the four outer corners
  const corners: Array<[number, number]> = [[p.x0 + 3, p.y0 + 3], [p.x0 + p.L - 3, p.y0 + 3], [p.x0 + 3, p.y0 + p.W - 3], [p.x0 + p.L - 3, p.y0 + p.W - 3]];
  const fil = uniqueCyl(faces, 2, 2.95, 3.05);
  const okFil = corners.every(([x, y]) => fil.some((f) => near(f.axisOriginMm![0]!, x, 0.1) && near(f.axisOriginMm![1]!, y, 0.1)));
  out.push({ check: "3 mm outer vertical corner fillets (4 corners)", ok: okFil, actual: fil.map((f) => [r3(f.axisOriginMm![0]!), r3(f.axisOriginMm![1]!)]) });
  // pilot holes: z-axis cylinders r 1.0..1.75 inside each corner zone
  // r >= 1.1: the inner vertical corner fillets of a 3 mm outer / 2 mm wall box are r1.0 and must not count as pilots.
  const pil = uniqueCyl(faces, 2, 1.1, 1.75);
  const zone = (cx: number, cy: number) => pil.filter((f) => Math.abs(f.axisOriginMm![0]! - cx) < 14 && Math.abs(f.axisOriginMm![1]! - cy) < 14);
  const zones = [[p.x0, p.y0], [p.x0 + p.L, p.y0], [p.x0, p.y0 + p.W], [p.x0 + p.L, p.y0 + p.W]].map(([cx, cy]) => zone(cx!, cy!).length >= 1);
  out.push({ check: "4 pilot holes, one per inside corner (M3, r 1.1-1.75)", ok: zones.every(Boolean) && pil.length === 4, actual: pil.map((f) => [r3(f.axisOriginMm![0]!), r3(f.axisOriginMm![1]!), r3(f.radiusMm!)]) });
  const exact = bossCenters(p);
  out.push({ check: "pilot axes equal the reference build positions (informational)", soft: true, ok: exact.every(([x, y]) => pil.some((f) => near(f.axisOriginMm![0]!, x, 0.05) && near(f.axisOriginMm![1]!, y, 0.05))) });
  // connector opening: cylinders along y near the middle of the front wall
  const oc = faces.filter((f) => isCyl(f) && alongAxis(f, 1) && f.radiusMm! <= 3.05 && Math.abs(f.centerMm[0]! - (p.x0 + p.L / 2)) < 9 && f.centerMm[1]! > p.y0 - 0.2 && f.centerMm[1]! < p.y0 + p.t + 0.2);
  if (oc.length >= 2) {
    const xmin = Math.min(...oc.map((f) => f.boundsMm.min[0]!)), xmax = Math.max(...oc.map((f) => f.boundsMm.max[0]!));
    const zmin = Math.min(...oc.map((f) => f.boundsMm.min[2]!)), zmax = Math.max(...oc.map((f) => f.boundsMm.max[2]!));
    out.push({ check: "12 x 6 rounded connector opening in the front wall", ok: near(xmax - xmin, 12, 0.4) && near(zmax - zmin, 6, 0.4) && near((xmin + xmax) / 2, p.x0 + p.L / 2, 1.0), actual: { w: r3(xmax - xmin), h: r3(zmax - zmin), cx: r3((xmin + xmax) / 2), corners: oc.length } });
  } else out.push({ check: "12 x 6 rounded connector opening in the front wall", ok: false, actual: `${oc.length} rounded-corner faces found in the front wall` });
  // 1 mm chamfer on the top outer rim: a planar face tilted 30-70 deg from the top, ~1 mm tall, ending at the top
  const ch = faces.filter((f) => f.planar && f.normal && Math.abs(f.normal[2]!) > 0.3 && Math.abs(f.normal[2]!) < 0.95 && near(f.boundsMm.max[2]!, p.H, 0.06) && near(f.boundsMm.max[2]! - f.boundsMm.min[2]!, 1, 0.12));
  out.push({ check: "1 mm chamfer on the top outer rim", ok: ch.length >= 2, actual: ch.length });
  return out;
}

function bracketChecks(faces: Face[], bounds: { min: number[]; max: number[] }): Check[] {
  const x0 = 2200;
  const out: Check[] = [bnd("bracket", bounds, [x0, 0, 0], [x0 + 40, 30, 40])];
  out.push({ check: "4 mm thickness (base top z=4, vertical leg inner face x=2204)", ok: planeAt(faces, 2, 4).length > 0 && planeAt(faces, 0, x0 + 4).length > 0 });
  const hz = uniqueCyl(faces, 2, 2.22, 2.28), hx = uniqueCyl(faces, 0, 2.22, 2.28);
  out.push({ check: "two O4.5 through holes in the base leg (axis z)", ok: hz.length === 2, actual: hz.length });
  out.push({ check: "two O4.5 through holes in the vertical leg (axis x)", ok: hx.length === 2, actual: hx.length });
  out.push({ check: "5 mm inner bend fillet (cylinder r5, axis y)", ok: uniqueCyl(faces, 1, 4.95, 5.05).length >= 1 });
  const r3s = [0, 1, 2].flatMap((k) => uniqueCyl(faces, k, 2.95, 3.05));
  out.push({ check: "3 mm outer corner rounds (>= 2 faces r3)", ok: r3s.length >= 2, actual: r3s.length });
  const gus = faces.filter((f) => f.planar && f.normal && Math.abs(f.normal[1]!) > 0.99 && f.centerMm[1]! > 1 && f.centerMm[1]! < 29);
  out.push({ check: "triangular gusset (planar y-normal faces inside the width)", ok: gus.length >= 2, actual: gus.length });
  return out;
}

function flangeChecks(faces: Face[], bounds: { min: number[]; max: number[] }): Check[] {
  const cx = 2450, cy = 30;
  const out: Check[] = [bnd("flange", bounds, [cx - 30, cy - 30, 0], [cx + 30, cy + 30, 6])];
  const bore = uniqueCyl(faces, 2, 9.95, 10.05).filter((f) => near(f.axisOriginMm![0]!, cx, 0.1) && near(f.axisOriginMm![1]!, cy, 0.1));
  out.push({ check: "O20 bore at the centre", ok: bore.length >= 1 });
  const holes = uniqueCyl(faces, 2, 2.47, 2.53);
  const rad = holes.map((f) => Math.hypot(f.axisOriginMm![0]! - cx, f.axisOriginMm![1]! - cy));
  const ang = holes.map((f) => (Math.atan2(f.axisOriginMm![1]! - cy, f.axisOriginMm![0]! - cx) * 180) / Math.PI).sort((a, b) => a - b);
  const gaps = ang.map((a, i) => ((ang[(i + 1) % ang.length]! - a + 360) % 360));
  out.push({ check: "six O5 holes on the O45 bolt circle, 60 deg apart", ok: holes.length === 6 && rad.every((r) => near(r, 22.5, 0.05)) && gaps.every((g) => near(g, 60, 1)), actual: { n: holes.length, radii: rad.map(r3), gaps: gaps.map(r3) } });
  const cones = faces.filter((f) => f.surfaceType !== "Plane" && f.surfaceType !== "Cylinder");
  out.push({ check: "1 mm edge chamfers (>= 4 conical faces)", ok: cones.length >= 4, actual: cones.length });
  return out;
}

function lidChecks(faces: Face[], bounds: { min: number[]; max: number[] }, interference: unknown, baseNow: { faceCount: number; bounds: { min: number[]; max: number[] } }, baseBefore: { faceCount: number; bounds: { min: number[]; max: number[] } }): Check[] {
  const out: Check[] = [bnd("lid", bounds, [A.x0, A.y0, A.H - A.lipDepth], [A.x0 + A.L, A.y0 + A.W, A.H + 2], 0.1)];
  const lip: Array<[number, number]> = [[0, A.x0 + A.t + 0.2], [0, A.x0 + A.L - A.t - 0.2], [1, A.y0 + A.t + 0.2], [1, A.y0 + A.W - A.t - 0.2]];
  const l = lip.map(([ax, v]) => planeAt(faces, ax, v, 0.06).length > 0);
  out.push({ check: "lip outer faces at 0.2 mm clearance from the inside walls (x lo/hi, y lo/hi)", ok: l.every(Boolean), actual: l });
  const holes = uniqueCyl(faces, 2, 1.2, 2.2);
  const want = bossCenters(A);
  out.push({ check: "4 screw holes coaxial with the boss pilots (+-0.25 mm)", ok: want.every(([x, y]) => holes.some((f) => near(f.axisOriginMm![0]!, x, 0.25) && near(f.axisOriginMm![1]!, y, 0.25))), actual: holes.map((f) => [r3(f.axisOriginMm![0]!), r3(f.axisOriginMm![1]!), r3(f.radiusMm!)]) });
  const cones = faces.filter((f) => f.surfaceType === "Cone");
  out.push({ check: "countersinks (>= 4 conical faces)", ok: cones.length >= 4, actual: cones.length });
  const st = JSON.stringify(interference ?? "");
  out.push({ check: "lid-base interference: none", ok: st.includes("no-volumetric-interference"), actual: st.slice(0, 300) });
  out.push({ check: "base unchanged (face count and bounds)", ok: baseNow.faceCount === baseBefore.faceCount && JSON.stringify(baseNow.bounds.min.map(r3)) === JSON.stringify(baseBefore.bounds.min.map(r3)) && JSON.stringify(baseNow.bounds.max.map(r3)) === JSON.stringify(baseBefore.bounds.max.map(r3)), actual: { before: baseBefore.faceCount, now: baseNow.faceCount } });
  return out;
}

// ---------- run context ----------
type Ctx = { tree: string; endpoint: string; target: string; historyRoot: string; emptyCwd: string; base: { undoDepth: number; ids: string; bodyCount: number } };
type ToolCall = { turn: number; name: string; routedTo?: string; reqBytes: number; respBytes: number; isError: boolean; startedMs: number; execMs: number | null; errorText?: string };

// ---------- the model run ----------
async function runClaude(ctx: Ctx, prompt: string, model: string | undefined, timeoutS: number, maxTurns: number, transcriptPath: string) {
  const dir = mkdtempSync(join(tmpdir(), "agent-bench-run-"));
  const cwd = join(dir, "cwd"); mkdirSync(cwd);
  const cfg = join(dir, "mcp.json");
  writeFileSync(cfg, JSON.stringify({ mcpServers: { plasticity: { command: process.execPath, args: [join(ctx.tree, "scripts/run-server.ts"), "--compact-tools"], env: serverEnv(ctx.endpoint, ctx.historyRoot) } } }));
  const args = ["-p", prompt, "--mcp-config", cfg, "--strict-mcp-config", "--output-format", "stream-json", "--verbose", "--tools", "", "--allowedTools", "mcp__plasticity", "--setting-sources", "", "--permission-mode", "dontAsk", "--max-turns", String(maxTurns), "--disable-slash-commands", "--no-session-persistence", ...(model ? ["--model", model] : [])];
  const commandLine = ["claude", ...args.map((a) => (a === prompt ? JSON.stringify("<prompt>") : /[\s"]/.test(a) || a === "" ? JSON.stringify(a) : a))].join(" ");
  const t0 = performance.now();
  const child: ChildProcess = spawn(CLAUDE, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: process.env });
  const lines: Array<{ t: number; e: any }> = [];
  let buf = ""; let stderr = ""; let timedOut = false;
  child.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try { lines.push({ t: performance.now() - t0, e: JSON.parse(line) }); } catch { /* ignore */ }
    }
  });
  child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });
  const killGroup = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } };
  const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutS * 1000);
  const exit: number | null = await new Promise((res) => child.on("close", (c) => res(c)));
  clearTimeout(timer);
  const wallMs = performance.now() - t0;
  killGroup(); // reap any MCP server child left in the process group before verification starts
  await new Promise((r) => setTimeout(r, 400));
  rmSync(dir, { recursive: true, force: true });

  // Persist a scrubbed transcript (drop init/rate-limit events: they carry local paths and account usage).
  const keep = lines.filter(({ e }) => !(e.type === "system" && e.subtype === "init") && e.type !== "rate_limit_event");
  writeFileSync(transcriptPath, keep.map(({ t, e }) => JSON.stringify({ tMs: Math.round(t), ...e })).join("\n") + "\n");
  return { lines, wallMs, exit, timedOut, stderr: stderr.slice(0, 2000), commandLine };
}

// ---------- stream-json analysis ----------
function analyze(lines: Array<{ t: number; e: any }>, wallMs: number) {
  const initT = lines.find((l) => l.e.type === "system" && l.e.subtype === "init")?.t ?? 0;
  const msgs = new Map<string, { firstT: number; lastT: number; toolUses: Array<{ id: string; name: string; input: any }>; textBlocks: string[]; thinkingChars: number }>();
  const order: string[] = [];
  const results = new Map<string, { t: number; isError: boolean; bytes: number; text: string }>();
  let lastUserT = initT; const turnBoundary = new Map<string, number>();
  for (const { t, e } of lines) {
    if (e.type === "assistant" && e.message?.id) {
      const id = e.message.id as string;
      if (!msgs.has(id)) { msgs.set(id, { firstT: t, lastT: t, toolUses: [], textBlocks: [], thinkingChars: 0 }); order.push(id); turnBoundary.set(id, lastUserT); }
      const m = msgs.get(id)!; m.lastT = t;
      for (const b of e.message.content ?? []) {
        if (b.type === "tool_use") m.toolUses.push({ id: b.id, name: b.name, input: b.input });
        else if (b.type === "text") m.textBlocks.push(b.text);
        else if (b.type === "thinking") m.thinkingChars += (b.thinking ?? "").length;
      }
    } else if (e.type === "user") {
      const content = e.message?.content;
      if (Array.isArray(content)) for (const b of content) if (b.type === "tool_result") {
        const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((p: any) => p.text ?? "").join("") : JSON.stringify(b.content ?? "");
        results.set(b.tool_use_id, { t, isError: b.is_error === true, bytes: Buffer.byteLength(text), text });
        lastUserT = t;
      }
    }
  }
  const resultEvent = lines.map((l) => l.e).reverse().find((e) => e.type === "result");
  const iterations: Array<{ input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }> = resultEvent?.usage?.iterations ?? [];
  const calls: ToolCall[] = [];
  order.forEach((id, turnIdx) => {
    for (const u of msgs.get(id)!.toolUses) {
      const r = results.get(u.id);
      const routed = u.name.endsWith("plasticity_call") ? String(u.input?.toolName ?? "") : u.name.endsWith("plasticity_batch") ? `batch(${Array.isArray(u.input?.steps) ? u.input.steps.length : "?"} steps)` : undefined;
      calls.push({ turn: turnIdx + 1, name: u.name.replace("mcp__plasticity__", ""), ...(routed ? { routedTo: routed } : {}), reqBytes: byteLen(u.input ?? {}), respBytes: r?.bytes ?? 0, isError: r?.isError ?? false, startedMs: Math.round(msgs.get(id)!.lastT), execMs: r ? Math.round(r.t - msgs.get(id)!.lastT) : null, ...(r?.isError ? { errorText: r.text.slice(0, 400) } : {}) });
    }
  });
  const firstTool = calls[0];
  // Per-turn model latency: previous tool result (or init) to the last event of this assistant message.
  const turns = order.map((id, i) => {
    const m = msgs.get(id)!;
    const it = iterations.length === order.length ? iterations[i] : undefined;
    return { turn: i + 1, modelMs: Math.round(m.lastT - turnBoundary.get(id)!), outputTokens: it?.output_tokens ?? null, inputTokens: it?.input_tokens ?? null, cacheRead: it?.cache_read_input_tokens ?? null, cacheWrite: it?.cache_creation_input_tokens ?? null, toolCalls: m.toolUses.length, thinkingChars: m.thinkingChars, textChars: sum(m.textBlocks.map((s) => s.length)) };
  });
  // Errors and retries: an error result followed by any later tool call.
  let errors = 0, retries = 0;
  const flat = calls;
  flat.forEach((c, i) => { if (c.isError) { errors += 1; if (flat.slice(i + 1).some((n) => n.turn > c.turn)) retries += 1; } });
  const u = resultEvent?.usage ?? {};
  const tokensKnown = turns.every((t) => t.outputTokens != null);
  return {
    wallMs: Math.round(wallMs),
    startupMs: Math.round(initT),
    timeToFirstToolMs: firstTool ? Math.round(msgs.get(order[firstTool.turn - 1]!)!.lastT) : null,
    turns: order.length,
    toolCalls: calls.length,
    errors, retries,
    calls,
    perTurn: turns,
    tokens: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, thinking: u.output_tokens_details?.thinking_tokens ?? null, perTurnKnown: tokensKnown },
    modelMsTotal: sum(turns.map((t) => t.modelMs)),
    apiMs: resultEvent?.duration_api_ms ?? null,
    costUsd: resultEvent?.total_cost_usd ?? null,
    resultSubtype: resultEvent?.subtype ?? null,
    isErrorResult: resultEvent?.is_error ?? null,
    terminalReason: resultEvent?.terminal_reason ?? null,
    permissionDenials: resultEvent?.permission_denials?.length ?? 0,
    model: Object.keys(resultEvent?.modelUsage ?? {})[0] ?? null,
    finalText: String(resultEvent?.result ?? "").slice(0, 600),
  };
}

// ---------- verification ----------
async function allFaces(s: Session, bodyId: number): Promise<Face[]> {
  const st = await s.status();
  const r = await s.call("plasticity_find_faces", { revision: st.revision, query: { bodyIds: [bodyId] } });
  return r.matches as Face[];
}

async function verify(ctx: Ctx, part: string, preBodies: Status["bodies"], finalText: string, baseRef?: { id: number; faceCount: number; bounds: { min: number[]; max: number[] } }) {
  return withSession(ctx, async (s) => {
    const now = await s.status();
    const before = new Set(preBodies.map((b) => b.id));
    const fresh = now.bodies.filter((b) => !before.has(b.id) && b.type === "Solid");
    const said = Number(/DONE\D*(\d+)/i.exec(finalText)?.[1] ?? NaN);
    const vol = (b: Status["bodies"][number]) => (b.boundsMm.max[0]! - b.boundsMm.min[0]!) * (b.boundsMm.max[1]! - b.boundsMm.min[1]!) * (b.boundsMm.max[2]! - b.boundsMm.min[2]!);
    let chosen = fresh.find((b) => b.id === said);
    let how = chosen ? "id from DONE line" : "";
    if (!chosen && fresh.length) { chosen = [...fresh].sort((a, b) => vol(b) - vol(a))[0]; how = "largest new solid (DONE id missing or wrong)"; }
    const checks: Check[] = [];
    checks.push({ check: "a new solid body exists", ok: !!chosen, actual: { newSolids: fresh.map((b) => b.id), said: Number.isNaN(said) ? null : said, how } });
    checks.push({ check: "DONE id names the result body", soft: true, ok: !!chosen && chosen.id === said });
    checks.push({ check: "no stray new solids (only the result)", soft: true, ok: fresh.length === 1, actual: fresh.length });
    if (!chosen) return { checks, bodyId: null };
    const faces = await allFaces(s, chosen.id);
    const bounds = chosen.boundsMm;
    if (part === "a") checks.push(...enclosureChecks(faces, bounds, A));
    else if (part === "e") checks.push(...enclosureChecks(faces, bounds, E));
    else if (part === "b") checks.push(...bracketChecks(faces, bounds));
    else if (part === "c") checks.push(...flangeChecks(faces, bounds));
    else if (part === "d") {
      const baseNow = now.bodies.find((b) => b.id === baseRef!.id);
      let interference: unknown = null;
      try {
        const r = await s.call("plasticity_batch", { steps: [{ toolName: "plasticity_check_interference", arguments: { pairs: [{ firstBodyId: chosen.id, secondBodyId: baseRef!.id }] } }] });
        interference = r.steps?.[0]?.result?.pairs ?? r.steps?.[0]?.result ?? r;
      } catch (e) { interference = `check failed: ${(e as Error).message.slice(0, 200)}`; }
      checks.push(...lidChecks(faces, bounds, interference, { faceCount: baseNow?.faceCount ?? -1, bounds: baseNow?.boundsMm ?? { min: [], max: [] } }, { faceCount: baseRef!.faceCount, bounds: baseRef!.bounds }));
    }
    return { checks, bodyId: chosen.id, faceCount: chosen.faceCount, boundsMm: bounds };
  });
}

// ---------- main bench ----------
async function bench() {
  const tree = arg("server-tree"); if (!tree) throw new Error("--server-tree is required");
  const endpoint = arg("endpoint", "http://127.0.0.1:57291")!;
  if (new URL(endpoint).port !== ALLOWED_PORT || new URL(endpoint).hostname !== "127.0.0.1") throw new Error(`refusing: endpoint must be 127.0.0.1:${ALLOWED_PORT}`);
  const target = arg("target", "E634FD207384F0F8D6EB10D2D01D46F2")!;
  const label = arg("label", "run")!;
  const model = arg("model");
  const parts = (arg("parts", "a,b,c,d,e")!).split(",").map((s) => s.trim()).filter(Boolean);
  const runs = Number(arg("runs", "1"));
  const out = arg("out", HERE)!;
  const timeoutS = Number(arg("timeout-s", "360"));
  const maxTurns = Number(arg("max-turns", "40"));
  const prompts = JSON.parse(readFileSync(join(HERE, "agent-bench-prompts.json"), "utf8"));
  mkdirSync(out, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "agent-bench-"));
  const emptyCwd = join(scratch, "cwd"); mkdirSync(emptyCwd);
  const historyRoot = join(scratch, "history"); mkdirSync(historyRoot);
  const tdir = join(out, `agent-bench-${label}-transcripts`); mkdirSync(tdir, { recursive: true });

  const ctx: Ctx = { tree, endpoint, target, historyRoot, emptyCwd, base: { undoDepth: 0, ids: "", bodyCount: 0 } };
  const start = await withSession(ctx, (s) => s.status());
  ctx.base = { undoDepth: start.undoDepth, ids: ids(start), bodyCount: start.bodies.length };
  console.error(`start: target ${start.targetId} undoDepth ${start.undoDepth} bodies ${start.bodies.length} (${ctx.base.ids}); tree ${tree}; model ${model ?? "default"}`);

  const results: any[] = [];
  const file = join(out, `agent-bench-${label}.json`);
  const flush = () => writeFileSync(file, JSON.stringify({ label, model: model ?? "default", serverTree: tree, endpoint, target, measuredAt: new Date().toISOString(), startUndoDepth: ctx.base.undoDepth, startBodyCount: ctx.base.bodyCount, runs: results }, null, 1));
  try {
    for (const part of parts) for (let run = 1; run <= runs; run++) {
      const prompt = `${prompts.parts[part]} ${prompts.closing}`;
      let baseRef: { id: number; faceCount: number; bounds: { min: number[]; max: number[] } } | undefined;
      let setupError: string | undefined;
      if (part === "d") {
        try {
          baseRef = await withSession(ctx, async (s) => {
            const r = await s.call("plasticity_batch", { steps: enclosureCompact(A), undoOnError: true });
            const b = r.change.added.find((x: { name: string }) => x.name === "enclosure-base") ?? r.change.added[0];
            return { id: b.id, faceCount: b.faceCount, bounds: b.boundsMm };
          });
        } catch (e) { setupError = (e as Error).message.slice(0, 600); }
      }
      let record: any;
      if (setupError) record = { part, run, error: `part (a) setup failed: ${setupError}` };
      else {
        const pre = await withSession(ctx, (s) => s.status());
        console.error(`[${label}] part ${part} run ${run}: starting model (${model ?? "default"})`);
        const transcript = join(tdir, `${part}-r${run}.jsonl`);
        const res = await runClaude(ctx, prompt, model, timeoutS, maxTurns, transcript);
        const a = analyze(res.lines, res.wallMs);
        let ver: Awaited<ReturnType<typeof verify>> | { checks: Check[]; error: string };
        try { ver = await verify(ctx, part, pre.bodies, a.finalText, baseRef); } catch (e) { ver = { checks: [], error: (e as Error).message.slice(0, 600) }; }
        const hard = ver.checks.filter((c) => !c.soft);
        const verified = hard.length > 0 && hard.every((c) => c.ok) && !("error" in ver);
        record = { part, run, prompt, commandLine: res.commandLine, exit: res.exit, timedOut: res.timedOut, stderr: res.stderr || undefined, ...a, verification: { verified, passed: hard.filter((c) => c.ok).length, of: hard.length, bodyId: (ver as any).bodyId ?? null, checks: ver.checks, ...("error" in ver ? { error: (ver as any).error } : {}) }, transcript: `agent-bench-${label}-transcripts/${part}-r${run}.jsonl` };
      }
      // Always restore, even after a timeout or a failure.
      let restored: Awaited<ReturnType<typeof restore>>;
      try { restored = await restore(ctx); } catch (e) { restored = { ok: false, undoDepth: -1, bodyCount: -1, redoDepth: -1, error: (e as Error).message } as never; }
      record.restored = restored;
      results.push(record); flush();
      console.error(`[${label}] part ${part} run ${run}: wall ${record.wallMs ?? "-"} ms, turns ${record.turns ?? "-"}, calls ${record.toolCalls ?? "-"}, errors ${record.errors ?? "-"}, verified ${record.verification?.verified ?? "-"} (${record.verification?.passed}/${record.verification?.of}), cost $${record.costUsd?.toFixed?.(3) ?? "-"}, restored ${JSON.stringify(restored)}`);
      if (!restored.ok) throw new Error(`document not restored after part ${part} run ${run}: ${JSON.stringify(restored)}`);
    }
  } finally {
    flush();
  }
  const finalState = await withSession(ctx, (s) => s.status());
  rmSync(scratch, { recursive: true, force: true });
  console.error(`end: undoDepth ${finalState.undoDepth} (start ${ctx.base.undoDepth}), bodies ${finalState.bodies.length} (start ${ctx.base.bodyCount})`);
  writeFileSync(join(out, `agent-bench-${label}-summary.md`), summarize([file]));
  console.log(summarize([file]));
}

// ---------- summary ----------
function summarize(files: string[]) {
  const outLines: string[] = [];
  for (const f of files) {
    const d = JSON.parse(readFileSync(f, "utf8"));
    const runs: any[] = d.runs.filter((r: any) => r.turns != null);
    outLines.push(`### ${d.label} (model ${d.model}${runs[0]?.model ? ` = ${runs[0].model}` : ""}, server tree ${String(d.serverTree).split("/").pop()})`, "");
    outLines.push("| part | runs | wall s (median) | turns | tool calls | errors / retries | output tok | input fresh / cached | cost $ | verified |");
    outLines.push("|---|---|---|---|---|---|---|---|---|---|");
    const parts = [...new Set(d.runs.map((r: any) => r.part))];
    for (const p of parts) {
      const rs = d.runs.filter((r: any) => r.part === p);
      const ok = rs.filter((r: any) => r.turns != null);
      if (!ok.length) { outLines.push(`| ${p} | ${rs.length} | - | - | - | - | - | - | - | ${rs.map((r: any) => r.error).join("; ")} |`); continue; }
      const med = (f: (r: any) => number) => median(ok.map(f));
      const v = ok.filter((r: any) => r.verification.verified).length;
      outLines.push(`| ${p} | ${ok.length} | ${(med((r) => r.wallMs) / 1000).toFixed(1)} (${ok.map((r: any) => (r.wallMs / 1000).toFixed(0)).join("/")}) | ${med((r) => r.turns)} | ${med((r) => r.toolCalls)} | ${med((r) => r.errors)} / ${med((r) => r.retries)} | ${med((r) => r.tokens.output)} | ${Math.round(med((r) => r.tokens.input))} / ${Math.round(med((r) => r.tokens.cacheRead + r.tokens.cacheWrite))} | ${med((r) => r.costUsd ?? 0).toFixed(3)} | ${v}/${ok.length} |`);
    }
    const modelMs = sum(runs.map((r: any) => r.modelMsTotal)), outTok = sum(runs.map((r: any) => r.tokens.output)), nTurns = sum(runs.map((r: any) => r.turns));
    const allCalls = runs.flatMap((r: any) => r.calls as ToolCall[]);
    // Least squares over runs: modelMsTotal = turns * T + outputTokens * k  ->  T s per turn, 1/k tok/s.
    let fit = "n/a";
    if (runs.length >= 3) {
      const xs = runs.map((r: any) => [r.turns, r.tokens.output, r.modelMsTotal / 1000]);
      const s11 = sum(xs.map((x: number[]) => x[0]! * x[0]!)), s12 = sum(xs.map((x: number[]) => x[0]! * x[1]!)), s22 = sum(xs.map((x: number[]) => x[1]! * x[1]!));
      const b1 = sum(xs.map((x: number[]) => x[0]! * x[2]!)), b2 = sum(xs.map((x: number[]) => x[1]! * x[2]!));
      const det = s11 * s22 - s12 * s12;
      if (Math.abs(det) > 1e-9) { const T = (b1 * s22 - b2 * s12) / det, k = (s11 * b2 - s12 * b1) / det; fit = `${T.toFixed(1)} s fixed per turn + ${k > 0 ? (1 / k).toFixed(0) : "n/a"} tok/s output (fit over ${runs.length} runs, thinking included in output tokens)`; }
    }
    outLines.push("");
    outLines.push(`Measured per-turn model latency: mean ${(modelMs / Math.max(1, nTurns) / 1000).toFixed(1)} s over ${nTurns} turns (median per-run mean ${(median(runs.map((r: any) => r.modelMsTotal / r.turns)) / 1000).toFixed(1)} s). Output rate: ${(outTok / (modelMs / 1000)).toFixed(0)} tok/s (all output tokens incl. thinking / total turn latency). Implied by regression: ${fit}. Thinking tokens: ${sum(runs.map((r: any) => r.tokens.thinking ?? 0))} of ${outTok} output tokens. Tool execution (server + client): median ${(median(allCalls.filter((c) => c.execMs != null).map((c) => c.execMs!)) / 1000).toFixed(2)} s per call. Startup (spawn to init): median ${(median(runs.map((r: any) => r.startupMs)) / 1000).toFixed(1)} s.`);
    outLines.push(`Audit cost model (mid): 3 s per turn, 70 tok/s output, reasoning x1.0 of output. Per-turn latency here is the whole turn (time to first token + output + reasoning), so compare it to 3 s + output_tokens x 2 / 70.`);
    outLines.push("");
  }
  return outLines.join("\n");
}

if (arg("summarize")) {
  const files = arg("summarize")!.split(",").map((f) => (f.includes("/") ? f : join(HERE, f)));
  console.log(summarize(files));
} else {
  await bench();
}
