import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createCompactServer, type SessionLike } from "./server.ts";
import type { ConstructionHistoryEntry, ConstructionHistoryStore } from "./plasticity/construction-history.ts";
import { PlasticityOperations } from "./plasticity/operations.ts";
import type { PlasticityRuntime, RevisionProbe, RuntimeState } from "./plasticity/runtime.ts";

// Batch state reuse: inside plasticity_batch the state read after step k stands in for the journal-before, the
// revision check and the before-state of step k+1. These tests drive the real PlasticityOperations over a counting
// fake runtime and compare every observable result with the pre-change path (reuse off) and with direct calls.

type Vec = [number, number, number];
type Body = RuntimeState["bodies"][number];
type Event = { kind: "state" | "probe" | "mutate" | "step"; binding?: string };

const lineEdge = (id: string, center: Vec, lengthMm = 10) => ({
  id, curveType: "Line", line: true, circle: false, lengthMm, centerMm: center, tangent: [0, 0, 1],
  boundsMm: { min: center, max: center }, faceIds: ["f-top"], vertexIds: [],
});
const circleEdge = (id: string, center: Vec, lengthMm: number) => ({ ...lineEdge(id, center, lengthMm), curveType: "Circle", line: false, circle: true });

function boxBody(id: number, versionId: number, origin: Vec, size: Vec, name: string | null): Body {
  const max: Vec = [origin[0] + size[0], origin[1] + size[1], origin[2] + size[2]];
  const edges = [
    lineEdge(`${id}e1`, [origin[0], origin[1], origin[2] + size[2] / 2]),
    lineEdge(`${id}e2`, [max[0], origin[1], origin[2] + size[2] / 2]),
    lineEdge(`${id}e3`, [max[0], max[1], origin[2] + size[2] / 2]),
    lineEdge(`${id}e4`, [origin[0], max[1], origin[2] + size[2] / 2]),
  ];
  const faces = [{
    id: `${id}f1`, surfaceType: "Plane", planar: true, centerMm: [(origin[0] + max[0]) / 2, (origin[1] + max[1]) / 2, max[2]], normal: [0, 0, 1],
    radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [origin[0], origin[1], max[2]], max }, edgeIds: edges.map((edge) => edge.id),
  }];
  return {
    id, versionId, type: "Solid", name, materialId: 0, visible: true, hidden: false, locked: false,
    boundsMm: { min: origin, max }, boundsMethod: "native-box",
    faceIds: faces.map((face) => face.id), edgeIds: edges.map((edge) => edge.id), faces, edges, vertices: [],
  } as unknown as Body;
}

// A document with undo history. Every mutate() is one Undo entry with a new revision; undo restores the previous one.
class CountingRuntime {
  events: Event[] = [];
  private current: RuntimeState;
  private readonly undoStack: RuntimeState[] = [];
  private version = 1;
  private nextId = 10;
  private mutations = 0;
  private uncertain = false;
  failNextMutate: Error | undefined;

