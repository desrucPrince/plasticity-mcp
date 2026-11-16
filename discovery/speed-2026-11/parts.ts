// Part 1.2-1.4: build the five reference parts through the compact MCP server, the way a competent
// agent would today, and record turns, bytes, server time and per-step native timing.
// Usage: node discovery/speed-2026-11/parts.ts <scenario...>
//   scenarios: a1 a2 a3 b c d e scale40
// Add --tier1 to run a1 a2 b c d e the way an agent builds them once the tier-1 server work is in: detail "lean",
// `return` on verify reads, sortBy/limit instead of matches[0], recipe and check tools used directly (no catalog
// lookups). Results go to part-<name>-tier1.json; the baseline part-<name>.json files are untouched.
// --tier1b runs the same tier-1 parts with the workarounds tier 1b makes unnecessary taken out (no return: ["count"]
// on reads a later step references, no return: ["status"] on recipes, sortBy "area" for the lid's floor face) and
// writes part-<name>-tier1b.json. --tag=<t> writes part-<name>-<t>-tier1b.json instead (same-session before/after runs).
// --suffix=<s> writes part-<name>-tier1b-<s>.json (e.g. --suffix=fix1 for the state-reuse review fix runs); it works
// with --tier1b a1 and with the plain scale40 scenario. Endpoint and target: see lib.ts (SPEED_CDP_URL, SPEED_TARGET).
// --describe (with --tier1b) also reads the built body with plasticity_describe_body and plasticity_body_info after the
// scenario and writes describe-check-<name>.json (reply bytes and the describe reply itself).
// --tier1d runs the same parts the way an agent builds them once speed tier 1d is in: fillet and chamfer take edgeQuery
// (no find_edges step; the top rim is one adjacentFace query), the gusset rib uses side "centered", and the lid reads
// the base once with plasticity_describe_body (inner wall and floor planes, and hole axes). Writes part-<name>-tier1d.json.
// Each scenario restores the document to the starting undo depth and body ids and asserts it.
import { bytes, ENDPOINT, openInProcess, Recorder, restore, save, status } from "./lib.ts";

type V3 = [number, number, number];
type Step = { toolName: string; arguments: Record<string, unknown> };
class Steps {
  list: Array<Step & { return?: string[] }> = [];
  add(toolName: string, args: Record<string, unknown>, ret?: string[]) { this.list.push({ toolName, arguments: args, ...(ret ? { return: ret } : {}) }); return this.list.length - 1; }
}
const ref = (i: number, k = 0) => `$${i}.added[${k}]`;
const T1D = process.argv.includes("--tier1d");
const T1B = process.argv.includes("--tier1b") || T1D;
// A tier-1 return list that only kept the reply small; tier 1b's lean replies make it unnecessary.
const workaround = (paths: string[]) => (T1B ? undefined : paths);
const ids = (i: number) => `$${i}.result.matches[*].id`;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

// ---------- Part (a)/(e): enclosure base ----------
type EnclosureParams = { x0: number; y0: number; L: number; W: number; H: number; t: number; rOut: number; chamfer: number;
  bossOd: number; pilotD: number; pilotDepth: number; lipDepth: number; open: { w: number; h: number; r: number } };
const A: EnclosureParams = { x0: 2000, y0: 0, L: 80, W: 50, H: 25, t: 2, rOut: 3, chamfer: 1, bossOd: 6, pilotD: 2.5, pilotDepth: 8, lipDepth: 1.5, open: { w: 12, h: 6, r: 2 } };
const E: EnclosureParams = { ...A, L: 100, W: 60, H: 30, t: 2.5 };

function bossCenters(p: EnclosureParams): Array<[number, number]> {
  const off = p.t + p.bossOd / 2 - 0.5; // boss overlaps each wall by 0.5 mm
  return [[p.x0 + off, p.y0 + off], [p.x0 + p.L - off, p.y0 + off], [p.x0 + off, p.y0 + p.W - off], [p.x0 + p.L - off, p.y0 + p.W - off]].map(([x, y]) => [r3(x!), r3(y!)]) as Array<[number, number]>;
}

// Shell + fillets + chamfer, compact tools only. Returns the base body reference step.
function enclosureShell(s: Steps, p: EnclosureParams, t1 = false) {
  const box = s.add("plasticity_create_box", { originMm: [p.x0, p.y0, 0], sizeMm: [p.L, p.W, p.H], name: "enclosure-base" });
  const B = ref(box);
  if (T1D) {
    // Tier 1d: edgeQuery on fillet and chamfer; the top rim is one adjacentFace query (was find_faces, find_edges, chamfer).
    s.add("plasticity_fillet", { id: B, edgeQuery: { line: true, direction: { vector: [0, 0, 1] } }, radiusMm: p.rOut });
    s.add("plasticity_chamfer", { id: B, edgeQuery: { adjacentFace: { planar: true, normal: { vector: [0, 0, 1] }, sortBy: "z", order: "desc", limit: 1 } }, distanceMm: p.chamfer });
    const inner = s.add("plasticity_create_box", { originMm: [p.x0 + p.t, p.y0 + p.t, p.t], sizeMm: [p.L - 2 * p.t, p.W - 2 * p.t, p.H] });
    s.add("plasticity_fillet", { id: ref(inner), edgeQuery: { line: true, direction: { vector: [0, 0, 1] } }, radiusMm: p.rOut - p.t });
    s.add("plasticity_boolean", { targetIds: [B], toolIds: [ref(inner)], operation: "difference" });
    return { box, B };
  }
  const refOnly = t1 ? workaround(["count"]) : undefined; // a read that only feeds a later $n reference: send back just its count
  const v = s.add("plasticity_find_edges", { query: { bodyIds: [B], line: true, direction: { vector: [0, 0, 1] } } }, refOnly);
  s.add("plasticity_fillet", { id: B, edgeIds: ids(v), radiusMm: p.rOut });
  const top = s.add("plasticity_find_faces", { query: { bodyIds: [B], planar: true, normal: { vector: [0, 0, 1] } }, ...(t1 ? { sortBy: "z", order: "desc", limit: 1 } : {}) }, refOnly);
  const te = s.add("plasticity_find_edges", { query: { bodyIds: [B], adjacentFaceIds: [`$${top}.result.matches[0].id`] } }, refOnly);
  s.add("plasticity_chamfer", { id: B, edgeIds: ids(te), distanceMm: p.chamfer });
  const inner = s.add("plasticity_create_box", { originMm: [p.x0 + p.t, p.y0 + p.t, p.t], sizeMm: [p.L - 2 * p.t, p.W - 2 * p.t, p.H] });
  const iv = s.add("plasticity_find_edges", { query: { bodyIds: [ref(inner)], line: true, direction: { vector: [0, 0, 1] } } }, refOnly);
  s.add("plasticity_fillet", { id: ref(inner), edgeIds: ids(iv), radiusMm: p.rOut - p.t });
  s.add("plasticity_boolean", { targetIds: [B], toolIds: [ref(inner)], operation: "difference" });
  return { box, B };
}

