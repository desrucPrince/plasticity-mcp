import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer, type SessionLike } from "./server.ts";
import type { PlasticityOperations } from "./plasticity/operations.ts";
import type { RuntimeState } from "./plasticity/runtime.ts";
import type { ContinuityPlanResult } from "./plasticity/surfacing.ts";

// Server registration of the continuity gate (spec bench/specs/gate.md): plasticity_check_continuity_plan (strict schema,
// read-only, assert mode as an MCP error that stops a plasticity_batch) and the new continuity report option.

async function withClient<T>(operations: Record<string, (...args: any[]) => Promise<unknown>>, run: (client: Client) => Promise<T>): Promise<T> {
  const fake = {
    async windows() { return []; },
    async connect() { return {}; },
    get() { return operations as unknown as PlasticityOperations; },
    capabilities() { return { bindings: [], operations: { constructionPlanes: { available: false, reason: "test" }, activeWorkplane: { available: false, reason: "test" } } }; },
    async captureSnapshot() { return {}; },
    async changesSince() { return {}; },
    async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake, undefined, undefined, undefined, null);
  const client = new Client({ name: "gate-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

function state(revision: string): RuntimeState {
  return {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision,
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" },
    bodies: [{ id: 317, versionId: 317, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] }],
  } as unknown as RuntimeState;
}

function text(response: unknown): string {
  const content = (response as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.find((entry) => entry.type === "text")?.text ?? "";
}

const failing: ContinuityPlanResult = {
  pass: false,
  firstFailure: { item: "flank/side", itemIndex: 1, edgeId: "1e842", target: "G2", achieved: "G1", reason: "30 interior samples fail G2" },
  items: [
    { name: "band/side", index: 0, target: "G2", region: "interior", matched: 1, pass: true, edges: [{ edgeId: "1e636", achieved: "G2 (not measurable: flat across)", pass: true, normalAngleDegInteriorMax: 0, normalAngleDegInteriorMin: 0, relCurvatureInteriorMax: null, g2Status: "flat-across" }] },
    { name: "flank/side", index: 1, target: "G2", region: "interior", matched: 1, pass: false, edges: [{ edgeId: "1e842", achieved: "G1", pass: false, normalAngleDegInteriorMax: 0.0096, normalAngleDegInteriorMin: 0, relCurvatureInteriorMax: 1, g2Status: "partly-flat", reason: "30 interior samples fail G2" }] },
  ],
  unmatchedTwoFaceEdges: 72,
  seamEdgesNotChecked: { count: 2, edgeIds: ["1e479", "1e499"] },
};
const PLAN = [
  { name: "band/side", select: { throughPointMm: [42.0, -5.6, 101.8] }, target: "G2" },
  { name: "flank/side", select: { throughPointMm: [44.3, -4.28, 29.28] }, target: "G2" },
  { select: { rest: true }, target: "any" },
];

test("plasticity_check_continuity_plan is registered read-only with a strict schema and forwards the plan", async () => {
  const received: unknown[][] = [];
  await withClient({
    async state() { return state("r1"); },
    async checkContinuityPlan(...args: unknown[]) { received.push(args); return { ...failing, pass: true, firstFailure: null }; },
  }, async (client) => {
    const tools = (await client.listTools()).tools;
    const entry = tools.find((candidate) => candidate.name === "plasticity_check_continuity_plan");
    assert.ok(entry);
    assert.equal(entry!.annotations?.readOnlyHint, true);
    assert.equal(entry!.annotations?.destructiveHint, false);
    assert.equal((entry!.inputSchema as { additionalProperties?: unknown }).additionalProperties, false);
    assert.match(entry!.description ?? "", /Continuity plan failed:/);
    assert.match(entry!.description ?? "", /plasticity_batch/);
    const reply = JSON.parse(text(await client.callTool({ name: "plasticity_check_continuity_plan", arguments: { bodyId: 317, plan: PLAN, revision: "r1" } })));
    assert.equal(reply.pass, true);
    assert.equal(reply.mode, "report");
    assert.deepEqual(received[0], [{ bodyId: 317, plan: PLAN }, "r1"]);
    await client.callTool({ name: "plasticity_check_continuity_plan", arguments: { bodyId: 317, plan: PLAN, defaults: { normalAngleToleranceDeg: 0.5, absoluteCurvatureTolerancePerMm: 0.002 }, mode: "report", revision: "r1" } });
    assert.deepEqual(received[1], [{ bodyId: 317, plan: PLAN, defaults: { normalAngleToleranceDeg: 0.5, absoluteCurvatureTolerancePerMm: 0.002 } }, "r1"]);
  });
});

test("plasticity_check_continuity_plan rejects malformed plans before reading anything", async () => {
  let calls = 0;
  await withClient({
    async state() { return state("r1"); },
    async checkContinuityPlan() { calls += 1; return failing; },
  }, async (client) => {
    const bad = async (args: Record<string, unknown>) => (await client.callTool({ name: "plasticity_check_continuity_plan", arguments: { bodyId: 317, revision: "r1", ...args } })).isError;
    assert.equal(await bad({ plan: [{ select: { rest: true }, target: "any" }, { select: { edgeIds: ["e"] }, target: "G2" }] }), true, "rest not last");
    assert.equal(await bad({ plan: [{ select: { rest: true }, target: "any" }, { select: { rest: true }, target: "any" }] }), true, "two rests");
    assert.equal(await bad({ plan: [{ select: { faceIds: ["f1", "f1"] }, target: "G2" }] }), true, "same face twice");
    assert.equal(await bad({ plan: [{ select: { edgeIds: ["e"] }, target: "G3" }] }), true, "unknown target");
    assert.equal(await bad({ plan: [{ select: { edgeIds: ["e"] }, target: "G2", extra: 1 }] }), true, "unknown item key");
    assert.equal(await bad({ plan: [{ select: { edgeIds: ["e"], faceIds: ["a", "b"] }, target: "G2" }] }), true, "two selectors");
    assert.equal(await bad({ plan: [{ select: { throughPointMm: [0, 0] }, target: "G2" }] }), true, "2D point");
    assert.equal(await bad({ plan: [{ select: { edgeIds: ["e"] }, target: "G2", expectCount: -1 }] }), true, "negative expectCount");
    assert.equal(await bad({ plan: [{ select: { edgeIds: ["e"] }, target: "G2" }], defaults: { absoluteCurvatureTolerancePerMm: 0 } }), true, "zero absolute tolerance");
    assert.equal(await bad({ plan: [{ select: { edgeIds: ["e"] }, target: "G2" }], mode: "strict" }), true, "unknown mode");
    assert.equal(await bad({ plan: [] }), true, "empty plan");
    assert.equal(calls, 0);
  });
});

test("mode assert turns a failing plan into an MCP error starting 'Continuity plan failed:'; report mode returns it", async () => {
  await withClient({
    async state() { return state("r1"); },
    async checkContinuityPlan() { return failing; },
  }, async (client) => {
    const report = await client.callTool({ name: "plasticity_check_continuity_plan", arguments: { bodyId: 317, plan: PLAN, revision: "r1" } });
    assert.notEqual(report.isError, true);
    assert.equal(JSON.parse(text(report)).firstFailure.edgeId, "1e842");
    const asserted = await client.callTool({ name: "plasticity_check_continuity_plan", arguments: { bodyId: 317, plan: PLAN, mode: "assert", revision: "r1" } });
    assert.equal(asserted.isError, true);
    assert.ok(text(asserted).startsWith("Continuity plan failed: item flank/side, edge 1e842, target G2, achieved G1: 30 interior samples fail G2"), text(asserted));
  });
  // A passing plan in assert mode is an ordinary reply.
  await withClient({
    async state() { return state("r1"); },
    async checkContinuityPlan() { return { ...failing, pass: true, firstFailure: null }; },
  }, async (client) => {
    const passing = await client.callTool({ name: "plasticity_check_continuity_plan", arguments: { bodyId: 317, plan: PLAN, mode: "assert", revision: "r1" } });
    assert.notEqual(passing.isError, true);
    assert.equal(JSON.parse(text(passing)).pass, true);
  });
});

test("through plasticity_call (the compact-tools route) assert mode still fails with text starting 'Continuity plan failed:'", async () => {
  await withClient({
    async state() { return state("r1"); },
    async checkContinuityPlan() { return failing; },
  }, async (client) => {
    const routed = await client.callTool({ name: "plasticity_call", arguments: { toolName: "plasticity_check_continuity_plan", arguments: { bodyId: 317, plan: PLAN, mode: "assert", revision: "r1" } } });
    assert.equal(routed.isError, true);
    assert.ok(text(routed).startsWith("Continuity plan failed: item flank/side"), text(routed));
    const catalog = JSON.parse(text(await client.callTool({ name: "plasticity_call", arguments: { toolName: "catalog", query: "plasticity_check_continuity_plan" } })));
    assert.equal(catalog.tools[0].name, "plasticity_check_continuity_plan");
  });
});

test("an assert-mode failure stops plasticity_batch at that step; a report-mode step does not", async () => {
  let statusCalls = 0;
  await withClient({
    async state() { return state("r1"); },
    async checkContinuityPlan() { return failing; },
    async listBodies() { statusCalls += 1; return []; },
  }, async (client) => {
    const stopped = await client.callTool({ name: "plasticity_batch", arguments: { steps: [
      { toolName: "plasticity_check_continuity_plan", arguments: { bodyId: 317, plan: PLAN, mode: "assert" } },
      { toolName: "plasticity_check_continuity_plan", arguments: { bodyId: 317, plan: PLAN } },
    ] } });
    assert.equal(stopped.isError, true);
    const failure = JSON.parse(text(stopped));
    assert.equal(failure.failedStep, 0);
    assert.equal(failure.toolName, "plasticity_check_continuity_plan");
    assert.ok(String(failure.error).startsWith("Continuity plan failed:"), failure.error);
    assert.deepEqual(failure.completedSteps, []);
    const reported = await client.callTool({ name: "plasticity_batch", arguments: { steps: [
      { toolName: "plasticity_check_continuity_plan", arguments: { bodyId: 317, plan: PLAN }, return: ["pass", "firstFailure"] },
    ] } });
    assert.notEqual(reported.isError, true);
    const steps = JSON.parse(text(reported)).steps;
    assert.equal(steps[0].result.pass, false);
    assert.equal(steps[0].result.firstFailure.edgeId, "1e842");
  });
  assert.equal(statusCalls, 0);
});

test("plasticity_continuity_report and plasticity_analyze_surface_continuity accept absoluteCurvatureTolerancePerMm (> 0, finite) and forward it only when given", async () => {
  const received: Record<string, unknown[][]> = { report: [], analyze: [] };
  await withClient({
    async state() { return state("r1"); },
    async continuityReport(...args: unknown[]) { received.report!.push(args); return { edgeCount: 0 }; },
    async analyzeSurfaceContinuity(...args: unknown[]) { received.analyze!.push(args); return { analyses: [] }; },
  }, async (client) => {
    await client.callTool({ name: "plasticity_continuity_report", arguments: { bodyId: 3, absoluteCurvatureTolerancePerMm: 0.002, revision: "r1" } });
    assert.deepEqual(received.report![0], [{ bodyId: 3, positionToleranceMm: 0.01, normalAngleToleranceDeg: 0.1, relativeCurvatureTolerance: 0.05, absoluteCurvatureTolerancePerMm: 0.002 }, "r1"]);
    for (const bad of [0, -1, "x"]) assert.equal((await client.callTool({ name: "plasticity_continuity_report", arguments: { bodyId: 3, absoluteCurvatureTolerancePerMm: bad, revision: "r1" } })).isError, true, String(bad));
    await client.callTool({ name: "plasticity_analyze_surface_continuity", arguments: { edges: [{ bodyId: 3, edgeId: "e" }], absoluteCurvatureTolerancePerMm: 0.004, revision: "r1" } });
    assert.deepEqual(received.analyze![0], [[{ bodyId: 3, edgeId: "e" }], "r1", 0.01, 0.1, 0.05, { extended: true, absoluteCurvatureTolerancePerMm: 0.004 }]);
    await client.callTool({ name: "plasticity_analyze_surface_continuity", arguments: { edges: [{ bodyId: 3, edgeId: "e" }], revision: "r1" } });
    assert.deepEqual(received.analyze![1], [[{ bodyId: 3, edgeId: "e" }], "r1", 0.01, 0.1, 0.05, { extended: true }]);
    assert.equal((await client.callTool({ name: "plasticity_analyze_surface_continuity", arguments: { edges: [{ bodyId: 3, edgeId: "e" }], absoluteCurvatureTolerancePerMm: 0, revision: "r1" } })).isError, true);
    const descriptions = Object.fromEntries((await client.listTools()).tools.map((entry) => [entry.name, entry.description ?? ""]));
    assert.match(descriptions.plasticity_continuity_report!, /absoluteCurvatureTolerancePerMm/);
    assert.match(descriptions.plasticity_analyze_surface_continuity!, /absoluteCurvatureTolerancePerMm/);
  });
});

test("C1: plasticity_delete_edges reports allRemoved, or remainingEdges matched by geometry under their new ids", async () => {
  const edge = (id: string, vertexIds: number[], lengthMm: number) => ({ id, curveType: "Line", line: true, circle: false, lengthMm, centerMm: [0, 0, 0], tangent: [1, 0, 0], boundsMm: { min: [0, 0, 0], max: [1, 0, 0] }, faceIds: ["f1", "f2"], vertexIds });
  const vertices = [{ id: 1, positionMm: [0, 0, 0], edgeIds: [], faceIds: [] }, { id: 2, positionMm: [10, 0, 0], edgeIds: [], faceIds: [] }, { id: 3, positionMm: [10, 10, 0], edgeIds: [], faceIds: [] }];
  const scene = (revision: string, edges: unknown[], vertexList = vertices) => ({ ...state(revision), bodies: [{ id: 7, versionId: 70, type: "Solid", name: null, boundsMm: null, faceIds: ["f1", "f2"], edgeIds: (edges as Array<{ id: string }>).map((e) => e.id), faces: [], edges, vertices: vertexList }] }) as unknown as RuntimeState;
  let current = scene("r1", [edge("e1", [1, 2], 10), edge("e2", [2, 3], 10)]);
  let after = scene("r2", [edge("e9", [2, 3], 10)]);
  await withClient({
    async state() { return current; },
    async deleteEdges() { current = after; return current; },
  }, async (client) => {
    const gone = JSON.parse(text(await client.callTool({ name: "plasticity_delete_edges", arguments: { edges: [{ bodyId: 7, edgeId: "e1" }], revision: "r1" } })));
    assert.equal(gone.allRemoved, true);
    assert.deepEqual(gone.remainingEdges, []);
    // e2 survives the native call (a structural edge) with a new id: reported, not a silent success.
    current = scene("r1", [edge("e1", [1, 2], 10), edge("e2", [2, 3], 10)]);
    after = scene("r2", [edge("e7", [3, 2], 10.0004)], [vertices[1]!, { ...vertices[2]!, positionMm: [10, 10.0005, 0] }]);
    const stuck = JSON.parse(text(await client.callTool({ name: "plasticity_delete_edges", arguments: { edges: [{ bodyId: 7, edgeId: "e1" }, { bodyId: 7, edgeId: "e2" }], revision: "r1" } })));
    assert.equal(stuck.allRemoved, false);
    assert.deepEqual(stuck.remainingEdges, [{ edgeId: "e7", lengthMm: 10.0004, endpointsMm: [[10, 10.0005, 0], [10, 0, 0]] }]);
    // Same ends but a different length (a rebuilt curve) is not the requested edge.
    current = scene("r1", [edge("e2", [2, 3], 10)]);
    after = scene("r2", [edge("e8", [2, 3], 10.01)]);
    assert.equal(JSON.parse(text(await client.callTool({ name: "plasticity_delete_edges", arguments: { edges: [{ bodyId: 7, edgeId: "e2" }], revision: "r1" } }))).allRemoved, true);
  });
});

test("C2: plasticity_continuity_report curvatureRange needs curvatureSamples, is validated and forwarded", async () => {
  const received: unknown[][] = [];
  await withClient({
    async state() { return state("r1"); },
    async continuityReport(...args: unknown[]) { received.push(args); return { wires: [] }; },
  }, async (client) => {
    await client.callTool({ name: "plasticity_continuity_report", arguments: { wireIds: [4], curvatureSamples: 5, curvatureRange: [0.2, 0.8], revision: "r1" } });
    assert.deepEqual(received[0], [{ wireIds: [4], curvatureSamples: 5, curvatureRange: [0.2, 0.8], positionToleranceMm: 0.01, normalAngleToleranceDeg: 0.1, relativeCurvatureTolerance: 0.05 }, "r1"]);
    for (const bad of [{ curvatureRange: [0.2, 0.8] }, { curvatureSamples: 5, curvatureRange: [0.8, 0.2] }, { curvatureSamples: 5, curvatureRange: [0.5, 0.5] }, { curvatureSamples: 5, curvatureRange: [-0.1, 0.5] }, { curvatureSamples: 5, curvatureRange: [0, 1.5] }]) {
      assert.equal((await client.callTool({ name: "plasticity_continuity_report", arguments: { wireIds: [4], revision: "r1", ...bad } })).isError, true, JSON.stringify(bad));
    }
  });
});

test("follow-up 4: a removal check that fails after a completed native delete returns allRemoved null with a note, not an error", async () => {
  const good = { ...state("r1"), bodies: [{ id: 7, versionId: 70, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: ["e1"], faces: [], edges: [{ id: "e1", lengthMm: 10, centerMm: [0, 0, 0], faceIds: ["f1", "f2"], vertexIds: [1, 2] }], vertices: [] }] } as unknown as RuntimeState;
  // After the delete the body reads back with edges the check cannot use (vertexIds missing): it throws inside.
  const broken = { ...state("r2"), bodies: [{ id: 7, versionId: 71, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: ["e5"], faces: [], edges: [{ id: "e5", lengthMm: 10, centerMm: [0, 0, 0], faceIds: ["f1", "f2"] }] }] } as unknown as RuntimeState;
  let current = good;
  let reads = 0;
  await withClient({
    async state() { reads += 1; return current; },
    async deleteEdges() { current = broken; return current; },
  }, async (client) => {
    const reply = await client.callTool({ name: "plasticity_delete_edges", arguments: { edges: [{ bodyId: 7, edgeId: "e1" }], revision: "r1" } });
    assert.notEqual(reply.isError, true, text(reply));
    const value = JSON.parse(text(reply));
    assert.equal(value.allRemoved, null);
    assert.match(value.deleteCheckNote, /removal check failed after the native delete completed/);
    assert.equal(value.revision, "r2");
  });
  // The check uses the journal's before and after reads: no state read of its own.
  assert.equal(reads, 2);
});