  constructor() {
    this.current = {
      targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0,
      regions: [], construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "workplane:none" },
      bodies: [boxBody(1, 100, [0, 0, 0], [40, 30, 10], "plate")],
    } as unknown as RuntimeState;
  }

  count(kind: Event["kind"], from = 0, to = this.events.length) {
    return this.events.slice(from, to).filter((event) => event.kind === kind).length;
  }

  isUncertain() { return this.uncertain; }
  mutationCount() { return this.mutations; }

  async getState(): Promise<RuntimeState> {
    this.events.push({ kind: "state" });
    return structuredClone(this.current);
  }

  async readRevisionProbe(): Promise<RevisionProbe> {
    this.events.push({ kind: "probe" });
    const state = this.current;
    return {
      documentToken: state.documentToken, revision: state.revision, viewStateToken: state.construction.viewStateToken,
      activePlaneId: state.construction.activePlaneId, bodyNames: state.bodies.map((body) => [body.id, body.name]), regions: structuredClone(state.regions),
    };
  }

  // A change made in the Plasticity UI: a new revision and Undo entry, without this process calling mutate().
  externalEdit(): void {
    this.commit((bodies) => [...bodies, boxBody(this.nextId++, 9_000 + this.version, [500, 0, 0], [5, 5, 5], "user")], "ext");
  }

  // A UI change the revision does not hash (a body rename).
  externalRename(id: number, name: string): void {
    this.current = { ...this.current, bodies: this.current.bodies.map((body) => (body.id === id ? { ...body, name } : body)) } as RuntimeState;
  }

  async mutate<T>(_source: string, bindings: string[], values: unknown[] = []): Promise<T> {
    this.mutations += 1;
    const binding = bindings[0] ?? "history";
    this.events.push({ kind: "mutate", binding });
    if (this.uncertain) throw new Error("Previous mutation outcome is uncertain; call reconcile before another mutation");
    if (this.failNextMutate) {
      const failure = this.failNextMutate;
      this.failNextMutate = undefined;
      if (/^CDP request timed out:/.test(failure.message)) {
        this.commit((bodies) => bodies); // the command may have landed: the outcome is unknown
        this.uncertain = true;
      }
      throw failure;
    }
    const args = (values[0] ?? {}) as Record<string, any>;
    if (binding === "ThreePointBoxFactory") {
      const mm = (value: number) => Math.round(value * 1e6) / 1e3;
      const id = this.nextId++;
      this.commit((bodies) => [...bodies, boxBody(id, id * 10, args.origin.map(mm), args.size.map(mm), args.name ?? null)]);
    } else if (binding === "BooleanFactory") {
      this.commit((bodies) => bodies.filter((body) => !args.toolIds.includes(body.id)).map((body) => (args.targetIds.includes(body.id)
        ? { ...body, versionId: body.versionId + 1, edges: [...body.edges, circleEdge(`${body.id}s${this.version}`, [9, 9, 9], 6.2831)] } as Body
        : body)));
    } else if (binding === "FilletShellFactory") {
      this.commit((bodies) => bodies.map((body) => (body.id === args.id
        ? { ...body, versionId: body.versionId + 1, edges: body.edges.filter((edge) => !args.edgeIds.includes(edge.id)) } as Body
        : body)));
    } else if (binding === "history" && args.direction === "undo") {
      const previous = this.undoStack.pop();
      if (!previous) return "empty" as T;
      this.version += 1;
      this.current = { ...previous, revision: `r${this.version}`, dbVersion: this.version, redoDepth: this.current.redoDepth + 1 } as RuntimeState;
      return "applied" as T;
    } else {
      throw new Error(`fake runtime: unsupported mutation ${binding}`);
    }
    return undefined as T;
  }

  async read<T>(): Promise<T> { return undefined as T; }
  async readNative<T>(): Promise<T> { return undefined as T; }

  private commit(change: (bodies: Body[]) => Body[], suffix = ""): void {
    this.undoStack.push(this.current);
    this.version += 1;
    this.current = {
      ...this.current, bodies: change(this.current.bodies), revision: `r${this.version}${suffix}`, dbVersion: this.version,
      undoDepth: this.current.undoDepth + 1, redoDepth: 0,
    } as RuntimeState;
  }
}

// Marks each batch step (and the batch end) in the event log. reuse=false keeps the pre-change path: no reuse at all.
class MarkedOperations extends PlasticityOperations {
  onStep: (() => void) | undefined;
  readonly counting: CountingRuntime;
  private readonly reuse: boolean;
  constructor(counting: CountingRuntime, reuse: boolean) {
    super(counting as unknown as PlasticityRuntime, "session-1");
    this.counting = counting;
    this.reuse = reuse;
  }
  override beginStateReuse(): void {
    if (this.reuse) super.beginStateReuse();
  }
  override beginStateReuseStep(): void {
    this.counting.events.push({ kind: "step" });
    this.onStep?.();
    super.beginStateReuseStep();
  }
}

function harness(reuse = true) {
  const runtime = new CountingRuntime();
  const operations = new MarkedOperations(runtime, reuse);
  const journal: ConstructionHistoryEntry[] = [];
  const history = { async append(entry: ConstructionHistoryEntry) { journal.push(entry); } } as unknown as ConstructionHistoryStore;
  const session = {
    async windows() { return []; }, async connect() { return null; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: operations.constructionCapabilities() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createCompactServer(session, undefined, undefined, undefined, history);
  const client = new Client({ name: "batch-state-reuse", version: "1.0.0" });
  return {
    runtime, operations, journal, client,
    async open() {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport); await client.connect(clientTransport);
    },
    async call(name: string, args: Record<string, unknown>) {
      const response = await client.callTool({ name, arguments: args });
      const text = (response.content as Array<{ type: string; text?: string }>).find((part) => part.type === "text")?.text ?? "";
      return { isError: response.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return text; } })() };
    },
    async close() { await client.close(); await server.close(); },
  };
}