function enclosureCompact(p: EnclosureParams, t1 = false) {
  const s = new Steps();
  const { box, B } = enclosureShell(s, p, t1);
  const centers = bossCenters(p);
  const bossTop = p.H - p.lipDepth - 0.5;
  const bosses = centers.map(([x, y]) => s.add("plasticity_create_cylinder", { centerMm: [x, y, p.t - 0.5], radiusMm: p.bossOd / 2, heightMm: r3(bossTop - (p.t - 0.5)) }));
  s.add("plasticity_boolean", { targetIds: [B], toolIds: bosses.map((i) => ref(i)), operation: "union" });
  const pilots = centers.map(([x, y]) => s.add("plasticity_create_cylinder", { centerMm: [x, y, r3(bossTop - p.pilotDepth)], radiusMm: p.pilotD / 2, heightMm: p.pilotDepth + 0.5 }));
  s.add("plasticity_boolean", { targetIds: [B], toolIds: pilots.map((i) => ref(i)), operation: "difference" });
  const zc = r3(p.t + (bossTop - p.t) / 2);
  const cut = s.add("plasticity_create_box", { originMm: [r3(p.x0 + p.L / 2 - p.open.w / 2), p.y0 - 0.5, r3(zc - p.open.h / 2)], sizeMm: [p.open.w, p.t + 1, p.open.h] });
  if (T1D) s.add("plasticity_fillet", { id: ref(cut), edgeQuery: { line: true, direction: { vector: [0, 1, 0] } }, radiusMm: p.open.r });
  else {
    const ce = s.add("plasticity_find_edges", { query: { bodyIds: [ref(cut)], line: true, direction: { vector: [0, 1, 0] } } }, t1 ? workaround(["count"]) : undefined);
    s.add("plasticity_fillet", { id: ref(cut), edgeIds: ids(ce), radiusMm: p.open.r });
  }
  s.add("plasticity_boolean", { targetIds: [B], toolIds: [ref(cut)], operation: "difference" });
  // Verification read appended to the same batch (compact tool).
  s.add("plasticity_find_faces", { query: { bodyIds: [B], radiusMm: { value: p.pilotD / 2 } } }, t1 ? ["matches[*].axisOriginMm"] : undefined);
  return { steps: s.list, box, zc };
}

function enclosureRecipes(p: EnclosureParams, t1 = false) {
  const s = new Steps();
  const { box, B } = enclosureShell(s, p, t1);
  const bossTop = p.H - p.lipDepth - 0.5;
  s.add("plasticity_create_screw_boss_pattern", { targetId: B, baseCentersMm: bossCenters(p).map(([x, y]) => [x, y, p.t]), axis: [0, 0, 1], outerDiameterMm: p.bossOd, heightMm: r3(bossTop - p.t), holeDiameterMm: p.pilotD, holeDepthMm: p.pilotDepth }, t1 ? workaround(["status"]) : undefined);
  const zc = r3(p.t + (bossTop - p.t) / 2);
  s.add("plasticity_create_connector_opening", { targetId: B, entryCenterMm: [p.x0 + p.L / 2, p.y0, zc], axis: [0, 1, 0], widthDirection: [1, 0, 0], widthMm: p.open.w, heightMm: p.open.h, cornerRadiusMm: p.open.r, throughDepthMm: p.t }, t1 ? workaround(["status"]) : undefined);
  s.add("plasticity_find_faces", { query: { bodyIds: [B], radiusMm: { value: p.pilotD / 2 } } }, t1 ? ["matches[*].axisOriginMm"] : undefined);
  return { steps: s.list, box, zc };
}

// ---------- assertions ----------
const near = (a: number, b: number, tol = 0.02) => Math.abs(a - b) <= tol;
function checkBounds(label: string, bounds: { min: number[]; max: number[] }, min: number[], max: number[], tol = 0.02) {
  const ok = min.every((v, i) => near(bounds.min[i]!, v, tol)) && max.every((v, i) => near(bounds.max[i]!, v, tol));
  return { check: `${label} bounds`, expected: { min, max }, actual: bounds, ok };
}
function checkAxes(label: string, matches: Array<{ axisOriginMm: number[] | null; axisDirection?: number[] | null; radiusMm: number | null }>, expectedXY: Array<[number, number]>, axisIndex: [number, number] = [0, 1]) {
  const got = matches.map((m) => [r3(m.axisOriginMm![axisIndex[0]]!), r3(m.axisOriginMm![axisIndex[1]]!)]);
  const ok = matches.length === expectedXY.length && expectedXY.every(([x, y]) => got.some(([gx, gy]) => near(gx!, x) && near(gy!, y)));
  return { check: `${label} hole axes`, expected: expectedXY, actual: got, count: matches.length, ok };
}

// ---------- scenarios ----------
type H = Awaited<ReturnType<typeof openInProcess>>;
const scenarios: Record<string, (h: H, rec: Recorder) => Promise<unknown>> = {};

async function runEnclosure(h: H, rec: Recorder, p: EnclosureParams, variant: "compact" | "recipes", turnBase = 1) {
  let turn = turnBase;
  const built = variant === "compact" ? enclosureCompact(p) : enclosureRecipes(p);
  if (variant === "recipes") {
    // Recipe schemas are not in the compact list: one turn of parallel exact-name catalog lookups.
    await rec.call(turn, "schema lookup screw_boss_pattern", "plasticity_call", { toolName: "catalog", query: "plasticity_create_screw_boss_pattern" }, { forced: "recipe tool not in compact list; needs schema lookup" });
    await rec.call(turn, "schema lookup connector_opening", "plasticity_call", { toolName: "catalog", query: "plasticity_create_connector_opening" }, { forced: "recipe tool not in compact list; needs schema lookup (parallel with previous)" });
    turn += 1;
  }
  const out = await rec.call(turn, `build enclosure (${variant}) + verify read`, "plasticity_batch", { steps: built.steps, undoOnError: true });
  const base = out.change.added.find((b: { name: string }) => b.name === "enclosure-base") ?? out.change.added[0];
  const verifyStep = out.steps[out.steps.length - 1];
  const checks: unknown[] = [checkBounds("base", base.boundsMm, [p.x0, p.y0, 0], [p.x0 + p.L, p.y0 + p.W, p.H])];
  let pilots = verifyStep.result?.matches;
  if (!pilots) {
    // Batch summarizes read results over 1,500 bytes to ids only; positions need a second call.
    turn += 1;
    const direct = await rec.call(turn, "verify pilot hole axes (batch read was truncated)", "plasticity_find_faces", { revision: out.revision, query: { bodyIds: [base.id], radiusMm: { value: p.pilotD / 2 } } }, { forced: "batch truncates read results >1500 B to ids; hole positions need a direct read" });
    pilots = direct.matches;
  }
  checks.push(checkAxes("pilot", pilots, bossCenters(p)));
  checks.push({ check: "body count added", expected: 1, actual: out.change.added.length, note: "cutters and bosses consumed", ok: out.change.added.length === 1 || variant === "recipes" });
  checks.push({ check: "face/edge counts", actual: { faces: base.faceCount, edges: base.edgeCount }, ok: base.faceCount > 30 });
  return { baseId: base.id, revision: out.revision, out, checks, steps: built.steps.length, batchReplyBytes: JSON.stringify(out).length };
}

scenarios.a1 = async (h, rec) => runEnclosure(h, rec, A, "compact");
scenarios.a2 = async (h, rec) => runEnclosure(h, rec, A, "recipes");
scenarios.e = async (h, rec) => {
  const r = await runEnclosure(h, rec, { ...E }, "compact");
  const a = JSON.stringify(enclosureCompact(A).steps);
  const e = JSON.stringify(enclosureCompact(E).steps);
  const numsA = a.match(/-?\d+(\.\d+)?/g)!; const numsE = e.match(/-?\d+(\.\d+)?/g)!;
  const changed = numsA.filter((n, i) => numsE[i] !== n).length;
  return { ...r, resend: { requestBytesA: a.length, requestBytesE: e.length, numericLiterals: numsA.length, numericLiteralsChanged: changed, sameStructure: a.replace(/-?\d+(\.\d+)?/g, "#") === e.replace(/-?\d+(\.\d+)?/g, "#") } };
};

