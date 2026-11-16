// Turns the measured part-*.json / fixed-costs.json into the cost-model tables used in AUDIT.md.
// Offline. Projections are estimates: hypothetical request JSON is byte-counted, reply sizes are assumed
// from the measured "needed" bytes (anatomy.json), server ms is the measured run minus the de-duplicated state reads.
import { readFileSync } from "node:fs";
import { OUT_DIR, save } from "./lib.ts";

const load = (n: string) => JSON.parse(readFileSync(`${OUT_DIR}/${n}`, "utf8"));
const B = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

type Assume = { name: string; turnS: number; outTokS: number; reasoningX: number; inTokS: number };
const ASSUME: Assume[] = [
  { name: "low", turnS: 2, outTokS: 80, reasoningX: 0.5, inTokS: 3000 },
  { name: "mid", turnS: 3, outTokS: 70, reasoningX: 1.0, inTokS: 2000 },
  { name: "high", turnS: 4, outTokS: 60, reasoningX: 1.5, inTokS: 1000 },
];
const seconds = (r: { turns: number; reqBytes: number; respBytes: number; serverMs: number }, a: Assume) => {
  const out = r.reqBytes / 4, inp = r.respBytes / 4;
  return r.turns * a.turnS + (out * (1 + a.reasoningX)) / a.outTokS + inp / a.inTokS + r.serverMs / 1000;
};
const secs = (r: Parameters<typeof seconds>[0]) => Object.fromEntries(ASSUME.map((a) => [a.name, Math.round(seconds(r, a) * 10) / 10]));

const fixed = load("fixed-costs.json");
const session = { turns: 1, reqBytes: 40, respBytes: fixed.toolsListBytes + fixed.instructionsBytes + fixed.statusBytes, serverMs: fixed.serverStartMsMedian + fixed.firstCallAutoConnectStatusMs[0] };

const parts: Record<string, string> = { a: "part-a1.json", "a (recipes)": "part-a2.json", b: "part-b.json", c: "part-c.json", d: "part-d.json", e: "part-e.json", "a @44 bodies": "part-scale40.json", "a, no batch": "part-a3.json" };
const today: Record<string, unknown> = {};
for (const [k, f] of Object.entries(parts)) {
  const d = load(f);
  const t = d.totals;
  const batch = d.calls.filter((c: { tool: string }) => c.tool === "plasticity_batch");
  const stateReads = d.calls.reduce((s: number, c: { ops: { stateReads: number } }) => s + c.ops.stateReads, 0);
  const stateMs = d.calls.reduce((s: number, c: { ops: { stateMs: number } }) => s + c.ops.stateMs, 0);
  const mutateMs = d.calls.reduce((s: number, c: { ops: { mutateMs: number } }) => s + c.ops.mutateMs, 0);
  const journalMs = d.calls.reduce((s: number, c: { ops: { journalMs: number } }) => s + c.ops.journalMs, 0);
  const batchSteps = batch.reduce((s: number, c: { stepOps?: unknown[] }) => s + (c.stepOps?.length ?? 0), 0);
  today[k] = { ...t, seconds: secs(t), stateReads, stateMs: Math.round(stateMs), mutateMs: Math.round(mutateMs), journalMs: Math.round(journalMs), batchSteps, restored: d.restored };
}

// ---- Projections ----
// Tier 1: generic S/M fixes (terse batch reply, read-result projection, recipes + fit checks in the compact list, one state read per step).
// Tier 2: Tier 1 + part recipes (enclosure, lid-for-body, L-bracket, flange) or template replay.
const minimalReply = 600; // measured needed bytes 157 (anatomy.json) + ~450 B of projected verification values
const hypo = {
  a: { name: "plasticity_create_enclosure", arguments: { originMm: [2000, 0, 0], sizeMm: [80, 50, 25], wallMm: 2, outerCornerRadiusMm: 3, rimChamferMm: 1, bosses: { outerDiameterMm: 6, pilotDiameterMm: 2.5, pilotDepthMm: 8, topBelowRimMm: 2 }, openings: [{ face: "front", widthMm: 12, heightMm: 6, cornerRadiusMm: 2 }] } },
  b: { name: "plasticity_create_l_bracket", arguments: { originMm: [2200, 0, 0], legsMm: [40, 40], widthMm: 30, thicknessMm: 4, bendRadiusMm: 5, tipCornerRadiusMm: 3, holes: { diameterMm: 4.5, perLeg: 2, fromBendMm: 22 }, gusset: { legMm: 25, thicknessMm: 4 } } },
  c: { name: "plasticity_create_flange", arguments: { centerMm: [2450, 30, 0], diameterMm: 60, thicknessMm: 6, boreDiameterMm: 20, boltCircle: { diameterMm: 45, count: 6, holeDiameterMm: 5 }, edgeChamferMm: 1 } },
  d: { name: "plasticity_create_lid_for_body", arguments: { baseId: 426, plateMm: 2, lipDepthMm: 1.5, clearanceMm: 0.2, holes: { from: "boss-pilots", throughDiameterMm: 3.4, countersink: { majorDiameterMm: 6.3, includedAngleDeg: 90 } }, verify: ["interference", "lipClearance", "holeAlignment"] } },
  e: { name: "plasticity_replay_template", arguments: { template: "enclosure-base", params: { L: 100, W: 60, H: 30, wall: 2.5 } } },
};
const lean = (k: keyof typeof today) => {
  const t = today[k] as { stateReads: number; stateMs: number; serverMs: number; batchSteps: number };
  const perRead = t.stateMs / Math.max(1, t.stateReads);
  const keptReads = t.batchSteps + 2;
  return Math.round(t.serverMs - t.stateMs + keptReads * perRead);
};
const a2 = load("part-a2.json"), b = load("part-b.json"), c = load("part-c.json"), d = load("part-d.json");
const batchReq = (x: { calls: Array<{ tool: string; reqBytes: number }> }) => x.calls.filter((y) => y.tool === "plasticity_batch").reduce((s, y) => s + y.reqBytes, 0);
const projection = 60; // bytes added per verify read step for a "fields" projection
const tier1 = {
  a: { turns: 1, reqBytes: batchReq(a2) + projection, respBytes: minimalReply, serverMs: lean("a (recipes)") },
  b: { turns: 1, reqBytes: batchReq(b) + 2 * projection + 120, respBytes: minimalReply + 200, serverMs: lean("b") },
  c: { turns: 1, reqBytes: batchReq(c) + projection, respBytes: minimalReply, serverMs: lean("c") },
  d: { turns: 2, reqBytes: 221 + 132 + 2 * projection + batchReq(d) + projection, respBytes: 2 * 400 + minimalReply + 300, serverMs: lean("d") },
  e: { turns: 1, reqBytes: batchReq(a2) + projection, respBytes: minimalReply, serverMs: lean("a (recipes)") },
};
const tier2 = Object.fromEntries(Object.entries(hypo).map(([k, v]) => [k, { turns: 1, reqBytes: B(v), respBytes: k === "d" ? minimalReply + 300 : minimalReply, serverMs: (tier1 as Record<string, { serverMs: number }>)[k]!.serverMs }]));
const withSecs = (o: Record<string, { turns: number; reqBytes: number; respBytes: number; serverMs: number }>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v, seconds: secs(v) }]));

const out = { assumptions: ASSUME, session: { ...session, seconds: secs(session) }, today, tier1: withSecs(tier1), tier2: withSecs(tier2), hypotheticalRequests: hypo };
save("cost-model.json", out);
console.log(JSON.stringify(out, null, 1));