async function opened(reuse = true) {
  const h = harness(reuse);
  await h.open();
  return h;
}

// Per batch step counts of full state reads and probes. Segment 0 is the batch start, the last one the batch end.
function perStep(runtime: CountingRuntime, from = 0) {
  const events = runtime.events.slice(from);
  const segments: Array<{ state: number; probe: number }> = [{ state: 0, probe: 0 }];
  for (const event of events) {
    if (event.kind === "step") segments.push({ state: 0, probe: 0 });
    else if (event.kind === "state" || event.kind === "probe") segments[segments.length - 1]![event.kind] += 1;
  }
  return segments;
}

const comparable = (entries: ConstructionHistoryEntry[]) => entries.map(({ id: _id, occurredAt: _at, ...rest }) => rest);

const FIXTURE_STEPS = [
  { toolName: "plasticity_create_box", arguments: { originMm: [100, 0, 0], sizeMm: [10, 10, 10], name: "block" } },
  { toolName: "plasticity_create_box", arguments: { originMm: [102, 2, 5], sizeMm: [2, 2, 10] } },
  { toolName: "plasticity_boolean", arguments: { targetIds: ["$0.added[0]"], toolIds: ["$1.added[0]"], operation: "difference" } },
  { toolName: "plasticity_find_edges", arguments: { query: { bodyIds: ["$0.added[0]"], line: true } } },
  { toolName: "plasticity_fillet", arguments: { id: "$0.added[0]", edgeIds: "$3.result.matches[*].id", radiusMm: 1 } },
];

test("constraint 1+3 (read counts): an edit, a boolean and a read step each take at most one full state read in a batch", async () => {
  const on = await opened(true);
  const reply = await on.call("plasticity_batch", { steps: FIXTURE_STEPS });
  assert.equal(reply.isError, false, reply.text);
  const steps = perStep(on.runtime);
  assert.equal(steps.length, FIXTURE_STEPS.length + 2, "start, one segment per step, end");
  assert.deepEqual(steps[0], { state: 1, probe: 0 }, "batch start: one full read");
  assert.deepEqual(steps[1], { state: 1, probe: 1 }, "create_box: one full read after the mutation, one probe before reusing");
  assert.deepEqual(steps[2], { state: 1, probe: 1 }, "create_box");
  assert.deepEqual(steps[3], { state: 1, probe: 1 }, "boolean (created-edge detection reuses both reads)");
  assert.deepEqual(steps[4], { state: 0, probe: 1 }, "find_edges read step: no full read");
  assert.deepEqual(steps[5], { state: 1, probe: 1 }, "fillet");
  assert.deepEqual(steps[6], { state: 0, probe: 1 }, "batch end: probed, not re-read");
  await on.close();

  const off = await opened(false);
  assert.equal((await off.call("plasticity_batch", { steps: FIXTURE_STEPS })).isError, false);
  const before = perStep(off.runtime);
  assert.deepEqual(before.map((segment) => segment.state), [1, 5, 5, 7, 1, 5, 1], "the pre-change path: 5 reads per edit, 7 per boolean");
  assert.equal(off.runtime.count("probe"), 0);
  await off.close();
});

test("constraint 1: direct tool calls read exactly as before and never probe, also after a batch", async () => {
  const h = await opened(true);
  const direct = async (name: string, args: Record<string, unknown>) => {
    const from = h.runtime.events.length;
    const revision = (await h.operations.state()).revision;
    const afterRevisionRead = h.runtime.events.length;
    const reply = await h.call(name, { ...args, revision });
    assert.equal(reply.isError, false, reply.text);
    assert.equal(from + 1, afterRevisionRead);
    return { state: h.runtime.count("state", afterRevisionRead), probe: h.runtime.count("probe", afterRevisionRead), reply };
  };
  const box = await direct("plasticity_create_box", { originMm: [100, 0, 0], sizeMm: [10, 10, 10] });
  assert.deepEqual({ state: box.state, probe: box.probe }, { state: 4, probe: 0 }, "journal before, revision check, result, journal after");
  const toolId = (await direct("plasticity_create_box", { originMm: [102, 2, 5], sizeMm: [2, 2, 10] })).reply.json.change.added[0].id;
  const boolean = await direct("plasticity_boolean", { targetIds: [1], toolIds: [toolId], operation: "difference" });
  assert.deepEqual({ state: boolean.state, probe: boolean.probe }, { state: 6, probe: 0 }, "plus the before/after reads for createdEdges");
  const find = await direct("plasticity_find_edges", { query: { bodyIds: [1] } });
  assert.deepEqual({ state: find.state, probe: find.probe }, { state: 1, probe: 0 });

  assert.equal((await h.call("plasticity_batch", { steps: FIXTURE_STEPS })).isError, false);
  const afterBatch = await direct("plasticity_create_box", { originMm: [300, 0, 0], sizeMm: [1, 1, 1] });
  assert.deepEqual({ state: afterBatch.state, probe: afterBatch.probe }, { state: 4, probe: 0 }, "the batch turned reuse off again");
  await h.close();
});