// a3: the same part with one direct call per step (no batch). Gives per-step PLASTICITY_TIMING
// marks and the direct-edit response anatomy. Not how a competent agent works; it is the "no batch" baseline.
scenarios.a3 = async (h, rec) => {
  const { steps } = enclosureCompact(A);
  const outputs: Array<Record<string, any>> = [];
  let revision = (await status(h)).revision;
  let turn = 1;
  const resolve = (value: unknown): unknown => {
    if (typeof value === "string") {
      const m = /^\$(\d+)\.added\[(\d+)\]$/.exec(value);
      if (m) return outputs[+m[1]!]!.change.added[+m[2]!].id;
      const r = /^\$(\d+)\.result\.matches\[(\*|\d+)\]\.id$/.exec(value);
      if (r) { const ms = outputs[+r[1]!]!.matches.map((x: { id: string }) => x.id); return r[2] === "*" ? ms : ms[+r[2]!]; }
      return value;
    }
    if (Array.isArray(value)) return value.flatMap((v) => { const x = resolve(v); return typeof v === "string" && Array.isArray(x) ? x : [x]; });
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]));
    return value;
  };
  for (const step of steps) {
    const args = { ...(resolve(step.arguments) as Record<string, unknown>), revision };
    const out = await rec.call(turn++, `direct ${step.toolName}`, step.toolName, args);
    outputs.push(out);
    if (out.revision) revision = out.revision;
  }
  return { directCalls: steps.length };
};

// ---------- Part (b): L-bracket ----------
scenarios.b = async (h, rec) => {
  const x0 = 2200, t = 4, Lb = 40, Lv = 40, Wd = 30;
  await rec.call(1, "schema lookup create_rib", "plasticity_call", { toolName: "catalog", query: "plasticity_create_rib" }, { forced: "gusset needs create_rib (not in compact list); schema lookup" });
  const s = new Steps();
  const base = s.add("plasticity_create_box", { originMm: [x0, 0, 0], sizeMm: [Lb, Wd, t], name: "l-bracket" });
  const B = ref(base);
  const vert = s.add("plasticity_create_box", { originMm: [x0, 0, 0], sizeMm: [t, Wd, Lv] });
  s.add("plasticity_boolean", { targetIds: [B], toolIds: [ref(vert)], operation: "union" });
  const bend = s.add("plasticity_find_edges", { query: { bodyIds: [B], line: true, center: { pointMm: [x0 + t, Wd / 2, t] } } });
  s.add("plasticity_fillet", { id: B, edgeIds: ids(bend), radiusMm: 5 });
  const tipA = s.add("plasticity_find_edges", { query: { bodyIds: [B], line: true, direction: { vector: [0, 0, 1] }, boundsMm: { min: [x0 + Lb - 0.01, -1, -1], max: [x0 + Lb + 0.01, Wd + 1, t + 1] } } });
  const tipB = s.add("plasticity_find_edges", { query: { bodyIds: [B], line: true, direction: { vector: [1, 0, 0] }, boundsMm: { min: [x0 - 1, -1, Lv - 0.01], max: [x0 + t + 1, Wd + 1, Lv + 0.01] } } });
  s.add("plasticity_fillet", { id: B, edgeIds: [ids(tipA), ids(tipB)], radiusMm: 3 });
  const gy = Wd / 2 - t / 2;
  s.add("plasticity_create_rib", { targetId: B, profilePointsMm: [[x0 + t - 0.5, gy, t - 0.5], [x0 + t + 25, gy, t - 0.5], [x0 + t - 0.5, gy, t + 25]], thicknessMm: t });
  const holesBase = [[x0 + 26, 7.5], [x0 + 26, 22.5]] as Array<[number, number]>;
  const holesVert = [[7.5, 26], [22.5, 26]] as Array<[number, number]>; // (y, z)
  const hb = holesBase.map(([x, y]) => s.add("plasticity_create_cylinder", { centerMm: [x, y, -0.5], radiusMm: 2.25, heightMm: t + 1 }));
  const hv = holesVert.map(([y, z]) => s.add("plasticity_create_cylinder", { centerMm: [x0 - 0.5, y, z], radiusMm: 2.25, heightMm: t + 1, axis: [1, 0, 0] }));
  s.add("plasticity_boolean", { targetIds: [B], toolIds: [...hb, ...hv].map((i) => ref(i)), operation: "difference" });
  s.add("plasticity_find_faces", { query: { bodyIds: [B], radiusMm: { value: 2.25 } } });
  const out = await rec.call(2, "build L-bracket + verify read", "plasticity_batch", { steps: s.list, undoOnError: true });
  const body = out.change.added.find((b: { name: string }) => b.name === "l-bracket") ?? out.change.added[0];
  let holes = out.steps[out.steps.length - 1].result?.matches;
  let turn = 3;
  if (!holes) holes = (await rec.call(turn++, "verify hole axes (batch read truncated)", "plasticity_find_faces", { revision: out.revision, query: { bodyIds: [body.id], radiusMm: { value: 2.25 } } }, { forced: "batch truncates read results >1500 B; hole positions need a direct read" })).matches;
  const zHoles = holes.filter((m: { axisDirection: number[] }) => Math.abs(m.axisDirection[2]!) > 0.9);
  const xHoles = holes.filter((m: { axisDirection: number[] }) => Math.abs(m.axisDirection[0]!) > 0.9);
  const checks = [
    checkBounds("bracket", body.boundsMm, [x0, 0, 0], [x0 + Lb, Wd, Lv]),
    checkAxes("base-leg", zHoles, holesBase),
    checkAxes("vertical-leg", xHoles, holesVert, [1, 2]),
    { check: "blend faces r5 and r3 present", ok: undefined as boolean | undefined },
  ];
  const blends = await rec.call(turn, "verify fillet radii (r5 bend, r3 tips)", "plasticity_find_faces", { revision: out.revision, query: { bodyIds: [body.id], surfaceTypes: ["Cylinder"] } }, { forced: "fillet radii are not in the batch reply; separate read" });
  const radii = blends.matches.map((m: { radiusMm: number }) => r3(m.radiusMm));
  // The gusset crosses the r5 bend fillet, so that blend is split into two faces.
  checks[3] = { check: "cylindrical faces radii (expect r5 bend x2 split by gusset, r3 tips x4, r2.25 holes x4)", actual: radii, ok: radii.filter((r: number) => near(r, 5)).length === 2 && radii.filter((r: number) => near(r, 3)).length === 4 && radii.filter((r: number) => near(r, 2.25)).length === 4 } as never;
  return { bodyId: body.id, faceCount: body.faceCount, checks, steps: s.list.length };
};

