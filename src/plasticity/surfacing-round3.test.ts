import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";
import {
  EXACT_BOUNDS_SOURCE,
  exactBounds,
  explainXNurbsError,
  relativeCurvatureDeviation,
  squareClosureProblem,
  SURFACE_ALIGN_READBACK_SOURCE,
  withScreenshotView,
} from "./surfacing.ts";
import { PlasticityOperations } from "./operations.ts";

// Round 3 review items D2-D7, each against the behaviour of cf99ba6.

type V = [number, number, number];
class KVector { x: number; y: number; z: number; constructor(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } }

test("D2: the docs and the tool say the xsided options are in the schema, and what tension was measured to do", () => {
  const docs = readFileSync(new URL("../../docs/tool-reference.md", import.meta.url), "utf8");
  assert.doesNotMatch(docs, /not\s+yet in the tool schema/);
  assert.match(docs, /in the tool\s+schema and are forwarded only when given/);
  const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  assert.match(server, /no effect at g0 and none on a four-Wire curveIds patch/);
  const changelog = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
  assert.doesNotMatch(changelog, /they are not in the tool schema because/);
});

test("D3: relative G2 is |k1 - k2| / (|k1| + |k2|): R5 against R10 is 0.3333, R5 against R20 is 0.6, flat against anything is 1", () => {
  assert.ok(Math.abs(relativeCurvatureDeviation(1 / 5, 1 / 10) - 1 / 3) < 1e-12);
  assert.ok(Math.abs(relativeCurvatureDeviation(1 / 5, 1 / 20) - 0.6) < 1e-12);
  assert.equal(relativeCurvatureDeviation(0, 1 / 3), 1);
  assert.equal(relativeCurvatureDeviation(0, 0), 0);
  const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  assert.match(server, /\|k1 - k2\| \/ \(\|k1\| \+ \|k2\|\)/);
  assert.doesNotMatch(server, /\/ max\(\|k1\|, \|k2\|\)/);
});

test("D4: the Square closure check refuses gaps, wrong order and closed or branching items with the size of the gap", () => {
  const closed: V[][] = [[[0, 0, 0], [40, 0, 0]], [[40, 0, 0], [40, 40, 0]], [[40, 40, 0], [0, 40, 0]], [[0, 40, 0], [0, 0, 0]]];
  assert.equal(squareClosureProblem(closed), null);
  // Items reversed in direction still close.
  assert.equal(squareClosureProblem([[[40, 0, 0], [0, 0, 0]], [[40, 40, 0], [40, 0, 0]], [[0, 40, 0], [40, 40, 0]], [[0, 0, 0], [0, 40, 0]]]), null);
  const gap: V[][] = closed.map((ends) => ends.map((p) => [...p] as V));
  gap[2]![0] = [39.995, 40, 0];
  assert.match(squareClosureProblem(gap) ?? "", /boundary items 2 and 3 are 0\.005 mm apart at their nearest ends \(needs <= 0\.001 mm\)/);
  assert.match(squareClosureProblem([closed[0]!, closed[2]!, closed[1]!, closed[3]!]) ?? "", /mm apart|does not run from/);
  assert.match(squareClosureProblem([closed[0]!, closed[1]!, [[1, 1, 1]], closed[3]!]) ?? "", /boundary item 3 has 1 free ends/);
  assert.match((explainXNurbsError(new Error("XNurbs operation failed with error `31`.")) as Error).message, /XNurbs error 31: the boundary does not close/);
});

test("D4: squareSurface refuses an open boundary before any edit, naming the gap", async () => {
  const state = {
    targetId: "w", title: "t", documentToken: "doc", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" },
    bodies: [7, 8, 9, 10].map((id) => ({ id, versionId: 100 + id, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] })),
  } as unknown as RuntimeState;
  let mutations = 0;
  const runtime = {
    async getState() { return state; },
    async read() { return [[[0, 0, 0], [0.04, 0, 0]], [[0.04, 0, 0], [0.04, 0.04, 0]], [[0.039995, 0.04, 0], [0, 0.04, 0]], [[0, 0.04, 0], [0, 0, 0]]]; },
    async mutate() { mutations += 1; return undefined; },
  } as unknown as PlasticityRuntime;
  await assert.rejects(new PlasticityOperations(runtime).squareSurface({ boundary: [{ wireId: 7 }, { wireId: 8 }, { wireId: 9 }, { wireId: 10 }] }, "r1"), /Square boundary is open: boundary items 2 and 3 are 0\.005 mm apart.*nothing was changed/);
  assert.equal(mutations, 0);
});

test("D5: the decoded advice comes right after the line with the raw code, before the stack text", () => {
  const raw = new Error("Plasticity command failed: Error: XNurbs operation failed with error `30`.\n    at a (x.js:1)\n    at b (x.js:2)\n    at c (x.js:3)");
  const lines = (explainXNurbsError(raw) as Error).message.split("\n");
  assert.match(lines[0]!, /error `30`\. XNurbs error 30: the requested continuity is incompatible/);
  assert.match(lines[1]!, /^ {4}at a/);
  assert.equal(lines.length, 4);
});

test("D6: a failed or timed-out apply restores the view before the error is reported", async () => {
  const calls: string[] = [];
  const runtime = {
    async readNative(_source: string, _bindings: string[], values: Array<{ op: string }>) {
      calls.push(values[0]!.op);
      if (values[0]!.op === "apply") throw new Error("CDP request timed out: Runtime.callFunctionOn");
      return { restored: true, undoDepth: 0, shader: null, cameraAfter: null, cameraDeviation: null };
    },
  } as unknown as PlasticityRuntime;
  await assert.rejects(withScreenshotView(runtime, { shader: "topo" }, async () => ({})), /timed out/);
  assert.deepEqual(calls, ["apply", "restore"]);
});