test("constraint 2: a UI edit between steps is caught by the probe and fails the step as a stale revision, without writing", async () => {
  const run = async (reuse: boolean) => {
    const h = await opened(reuse);
    let step = 0;
    h.operations.onStep = () => { if (++step === 2) h.runtime.externalEdit(); };
    const reply = await h.call("plasticity_batch", { steps: [
      { toolName: "plasticity_create_box", arguments: { originMm: [100, 0, 0], sizeMm: [10, 10, 10] } },
      { toolName: "plasticity_create_box", arguments: { originMm: [200, 0, 0], sizeMm: [10, 10, 10] } },
    ] });
    const boxes = h.runtime.events.filter((event) => event.kind === "mutate" && event.binding === "ThreePointBoxFactory").length;
    const result = { isError: reply.isError, error: reply.json, boxes, journal: comparable(h.journal), probes: h.runtime.count("probe") };
    await h.close();
    return result;
  };
  const on = await run(true);
  const off = await run(false);
  assert.equal(on.isError, true);
  assert.equal(on.error.failedStep, 1);
  assert.match(on.error.error, /^Stale reference: expected revision r2, current revision is r3ext$/);
  assert.equal(on.boxes, 1, "the second box was never written");
  assert.ok(on.probes >= 1);
  assert.deepEqual({ ...on, probes: 0 }, { ...off, probes: 0 }, "same error, same journal as the pre-change path");
});

test("constraint 2: a UI change the revision does not hash (a rename) also forces a full read", async () => {
  const h = await opened(true);
  let step = 0;
  h.operations.onStep = () => { if (++step === 2) h.runtime.externalRename(1, "renamed-in-ui"); };
  const reply = await h.call("plasticity_batch", { steps: [
    { toolName: "plasticity_create_box", arguments: { originMm: [100, 0, 0], sizeMm: [10, 10, 10] } },
    { toolName: "plasticity_find_faces", arguments: { query: { bodyIds: [1] } }, return: ["count"] },
    { toolName: "plasticity_list_bodies", arguments: {}, return: ["bodies[*].name"] },
  ] });
  assert.equal(reply.isError, false, reply.text);
  assert.deepEqual(perStep(h.runtime)[2], { state: 1, probe: 1 }, "the probe mismatched, so the step read the document again");
  assert.match(JSON.stringify(reply.json.steps[2].result), /renamed-in-ui/, "later steps see the UI change");
  await h.close();
});

test("constraint 3: journal entries equal the pre-change batch and the same steps as direct calls", async () => {
  const on = await opened(true);
  assert.equal((await on.call("plasticity_batch", { steps: FIXTURE_STEPS })).isError, false);
  const off = await opened(false);
  assert.equal((await off.call("plasticity_batch", { steps: FIXTURE_STEPS })).isError, false);
  assert.equal(on.journal.length, 4, "four edit steps, four entries");
  assert.deepEqual(comparable(on.journal), comparable(off.journal));

  const direct = await opened(true);
  const run = async (name: string, args: Record<string, unknown>) => {
    const reply = await direct.call(name, { ...args, revision: (await direct.operations.state()).revision });
    assert.equal(reply.isError, false, reply.text);
    return reply.json;
  };
  const block = (await run("plasticity_create_box", FIXTURE_STEPS[0]!.arguments)).change.added[0].id;
  const cutter = (await run("plasticity_create_box", FIXTURE_STEPS[1]!.arguments)).change.added[0].id;
  await run("plasticity_boolean", { targetIds: [block], toolIds: [cutter], operation: "difference" });
  const edges = (await run("plasticity_find_edges", { query: { bodyIds: [block], line: true } })).matches.map((edge: { id: string }) => edge.id);
  await run("plasticity_fillet", { id: block, edgeIds: edges, radiusMm: 1 });
  assert.deepEqual(comparable(on.journal), comparable(direct.journal));
  for (const h of [on, off, direct]) await h.close();
});