// ---------- Part (c): flange ----------
scenarios.c = async (h, rec) => {
  const cx = 2450, cy = 30, R = 30, T = 6, bore = 10, bc = 22.5, hole = 2.5;
  const s = new Steps();
  const disc = s.add("plasticity_create_cylinder", { centerMm: [cx, cy, 0], radiusMm: R, heightMm: T, name: "flange" });
  const B = ref(disc);
  const b = s.add("plasticity_create_cylinder", { centerMm: [cx, cy, -0.5], radiusMm: bore, heightMm: T + 1 });
  const centers = Array.from({ length: 6 }, (_, i) => [r3(cx + bc * Math.cos(i * Math.PI / 3)), r3(cy + bc * Math.sin(i * Math.PI / 3))] as [number, number]);
  const hs = centers.map(([x, y]) => s.add("plasticity_create_cylinder", { centerMm: [x, y, -0.5], radiusMm: hole, heightMm: T + 1 }));
  s.add("plasticity_boolean", { targetIds: [B], toolIds: [b, ...hs].map((i) => ref(i)), operation: "difference" });
  const outer = s.add("plasticity_find_edges", { query: { bodyIds: [B], circle: true, lengthMm: { value: r3(2 * Math.PI * R), tolerance: 0.01 } } });
  const inner = s.add("plasticity_find_edges", { query: { bodyIds: [B], circle: true, lengthMm: { value: r3(2 * Math.PI * bore), tolerance: 0.01 } } });
  s.add("plasticity_chamfer", { id: B, edgeIds: [ids(outer), ids(inner)], distanceMm: 1 });
  s.add("plasticity_find_faces", { query: { bodyIds: [B], radiusMm: { value: hole } } });
  const out = await rec.call(1, "build flange + verify read", "plasticity_batch", { steps: s.list, undoOnError: true });
  const body = out.change.added.find((x: { name: string }) => x.name === "flange") ?? out.change.added[0];
  let holes = out.steps[out.steps.length - 1].result?.matches;
  if (!holes) holes = (await rec.call(2, "verify bolt-circle axes (batch read truncated)", "plasticity_find_faces", { revision: out.revision, query: { bodyIds: [body.id], radiusMm: { value: hole } } }, { forced: "batch truncates read results >1500 B; hole positions need a direct read" })).matches;
  return { bodyId: body.id, faceCount: body.faceCount, edgeCount: body.edgeCount, steps: s.list.length, checks: [
    checkBounds("flange", body.boundsMm, [cx - R, cy - R, 0], [cx + R, cy + R, T]),
    checkAxes("bolt-circle", holes, centers),
    { check: "chamfered edges", note: "4 circular edges chamfered 1 mm (outer and bore, top and bottom)", outerMatches: out.steps[s.list.length - 4]?.result?.count, innerMatches: out.steps[s.list.length - 3]?.result?.count, ok: out.steps[s.list.length - 4]?.result?.count === 2 && out.steps[s.list.length - 3]?.result?.count === 2 },
  ] };
};

// ---------- Part (d): lid derived from (a) ----------
scenarios.d = async (h, rec) => {
  // Setup (not counted): part (a) exists, as if built earlier or imported.
  const setup = new Recorder(h, "d-setup");
  const a = await runEnclosure(h, setup, A, "compact");
  const baseId = a.baseId;
  const rev0 = a.revision;
  // Turn 1: read what the lid must fit (parallel direct reads) + schemas for the two fit checks.
  const floor = await rec.call(1, "read cavity floor face (inner extents)", "plasticity_find_faces", { revision: rev0, query: { bodyIds: [baseId], planar: true, normal: { vector: [0, 0, 1] }, boundsMm: { min: [-1e6, -1e6, A.t - 0.01], max: [1e6, 1e6, A.t + 0.01] } } }, { forced: "lid dimensions must come from (a) geometry; batch has no arithmetic on read results" });
  const pilots = await rec.call(1, "read boss pilot axes", "plasticity_find_faces", { revision: rev0, query: { bodyIds: [baseId], radiusMm: { value: A.pilotD / 2 } } }, { forced: "hole transfer needs boss axes from (a)" });
  await rec.call(1, "schema check_interference", "plasticity_call", { toolName: "catalog", query: "plasticity_check_interference" }, { forced: "fit check tool not in compact list" });
  await rec.call(1, "schema parallel face clearance", "plasticity_call", { toolName: "catalog", query: "plasticity_measure_parallel_planar_face_clearance" }, { forced: "clearance tool not in compact list" });
  // The model now does the arithmetic itself (this is the work candidate 3/10 would move server-side).
  // The floor is split: bosses that overlap the walls leave small z=2 fragments in each corner.
  // Taking matches[0] picked a corner fragment on the first run (lid batch failed at the lip fillet);
  // the agent must look at the list and take the largest face.
  const span = (f: { boundsMm: { min: number[]; max: number[] } }) => (f.boundsMm.max[0]! - f.boundsMm.min[0]!) * (f.boundsMm.max[1]! - f.boundsMm.min[1]!);
  const fl = floor.matches.reduce((m: never, x: never) => (span(x) > span(m) ? x : m));
  // Plate outline and seat height from (a)'s body bounds, which the agent already holds from status / the build reply.
  const bb = a.out.change.added[0].boundsMm;
  const zRim = r3(bb.max[2]);
  const plateMin = [r3(bb.min[0]), r3(bb.min[1])], plateMax = [r3(bb.max[0]), r3(bb.max[1])];
  const inMin = [r3(fl.boundsMm.min[0]), r3(fl.boundsMm.min[1])], inMax = [r3(fl.boundsMm.max[0]), r3(fl.boundsMm.max[1])];
  const clr = 0.2, lip = 1.5, plate = 2;
  const axes = pilots.matches.map((m: { axisOriginMm: number[] }) => [r3(m.axisOriginMm[0]!), r3(m.axisOriginMm[1]!)]) as Array<[number, number]>;
  const s = new Steps();
  const p0 = s.add("plasticity_create_box", { originMm: [plateMin[0], plateMin[1], zRim], sizeMm: [r3(plateMax[0]! - plateMin[0]!), r3(plateMax[1]! - plateMin[1]!), plate], name: "lid" });
  const P = ref(p0);
  const pv = s.add("plasticity_find_edges", { query: { bodyIds: [P], line: true, direction: { vector: [0, 0, 1] } } });
  s.add("plasticity_fillet", { id: P, edgeIds: ids(pv), radiusMm: A.rOut });
  const l0 = s.add("plasticity_create_box", { originMm: [r3(inMin[0]! + clr), r3(inMin[1]! + clr), r3(zRim - lip)], sizeMm: [r3(inMax[0]! - inMin[0]! - 2 * clr), r3(inMax[1]! - inMin[1]! - 2 * clr), lip + 0.5] });
  const lv = s.add("plasticity_find_edges", { query: { bodyIds: [ref(l0)], line: true, direction: { vector: [0, 0, 1] } } });
  s.add("plasticity_fillet", { id: ref(l0), edgeIds: ids(lv), radiusMm: r3(A.rOut - A.t - clr) });
  s.add("plasticity_boolean", { targetIds: [P], toolIds: [ref(l0)], operation: "union" });
  const hs = axes.map(([x, y]) => s.add("plasticity_create_cylinder", { centerMm: [x, y, r3(zRim - lip - 0.5)], radiusMm: 1.7, heightMm: plate + lip + 1 }));
  s.add("plasticity_boolean", { targetIds: [P], toolIds: hs.map((i) => ref(i)), operation: "difference" });
  const topEdges = s.add("plasticity_find_edges", { query: { bodyIds: [P], circle: true, boundsMm: { min: [-1e6, -1e6, zRim + plate - 0.01], max: [1e6, 1e6, zRim + plate + 0.01] }, lengthMm: { value: r3(2 * Math.PI * 1.7), tolerance: 0.01 } } });
  s.add("plasticity_chamfer", { id: P, edgeIds: ids(topEdges), distanceMm: 1.45 });
  // Fit checks in the same batch.
  s.add("plasticity_check_interference", { pairs: [{ firstBodyId: P, secondBodyId: baseId }] });
  const lipFace = s.add("plasticity_find_faces", { query: { bodyIds: [P], planar: true, normal: { vector: [0, -1, 0] }, boundsMm: { min: [-1e6, inMin[1]! + clr - 0.01, -1e6], max: [1e6, inMin[1]! + clr + 0.01, 1e6] } } });
  const wallFace = s.add("plasticity_find_faces", { query: { bodyIds: [baseId], planar: true, normal: { vector: [0, 1, 0] }, boundsMm: { min: [-1e6, inMin[1]! - 0.01, -1e6], max: [1e6, inMin[1]! + 0.01, 1e6] } } });
  s.add("plasticity_measure_parallel_planar_face_clearance", { first: { bodyId: P, faceId: `$${lipFace}.result.matches[0].id` }, second: { bodyId: baseId, faceId: `$${wallFace}.result.matches[0].id` } });
  s.add("plasticity_find_faces", { query: { bodyIds: [P], radiusMm: { value: 1.7 } } });
  const out = await rec.call(2, "build lid + fit checks", "plasticity_batch", { steps: s.list, undoOnError: true });
  const lid = out.change.added.find((x: { name: string }) => x.name === "lid") ?? out.change.added[0];
  const n = s.list.length;
  const interference = out.steps[n - 5].result;
  const clearance = out.steps[n - 2].result;
  let holes = out.steps[n - 1].result?.matches;
  let turn = 3;
  if (!holes) holes = (await rec.call(turn++, "verify lid hole axes (batch read truncated)", "plasticity_find_faces", { revision: out.revision, query: { bodyIds: [lid.id], radiusMm: { value: 1.7 } } }, { forced: "batch truncates read results >1500 B; hole positions need a direct read" })).matches;
  const minClear = clearance?.minimumDistanceMm ?? clearance?.distanceMm ?? clearance?.clearanceMm;
  return {
    lidId: lid.id, derived: { zRim, plateMin, plateMax, inMin, inMax, axes }, steps: n,
    interference, clearance,
    checks: [
      checkBounds("lid", lid.boundsMm, [A.x0, A.y0, A.H - lip], [A.x0 + A.L, A.y0 + A.W, A.H + plate]),
      checkAxes("lid holes vs boss pilots", holes, bossCenters(A)),
      { check: "lid-base interference", actual: interference, ok: JSON.stringify(interference).includes("false") || /"interfer[^"]*":\s*(false|0)/.test(JSON.stringify(interference)) || JSON.stringify(interference).includes("no-volumetric") },
      { check: "lip-to-wall clearance 0.2 mm", actual: minClear, ok: typeof minClear === "number" && near(minClear, 0.2, 0.005) },
    ],
  };
};