test("D7: EXACT_BOUNDS_SOURCE runs against a stub kernel: one body range call, 12 far points (100 km and 10 km), the support sides", async () => {
  // A box body 0..0.01 x 0..0.02 x 0..0.006 m: the nearest point to a far point is its clamp onto the box.
  const box = { min: [0, 0, 0], max: [0.01, 0.02, 0.006] };
  const calls: Array<{ ids: number[]; positions: number[]; offsets: number[] }> = [];
  class Eval {
    DistancesToPoints(ids: Int32Array, positions: Float64Array, offsets: Int32Array) {
      calls.push({ ids: Array.from(ids), positions: Array.from(positions), offsets: Array.from(offsets) });
      const nearests: number[] = [];
      for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k += 1) nearests.push(Math.min(box.max[k]!, Math.max(box.min[k]!, positions[i + k]!)));
      return { nearests: Float64Array.from(nearests), errors: Int32Array.from(Array(positions.length / 3).fill(0)), ok: positions.length / 3 };
    }
  }
  class Solid {}
  const model = { Id: () => 4242, FindBox: () => ({ min: new KVector(0, 0, 0), max: new KVector(0.01, 0.02, 0.006) }) };
  const editor = { geo: { geometryModel: new Map([[17, { view: new Solid(), model }]]), automatics: new Set() }, db: { lookupStableId: (v: number) => (v === 17 ? 7 : undefined), commit() {} } };
  const runtime = {
    async readNative(source: string, bindings: string[], values: unknown[]) {
      assert.deepEqual(bindings, ["pk_default"]);
      assert.equal(source, EXACT_BOUNDS_SOURCE);
      const execute = new Function(`return (${source})`)() as (...args: unknown[]) => unknown;
      return execute.apply(editor, [{ a: { Eval, Context: { Get: () => ({}) } } }, ...values]);
    },
  } as unknown as PlasticityRuntime;
  const state = { revision: "r1", bodies: [{ id: 7, versionId: 17, type: "Solid", name: null, boundsMm: { min: [0, 0, 0], max: [10, 20, 6] }, boundsMethod: "native-box", faceIds: [], edgeIds: [], faces: [], edges: [] }] } as unknown as RuntimeState;
  const evidence = await exactBounds(runtime, state, [7]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.ids, [4242]);
  assert.deepEqual(calls[0]!.offsets, [0, 12]);
  assert.equal(calls[0]!.positions.length, 36);
  assert.deepEqual(evidence.bodies[0]!.boundsMm, { min: [0, 0, 0], max: [10, 20, 6] });
  assert.equal(evidence.bodies[0]!.exact, true);
  assert.equal(evidence.bodies[0]!.radiiDisagreementMm, 0);
});

test("D7: SURFACE_ALIGN_READBACK_SOURCE runs against stub kernel edges: the matching moving edge, the two-way gap and the tangent-plane angle", async () => {
  // Reference edge: x = 0.03, z from 0 to 0.02. Moving body: an edge 1e-7 m off it (0.0001 mm) and one far edge.
  const segment = (a: V, b: V, id: number, normal: V) => {
    const lerp = (t: number): V => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const near = (p: KVector) => { const d: V = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w: V = [p.x - a[0], p.y - a[1], p.z - a[2]]; const t = Math.min(1, Math.max(0, (w[0] * d[0] + w[1] * d[1] + w[2] * d[2]) / (d[0] ** 2 + d[1] ** 2 + d[2] ** 2))); return { t, exact: new KVector(...lerp(t)) }; };
    const face = { FindPointNear: (p: KVector) => ({ u: 0, v: 0, exact: p }), EvalBasis: () => ({ normal: new KVector(...normal) }) };
    return { Id: () => id, GetPoint: (t: number) => new KVector(...lerp(t)), FindPointNear: near, GetFaces: () => ({ GetFaces: () => [face] }) };
  };
  const refEdge = segment([0.03, 0, 0], [0.03, 0, 0.02], 11, [0, 1, 0]);
  const near = segment([0.0300001, 0, 0], [0.0300001, 0, 0.02], 21, [0, -1, 0]);
  const far = segment([0.06, 0.03, 0], [0.06, 0.03, 0.02], 22, [1, 0, 0]);
  const body = (edges: unknown[], versionIds: string[], entities: number[]) => ({
    view: { high: { edges: { versionIds, get: (i: number) => ({ entityId: entities[i] }) } } },
    model: { GetEdges: () => ({ GetEdges: () => edges }) },
  });
  const editor = {
    geo: { geometryModel: new Map([[107, body([refEdge], ["7e1"], [11])], [108, body([far, near], ["8e1", "8e2"], [22, 21])]]), automatics: new Set() },
    db: { lookupStableId: (v: number) => v - 100, commit() {} },
  };
  const execute = new Function(`return (${SURFACE_ALIGN_READBACK_SOURCE})`)() as (...args: unknown[]) => { referenceFound: boolean; movingEdgeId: string; maxGapM: number; maxNormalAngleDeg: number; samples: number };
  const result = execute.apply(editor, [{ reference: { bodyId: 7, edgeId: "7e1" }, movingBodyId: 8, samples: 21 }]);
  assert.equal(result.referenceFound, true);
  assert.equal(result.movingEdgeId, "8e2");
  assert.ok(Math.abs(result.maxGapM - 1e-7) < 1e-12, String(result.maxGapM));
  assert.ok(result.maxNormalAngleDeg < 1e-9);
  assert.equal(result.samples, 21);
  const missing = execute.apply(editor, [{ reference: { bodyId: 7, edgeId: "gone" }, movingBodyId: 8, samples: 21 }]);
  assert.equal(missing.referenceFound, false);
});