test("constraint 4: a timed-out step is journaled as unknown, undoOnError behaves as before and nothing cached is reused after it", async () => {
  const run = async (reuse: boolean, undoOnError: boolean) => {
    const h = await opened(reuse);
    let step = 0;
    let failedAt = -1;
    h.operations.onStep = () => {
      if (++step === 2) {
        h.runtime.failNextMutate = new Error("CDP request timed out: Runtime.callFunctionOn");
        failedAt = h.runtime.events.length;
      }
    };
    const reply = await h.call("plasticity_batch", { undoOnError, steps: [
      { toolName: "plasticity_create_box", arguments: { originMm: [100, 0, 0], sizeMm: [10, 10, 10] } },
      { toolName: "plasticity_create_box", arguments: { originMm: [200, 0, 0], sizeMm: [10, 10, 10] } },
      { toolName: "plasticity_create_box", arguments: { originMm: [300, 0, 0], sizeMm: [10, 10, 10] } },
    ] });
    const failedMutate = h.runtime.events.findIndex((event, index) => index >= failedAt && event.kind === "mutate");
    const result = {
      isError: reply.isError, reply: reply.text, journal: comparable(h.journal), uncertain: h.runtime.isUncertain(),
      readsAfterFailure: h.runtime.count("state", failedMutate), probesAfterFailure: h.runtime.count("probe", failedMutate),
    };
    await h.close();
    return result;
  };
  for (const undoOnError of [false, true]) {
    const on = await run(true, undoOnError);
    const off = await run(false, undoOnError);
    assert.equal(on.isError, true);
    // Without undoOnError the step's own error comes back; with it, the undo is refused while the outcome is uncertain.
    assert.match(on.reply, undoOnError ? /uncertain; call reconcile/ : /CDP request timed out/);
    assert.equal(on.uncertain, true);
    assert.equal(on.journal.at(-1)!.status, "unknown");
    assert.equal(on.probesAfterFailure, 0, "no cached state is offered after the uncertain step");
    assert.ok(on.readsAfterFailure >= 1, "the journal's after-state is a fresh read");
    assert.deepEqual(on, off, `undoOnError=${undoOnError}: same error text, journal and fresh reads as the pre-change path`);
  }
});

test("constraint 4: the cache is not used while the runtime is uncertain, and reuse ends with the batch", async () => {
  const h = await opened(true);
  h.operations.beginStateReuse();
  await h.operations.state();
  await h.operations.state();
  assert.equal(h.runtime.count("state"), 1, "a second read with no mutation in between is reused");
  h.runtime.failNextMutate = new Error("CDP request timed out: Runtime.callFunctionOn");
  await assert.rejects(h.runtime.mutate("", ["ThreePointBoxFactory"], [{ origin: [0, 0, 0], size: [1, 1, 1] }]));
  await h.operations.state();
  await h.operations.state();
  assert.equal(h.runtime.count("state"), 3, "uncertain: every read is fresh and nothing is stored");
  h.operations.endStateReuse();
  await h.close();
});

test("constraint 5: $n references, detail, return, roundMm and the change summary reply exactly as before", async () => {
  const variants: Array<Record<string, unknown>> = [
    { steps: FIXTURE_STEPS },
    { steps: FIXTURE_STEPS, detail: "lean" },
    { steps: FIXTURE_STEPS, detail: "lean", roundMm: 1 },
    { steps: FIXTURE_STEPS, verbose: true },
    { steps: [...FIXTURE_STEPS.slice(0, 3), { ...FIXTURE_STEPS[3]!, return: ["count", "matches[*].id"] }, FIXTURE_STEPS[4]!], detail: "lean" },
    { steps: [...FIXTURE_STEPS, { toolName: "plasticity_find_faces", arguments: { query: { bodyIds: ["$0.added[0]"] } } }] },
  ];
  for (const args of variants) {
    const on = await opened(true);
    const off = await opened(false);
    const a = await on.call("plasticity_batch", args);
    const b = await off.call("plasticity_batch", args);
    assert.equal(a.isError, false, a.text);
    assert.equal(a.text, b.text, JSON.stringify(args).slice(0, 200));
    assert.ok(on.runtime.count("state") < off.runtime.count("state"));
    await on.close();
    await off.close();
  }
});