// a1 again with ~40 extra bodies in the document (bodies placed at y >= 300, x >= 2000).
scenarios.scale40 = async (h, rec) => {
  const fill = Array.from({ length: 40 }, (_, i) => ({ toolName: "plasticity_create_box", arguments: { originMm: [2000 + (i % 10) * 30, 300 + Math.floor(i / 10) * 30, 0], sizeMm: [20, 10, 5] } }));
  const filler = new Recorder(h, "scale40-fill");
  await filler.call(0, "add 40 filler bodies", "plasticity_batch", { steps: fill });
  const st = await status(h);
  const r = await runEnclosure(h, rec, A, "compact");
  return { ...r, documentBodies: st.bodies.length, fillCall: filler.calls[0] };
};

// ---------- tier 1: the same parts built with the tier-1 server features ----------
// One lean batch per part. Verify reads carry `return`, so no direct read follows. Recipe and check tools are
// called by name (they are in the compact list now), so no catalog lookup precedes the batch.
const tier1: Record<string, (h: H, rec: Recorder) => Promise<unknown>> = {};
type Lean = { steps: Array<{ step: number; toolName: string; result?: Record<string, any> }>; summary: { revision: string; undoSteps: number; bodyCount: number; added?: Array<{ id: number; name?: string; boundsMm: { min: number[]; max: number[] }; faceCount: number; edgeCount: number }>; modified?: unknown[] } };
const byName = (out: Lean, name: string) => out.summary.added?.find((b) => b.name === name) ?? out.summary.added?.[0];
const axesOf = (list: number[][]) => list.map((a) => ({ axisOriginMm: a, radiusMm: null })) as Array<{ axisOriginMm: number[]; radiusMm: number | null }>;
const lastStep = (out: Lean) => out.steps[out.steps.length - 1]!;

async function runEnclosureT1(h: H, rec: Recorder, p: EnclosureParams, variant: "compact" | "recipes") {
  const built = variant === "compact" ? enclosureCompact(p, true) : enclosureRecipes(p, true);
  const out: Lean = await rec.call(1, `build enclosure (${variant}, tier 1): lean batch with verify read`, "plasticity_batch", { steps: built.steps, detail: "lean", undoOnError: true });
  const base = byName(out, "enclosure-base")!;
  const pilots = axesOf(lastStep(out).result!["matches[*].axisOriginMm"]);
  const checks: unknown[] = [
    checkBounds("base", base.boundsMm, [p.x0, p.y0, 0], [p.x0 + p.L, p.y0 + p.W, p.H]),
    checkAxes("pilot", pilots, bossCenters(p)),
    { check: "face/edge counts", actual: { faces: base.faceCount, edges: base.edgeCount }, ok: base.faceCount > 30 },
  ];
  return { baseId: base.id, revision: out.summary.revision, out, checks, steps: built.steps.length, batchReplyBytes: JSON.stringify(out).length };
}
tier1.a1 = async (h, rec) => runEnclosureT1(h, rec, A, "compact");
tier1.a2 = async (h, rec) => runEnclosureT1(h, rec, A, "recipes");
tier1.e = async (h, rec) => runEnclosureT1(h, rec, { ...E }, "compact");

tier1.b = async (h, rec) => {
  const x0 = 2200, t = 4, Lb = 40, Lv = 40, Wd = 30;
  const s = new Steps();
  const base = s.add("plasticity_create_box", { originMm: [x0, 0, 0], sizeMm: [Lb, Wd, t], name: "l-bracket" });
  const B = ref(base);
  const vert = s.add("plasticity_create_box", { originMm: [x0, 0, 0], sizeMm: [t, Wd, Lv] });
  s.add("plasticity_boolean", { targetIds: [B], toolIds: [ref(vert)], operation: "union" });
  const gy = Wd / 2 - t / 2;
  let ribStep = -1;
  if (T1D) {
    s.add("plasticity_fillet", { id: B, edgeQuery: { line: true, center: { pointMm: [x0 + t, Wd / 2, t] } }, radiusMm: 5 });
    // The two tip edge sets are one query each; the fillet takes one set per call, so tip A and tip B are two fillets of 3 mm.
    // The four tip corner edges (two at the base tip, two at the leg top) are the only straight 4 mm edges left: one query.
    s.add("plasticity_fillet", { id: B, edgeQuery: { line: true, lengthMm: { value: t, tolerance: 0.01 } }, radiusMm: 3 });
    // The gusset is centred on the bracket's mid-plane: side "centered" puts it at y 13..17, whatever the point order.
    ribStep = s.add("plasticity_create_rib", { targetId: B, profilePointsMm: [[x0 + t - 0.5, Wd / 2, t - 0.5], [x0 + t + 25, Wd / 2, t - 0.5], [x0 + t - 0.5, Wd / 2, t + 25]], thicknessMm: t, side: "centered" }, ["ribBoundsMm"]);
  } else {
  const bend = s.add("plasticity_find_edges", { query: { bodyIds: [B], line: true, center: { pointMm: [x0 + t, Wd / 2, t] } } }, workaround(["count"]));
  s.add("plasticity_fillet", { id: B, edgeIds: ids(bend), radiusMm: 5 });
  const tipA = s.add("plasticity_find_edges", { query: { bodyIds: [B], line: true, direction: { vector: [0, 0, 1] }, boundsMm: { min: [x0 + Lb - 0.01, -1, -1], max: [x0 + Lb + 0.01, Wd + 1, t + 1] } } }, workaround(["count"]));
  const tipB = s.add("plasticity_find_edges", { query: { bodyIds: [B], line: true, direction: { vector: [1, 0, 0] }, boundsMm: { min: [x0 - 1, -1, Lv - 0.01], max: [x0 + t + 1, Wd + 1, Lv + 0.01] } } }, workaround(["count"]));
  s.add("plasticity_fillet", { id: B, edgeIds: [ids(tipA), ids(tipB)], radiusMm: 3 });
  s.add("plasticity_create_rib", { targetId: B, profilePointsMm: [[x0 + t - 0.5, gy, t - 0.5], [x0 + t + 25, gy, t - 0.5], [x0 + t - 0.5, gy, t + 25]], thicknessMm: t }, workaround(["status"]));
  }
  const holesBase = [[x0 + 26, 7.5], [x0 + 26, 22.5]] as Array<[number, number]>;
  const holesVert = [[7.5, 26], [22.5, 26]] as Array<[number, number]>; // (y, z)
  const hb = holesBase.map(([x, y]) => s.add("plasticity_create_cylinder", { centerMm: [x, y, -0.5], radiusMm: 2.25, heightMm: t + 1 }));
  const hv = holesVert.map(([y, z]) => s.add("plasticity_create_cylinder", { centerMm: [x0 - 0.5, y, z], radiusMm: 2.25, heightMm: t + 1, axis: [1, 0, 0] }));
  s.add("plasticity_boolean", { targetIds: [B], toolIds: [...hb, ...hv].map((i) => ref(i)), operation: "difference" });
  s.add("plasticity_find_faces", { query: { bodyIds: [B], radiusMm: { value: 2.25 } } }, ["matches[*].axisOriginMm", "matches[*].axisDirection"]);
  s.add("plasticity_find_faces", { query: { bodyIds: [B], surfaceTypes: ["Cylinder"] } }, ["matches[*].radiusMm"]);
  const out: Lean = await rec.call(1, "build L-bracket + verify reads (one lean batch)", "plasticity_batch", { steps: s.list, detail: "lean", undoOnError: true });
  const body = byName(out, "l-bracket")!;
  const holeRead = out.steps[out.steps.length - 2]!.result!;
  const holes = (holeRead["matches[*].axisOriginMm"] as number[][]).map((o, i) => ({ axisOriginMm: o, axisDirection: (holeRead["matches[*].axisDirection"] as number[][])[i]!, radiusMm: 2.25 }));
  const zHoles = holes.filter((m) => Math.abs(m.axisDirection[2]!) > 0.9);
  const xHoles = holes.filter((m) => Math.abs(m.axisDirection[0]!) > 0.9);
  const radii = (lastStep(out).result!["matches[*].radiusMm"] as number[]).map(r3);
  const rib = ribStep >= 0 ? (out.steps[ribStep]!.result!.ribBoundsMm as { min: number[]; max: number[] }) : undefined;
  return { bodyId: body.id, faceCount: body.faceCount, steps: s.list.length, out, checks: [
    ...(rib ? [{ check: "gusset lands at y 13..17 (centred on the 30 mm bracket)", actual: rib, ok: near(rib.min[1]!, 13) && near(rib.max[1]!, 17) }] : []),
    checkBounds("bracket", body.boundsMm, [x0, 0, 0], [x0 + Lb, Wd, Lv]),
    checkAxes("base-leg", zHoles, holesBase),
    checkAxes("vertical-leg", xHoles, holesVert, [1, 2]),
    { check: "cylindrical faces radii (expect r5 bend x2 split by gusset, r3 tips x4, r2.25 holes x4)", actual: radii, ok: radii.filter((r) => near(r, 5)).length === 2 && radii.filter((r) => near(r, 3)).length === 4 && radii.filter((r) => near(r, 2.25)).length === 4 },
  ] };
};

tier1.c = async (h, rec) => {
  const cx = 2450, cy = 30, R = 30, T = 6, bore = 10, bc = 22.5, hole = 2.5;
  const s = new Steps();
  const disc = s.add("plasticity_create_cylinder", { centerMm: [cx, cy, 0], radiusMm: R, heightMm: T, name: "flange" });
  const B = ref(disc);
  const b = s.add("plasticity_create_cylinder", { centerMm: [cx, cy, -0.5], radiusMm: bore, heightMm: T + 1 });
  const centers = Array.from({ length: 6 }, (_, i) => [r3(cx + bc * Math.cos(i * Math.PI / 3)), r3(cy + bc * Math.sin(i * Math.PI / 3))] as [number, number]);
  const hs = centers.map(([x, y]) => s.add("plasticity_create_cylinder", { centerMm: [x, y, -0.5], radiusMm: hole, heightMm: T + 1 }));
  s.add("plasticity_boolean", { targetIds: [B], toolIds: [b, ...hs].map((i) => ref(i)), operation: "difference" });
  // return: ["count"] keeps the reply small; the later chamfer still resolves the ids from the stored result.
  const outer = s.add("plasticity_find_edges", { query: { bodyIds: [B], circle: true, lengthMm: { value: r3(2 * Math.PI * R), tolerance: 0.01 } } }, workaround(["count"]));
  const inner = s.add("plasticity_find_edges", { query: { bodyIds: [B], circle: true, lengthMm: { value: r3(2 * Math.PI * bore), tolerance: 0.01 } } }, workaround(["count"]));
  s.add("plasticity_chamfer", { id: B, edgeIds: [ids(outer), ids(inner)], distanceMm: 1 });
  s.add("plasticity_find_faces", { query: { bodyIds: [B], radiusMm: { value: hole } } }, ["matches[*].axisOriginMm"]);
  const out: Lean = await rec.call(1, "build flange + verify read (one lean batch)", "plasticity_batch", { steps: s.list, detail: "lean", undoOnError: true });
  const body = byName(out, "flange")!;
  const n = s.list.length;
  const holes = axesOf(lastStep(out).result!["matches[*].axisOriginMm"]);
  const outerCount = out.steps[n - 4]!.result!.count, innerCount = out.steps[n - 3]!.result!.count;
  return { bodyId: body.id, faceCount: body.faceCount, edgeCount: body.edgeCount, steps: n, out, checks: [
    checkBounds("flange", body.boundsMm, [cx - R, cy - R, 0], [cx + R, cy + R, T]),
    checkAxes("bolt-circle", holes, centers),
    { check: "chamfered edges", note: "4 circular edges chamfered 1 mm (outer and bore, top and bottom)", outerMatches: outerCount, innerMatches: innerCount, ok: outerCount === 2 && innerCount === 2 },
  ] };
};