test("constraint 2: a UI edit after the last step shows in the batch reply, as with a fresh end read", async () => {
  const run = async (reuse: boolean) => {
    const h = await opened(reuse);
    let step = 0;
    h.operations.onStep = () => { if (++step === 2) h.runtime.externalEdit(); }; // the second mark is the batch end
    const reply = await h.call("plasticity_batch", { steps: [{ toolName: "plasticity_create_box", arguments: { originMm: [100, 0, 0], sizeMm: [10, 10, 10] } }] });
    await h.close();
    return reply;
  };
  const on = await run(true);
  const off = await run(false);
  assert.equal(on.isError, false, on.text);
  assert.equal(on.json.bodyCount, 3, "the UI-made body is counted");
  assert.equal(on.json.revision, "r3ext");
  assert.equal(on.text, off.text);
});

test("constraint 2: a stale batch revision is refused before any step, as before", async () => {
  for (const reuse of [true, false]) {
    const h = await opened(reuse);
    const reply = await h.call("plasticity_batch", { revision: "r0", steps: [{ toolName: "plasticity_create_box", arguments: { originMm: [100, 0, 0], sizeMm: [1, 1, 1] } }] });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /Stale reference: expected revision r0, current revision is r1/);
    assert.equal(h.runtime.count("mutate"), 0);
    await h.close();
  }
});

test("read counts: an undo step in a batch also takes one full read, and a later step reuses it", async () => {
  const h = await opened(true);
  const reply = await h.call("plasticity_batch", { steps: [
    { toolName: "plasticity_create_box", arguments: { originMm: [100, 0, 0], sizeMm: [10, 10, 10] } },
    { toolName: "plasticity_undo", arguments: {} },
    { toolName: "plasticity_find_faces", arguments: { query: {} }, return: ["count"] },
  ] });
  assert.equal(reply.isError, false, reply.text);
  assert.deepEqual(perStep(h.runtime).slice(1), [{ state: 1, probe: 1 }, { state: 1, probe: 1 }, { state: 0, probe: 1 }, { state: 0, probe: 1 }]);
  assert.deepEqual(reply.json.steps[2].result, { count: 1 }, "the read after the undo sees the undone document");
  await h.close();
});

test("constraint 4: a plain failed step stops the batch, and undoOnError undoes the completed steps exactly as before", async () => {
  const run = async (reuse: boolean, undoOnError: boolean) => {
    const h = await opened(reuse);
    let step = 0;
    h.operations.onStep = () => { if (++step === 3) h.runtime.failNextMutate = new Error("Plasticity command failed: fillet radius too large"); };
    const reply = await h.call("plasticity_batch", { undoOnError, steps: [
      { toolName: "plasticity_create_box", arguments: { originMm: [100, 0, 0], sizeMm: [10, 10, 10] } },
      { toolName: "plasticity_create_box", arguments: { originMm: [200, 0, 0], sizeMm: [10, 10, 10] } },
      { toolName: "plasticity_create_box", arguments: { originMm: [300, 0, 0], sizeMm: [10, 10, 10] } },
    ] });
    const end = await h.runtime.getState();
    const result = { isError: reply.isError, reply: reply.json, journal: comparable(h.journal), undoDepth: end.undoDepth, bodies: end.bodies.map((body) => body.id) };
    await h.close();
    return result;
  };
  for (const undoOnError of [false, true]) {
    const on = await run(true, undoOnError);
    const off = await run(false, undoOnError);
    assert.equal(on.isError, true);
    assert.equal(on.reply.failedStep, 2);
    assert.match(on.reply.error, /fillet radius too large/);
    assert.equal(on.reply.undoneSteps, undoOnError ? 2 : 0);
    assert.equal(on.undoDepth, undoOnError ? 0 : 2, undoOnError ? "back at the start depth" : "the two completed steps stay");
    assert.deepEqual(on.journal.map((entry) => [entry.operation, entry.status]), [
      ["create-box", "completed"], ["create-box", "completed"], ["create-box", "failed"],
      ...(undoOnError ? [["undo", "completed"], ["undo", "completed"]] : []),
    ]);
    assert.deepEqual(on, off, `undoOnError=${undoOnError}: same reply, journal and document as the pre-change path`);
  }
});