tier1.d = async (h, rec) => {
  // Setup (not counted): part (a) exists, as if built earlier or imported.
  const setup = new Recorder(h, "d-setup");
  const a = await runEnclosureT1(h, setup, A, "compact");
  const baseId = a.baseId;
  const bb = byName(a.out, "enclosure-base")!.boundsMm;
  // Turn 1: one read-only lean batch. The cavity floor is split into fragments by the bosses (the trap that sank
  // attempt 1 with matches[0]); area is not in the read model, so the main floor face is picked by its centre.
  let fl: { min: number[]; max: number[] };
  let axes: Array<[number, number]>;
  if (T1D) {
    // Tier 1d: one describe_body read gives the inner walls and floor (from the planes) and the pilot hole axes; no face search, no batch.
    // describe_body has no cavity field: a plane facing into the cavity is an xPos/yPos entry just inside the low bound (or an
    // xNeg/yNeg entry just inside the high bound), and the floor is the lowest zPos entry.
    const described = await rec.call(1, "describe the base (inner wall and floor planes + hole axes), one read", "plasticity_describe_body", { id: baseId }, { forced: "lid dimensions and hole positions come from (a); the read is one call" });
    const planes = described.planes as Record<string, Array<{ mm: number }>>;
    const inside = (list: Array<{ mm: number }> | undefined, above: number, pick: "lowest" | "highest", below = Infinity) => {
      const values = (list ?? []).map((entry) => entry.mm).filter((mm) => mm > above + 0.01 && mm < below - 0.01);
      if (values.length === 0) throw new Error("describe_body planes hold no inner wall or floor entry in that range");
      return pick === "lowest" ? Math.min(...values) : Math.max(...values);
    };
    fl = {
      min: [inside(planes.xPos, bb.min[0]!, "lowest"), inside(planes.yPos, bb.min[1]!, "lowest"), inside(planes.zPos, bb.min[2]!, "lowest")],
      max: [inside(planes.xNeg, -Infinity, "highest", bb.max[0]!), inside(planes.yNeg, -Infinity, "highest", bb.max[1]!), inside(planes.zPos, bb.min[2]!, "lowest")],
    };
    const holes = (described.cylinders as Array<{ radiusMm: number; kind?: string; axisPointsMm: number[][] }>).find((group) => group.kind === "hole" && near(group.radiusMm, A.pilotD / 2));
    if (!holes) throw new Error("describe_body returned no pilot hole group");
    axes = holes.axisPointsMm.map((o) => [r3(o[0]!), r3(o[1]!)]) as Array<[number, number]>;
  } else {
  const reads: Lean = await rec.call(1, "read cavity floor + boss pilot axes (one batch, return lists)", "plasticity_batch", { detail: "lean", steps: [
    T1B
      // Tier 1b: the largest upward face at floor height is the main floor (the boss fragments are tiny).
      ? { toolName: "plasticity_find_faces", arguments: { query: { bodyIds: [baseId], planar: true, normal: { vector: [0, 0, 1] }, boundsMm: { min: [-1e6, -1e6, A.t - 0.01], max: [1e6, 1e6, A.t + 0.01] } }, sortBy: "area", limit: 1 }, return: ["matches[0].boundsMm"] }
      : { toolName: "plasticity_find_faces", arguments: { query: { bodyIds: [baseId], planar: true, normal: { vector: [0, 0, 1] }, center: { pointMm: [A.x0 + A.L / 2, A.y0 + A.W / 2, A.t], toleranceMm: 3 } }, limit: 1 }, return: ["matches[0].boundsMm"] },
    { toolName: "plasticity_find_faces", arguments: { query: { bodyIds: [baseId], radiusMm: { value: A.pilotD / 2 } } }, return: ["matches[*].axisOriginMm"] },
  ] }, { forced: "lid dimensions and hole positions come from (a); a batch has no arithmetic on read results" });
  fl = reads.steps[0]!.result!["matches[0].boundsMm"] as { min: number[]; max: number[] };
  axes = (reads.steps[1]!.result!["matches[*].axisOriginMm"] as number[][]).map((o) => [r3(o[0]!), r3(o[1]!)]) as Array<[number, number]>;
  }
  const zRim = r3(bb.max[2]!);
  const plateMin = [r3(bb.min[0]!), r3(bb.min[1]!)], plateMax = [r3(bb.max[0]!), r3(bb.max[1]!)];
  const inMin = [r3(fl.min[0]!), r3(fl.min[1]!)], inMax = [r3(fl.max[0]!), r3(fl.max[1]!)];
  const clr = 0.2, lip = 1.5, plate = 2;
  const s = new Steps();
  const p0 = s.add("plasticity_create_box", { originMm: [plateMin[0], plateMin[1], zRim], sizeMm: [r3(plateMax[0]! - plateMin[0]!), r3(plateMax[1]! - plateMin[1]!), plate], name: "lid" });
  const P = ref(p0);
  if (T1D) s.add("plasticity_fillet", { id: P, edgeQuery: { line: true, direction: { vector: [0, 0, 1] } }, radiusMm: A.rOut });
  else {
    const pv = s.add("plasticity_find_edges", { query: { bodyIds: [P], line: true, direction: { vector: [0, 0, 1] } } }, workaround(["count"]));
    s.add("plasticity_fillet", { id: P, edgeIds: ids(pv), radiusMm: A.rOut });
  }
  const l0 = s.add("plasticity_create_box", { originMm: [r3(inMin[0]! + clr), r3(inMin[1]! + clr), r3(zRim - lip)], sizeMm: [r3(inMax[0]! - inMin[0]! - 2 * clr), r3(inMax[1]! - inMin[1]! - 2 * clr), lip + 0.5] });
  if (T1D) s.add("plasticity_fillet", { id: ref(l0), edgeQuery: { line: true, direction: { vector: [0, 0, 1] } }, radiusMm: r3(A.rOut - A.t - clr) });
  else {
    const lv = s.add("plasticity_find_edges", { query: { bodyIds: [ref(l0)], line: true, direction: { vector: [0, 0, 1] } } }, workaround(["count"]));
    s.add("plasticity_fillet", { id: ref(l0), edgeIds: ids(lv), radiusMm: r3(A.rOut - A.t - clr) });
  }
  s.add("plasticity_boolean", { targetIds: [P], toolIds: [ref(l0)], operation: "union" });
  const hs = axes.map(([x, y]) => s.add("plasticity_create_cylinder", { centerMm: [x, y, r3(zRim - lip - 0.5)], radiusMm: 1.7, heightMm: plate + lip + 1 }));
  s.add("plasticity_boolean", { targetIds: [P], toolIds: hs.map((i) => ref(i)), operation: "difference" });
  const topQuery = { circle: true, boundsMm: { min: [-1e6, -1e6, zRim + plate - 0.01], max: [1e6, 1e6, zRim + plate + 0.01] }, lengthMm: { value: r3(2 * Math.PI * 1.7), tolerance: 0.01 } };
  if (T1D) s.add("plasticity_chamfer", { id: P, edgeQuery: topQuery, distanceMm: 1.45 });
  else {
    const topEdges = s.add("plasticity_find_edges", { query: { bodyIds: [P], ...topQuery } }, workaround(["count"]));
    s.add("plasticity_chamfer", { id: P, edgeIds: ids(topEdges), distanceMm: 1.45 });
  }
  s.add("plasticity_check_interference", { pairs: [{ firstBodyId: P, secondBodyId: baseId }] }, ["pairs[*].status"]);
  const lipFace = s.add("plasticity_find_faces", { query: { bodyIds: [P], planar: true, normal: { vector: [0, -1, 0] }, boundsMm: { min: [-1e6, inMin[1]! + clr - 0.01, -1e6], max: [1e6, inMin[1]! + clr + 0.01, 1e6] } }, limit: 1 }, ["matches[*].id"]);
  const wallFace = s.add("plasticity_find_faces", { query: { bodyIds: [baseId], planar: true, normal: { vector: [0, 1, 0] }, boundsMm: { min: [-1e6, inMin[1]! - 0.01, -1e6], max: [1e6, inMin[1]! + 0.01, 1e6] } }, limit: 1 }, ["matches[*].id"]);
  s.add("plasticity_measure_parallel_planar_face_clearance", { first: { bodyId: P, faceId: `$${lipFace}.result.matches[0].id` }, second: { bodyId: baseId, faceId: `$${wallFace}.result.matches[0].id` } }, ["minimumDistanceMm"]);
  s.add("plasticity_find_faces", { query: { bodyIds: [P], radiusMm: { value: 1.7 } } }, ["matches[*].axisOriginMm"]);
  const out: Lean = await rec.call(2, "build lid + fit checks + verify (one lean batch)", "plasticity_batch", { steps: s.list, detail: "lean", undoOnError: true });
  const lid = byName(out, "lid")!;
  const n = s.list.length;
  const interference = out.steps[n - 5]!.result!["pairs[*].status"] as string[];
  const minClear = out.steps[n - 2]!.result!.minimumDistanceMm as number;
  const holes = axesOf(lastStep(out).result!["matches[*].axisOriginMm"]);
  return { lidId: lid.id, derived: { zRim, plateMin, plateMax, inMin, inMax, axes }, steps: n, out, checks: [
    checkBounds("lid", lid.boundsMm, [A.x0, A.y0, A.H - lip], [A.x0 + A.L, A.y0 + A.W, A.H + plate]),
    checkAxes("lid holes vs boss pilots", holes, bossCenters(A)),
    { check: "lid-base interference", actual: interference, ok: interference.length === 1 && interference[0] === "no-volumetric-interference" },
    { check: "lip-to-wall clearance 0.2 mm", actual: minClear, ok: typeof minClear === "number" && near(minClear, 0.2, 0.005) },
  ] };
};

// ---------- runner ----------
const T1 = process.argv.includes("--tier1") || T1B;
const TAG = process.argv.find((arg) => arg.startsWith("--tag="))?.slice("--tag=".length);
// A tagged run is tier-1b evidence (e.g. --tag=before1 from a pre-change tree): part-<name>-<tag>-tier1b.json.
const DESCRIBE = process.argv.includes("--describe");
const SUFFIX = process.argv.find((arg) => arg.startsWith("--suffix="))?.slice("--suffix=".length);
if (SUFFIX !== undefined && !/^[\w-]+$/.test(SUFFIX)) throw new Error("--suffix takes letters, digits, _ and -");
const outName = (base: string, name: string) => (T1D ? `part-${name}-tier1d.json` : DESCRIBE ? `describe-check-${name}.json` : SUFFIX ? `part-${name}-tier1b-${SUFFIX}.json` : TAG ? `part-${name}-${TAG}-tier1b.json` : `${base}.json`);
const names = process.argv.slice(2).filter((n) => !n.startsWith("--"));
if (names[0] === "dump-steps") {
  save("steps-a1.json", enclosureCompact(A).steps);
  save("steps-e.json", enclosureCompact(E).steps);
  save("steps-a2.json", enclosureRecipes(A).steps);
  process.exit(0);
}
const h = await openInProcess();
const summary: Record<string, unknown> = {};
try {
  const start = await status(h);
  console.error(`start: undoDepth ${start.undoDepth}, bodies ${start.bodies.length}`);
  if (T1 && !T1B && !TAG) {
    // Compact tools/list and instructions size with the tier-1 compact list (baseline: fixed-costs.json).
    const listed = await h.client.listTools();
    const fixed = JSON.parse((await import("node:fs")).readFileSync(new URL("./fixed-costs.json", import.meta.url), "utf8"));
    const toolsList = { toolsListBytes: bytes(listed), toolCount: listed.tools.length, instructionsBytes: bytes(h.client.getInstructions() ?? ""), before: { toolsListBytes: fixed.toolsListBytes, toolCount: fixed.toolCount, instructionsBytes: fixed.instructionsBytes } };
    save("part-toolslist-tier1.json", toolsList);
    console.error("toolslist", JSON.stringify(toolsList));
  }
  if (T1D) {
    // Compact tools/list and instructions size after tier 1d (before: part-toolslist-tier1d-before.json, measured on the tier 1c tree).
    const listed = await h.client.listTools();
    const toolsList = { toolsListBytes: bytes(listed), toolCount: listed.tools.length, instructionsBytes: bytes(h.client.getInstructions() ?? "") };
    save("part-toolslist-tier1d.json", toolsList);
    console.error("toolslist", JSON.stringify(toolsList));
  }
  for (const name of names) {
    const rec = new Recorder(h, name);
    let detail: unknown; let error: string | undefined;
    const t0 = performance.now();
    const run = T1 ? tier1[name] : scenarios[name];
    if (!run) throw new Error(`no ${T1 ? "tier-1 " : ""}scenario ${name}`);
    try { detail = await run(h, rec); } catch (e) { error = (e as Error).message.slice(0, 4000); console.error(name, "FAILED", error); }
    const scenarioMs = Math.round(performance.now() - t0);
    let described: unknown;
    if (DESCRIBE && !error) {
      const bodyId = (detail as { bodyId?: number; baseId?: number }).bodyId ?? (detail as { baseId?: number }).baseId;
      const read = async (toolName: string, args: Record<string, unknown>) => {
        const response = await h.client.callTool({ name: toolName, arguments: args });
        const text = (response.content as Array<{ text: string }>)[0]!.text;
        return { bytes: bytes(text), reply: JSON.parse(text) };
      };
      const describeReply = await read("plasticity_describe_body", { id: bodyId });
      const infoReply = await read("plasticity_body_info", { id: bodyId });
      const slim = await read("plasticity_body_info", { id: bodyId, edges: false, vertices: false });
      described = { bodyId, describeBytes: describeReply.bytes, describe: describeReply.reply, bodyInfoBytes: infoReply.bytes, bodyInfoHint: infoReply.reply.hint ?? null, bodyInfoNoEdgesNoVerticesBytes: slim.bytes };
      console.error(name, "describe", JSON.stringify({ describeBytes: describeReply.bytes, bodyInfoBytes: infoReply.bytes, slim: slim.bytes }));
    }
    const restored = await restore(h, start);
    const record = { scenario: name, ...(T1 ? { tier: T1D ? "1d" : T1B ? "1b" : 1 } : {}), ...(TAG ? { tag: TAG } : {}), ...(SUFFIX ? { suffix: SUFFIX, endpoint: ENDPOINT, stateReuse: process.env.SPEED_NO_REUSE !== "1" } : {}), measuredAt: new Date().toISOString(), scenarioMs, totals: rec.totals(), detail, error, calls: rec.calls, responses: rec.results, ...(described ? { described } : {}), restored, startUndoDepth: start.undoDepth, startBodyCount: start.bodies.length };
    save(outName(T1B ? `part-${name}-tier1b` : T1 ? `part-${name}-tier1` : `part-${name}`, name), record);
    summary[name] = { totals: record.totals, error, restored, checks: (detail as { checks?: unknown })?.checks };
    console.error(name, JSON.stringify(summary[name]));
    if (!restored.ok) throw new Error(`document not restored after ${name}: ${JSON.stringify(restored)}`);
  }
  const end = await status(h);
  console.error(`end: undoDepth ${end.undoDepth}, bodies ${end.bodies.length} (start ${start.undoDepth}, ${start.bodies.length})`);
} finally {
  await h.close();
}
console.log(JSON.stringify(summary, null, 1));
