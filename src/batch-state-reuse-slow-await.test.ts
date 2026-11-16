import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createCompactServer, type SessionLike } from "./server.ts";
import type { ConstructionHistoryEntry, ConstructionHistoryStore } from "./plasticity/construction-history.ts";
import { PlasticityOperations } from "./plasticity/operations.ts";
import type { PlasticityRuntime, RevisionProbe, RuntimeState } from "./plasticity/runtime.ts";
import type { StepReferenceDownloaderLike } from "./plasticity/step-reference-downloader.ts";

// Batch state reuse after review of cd73746: a cached state is never handed out without a matching probe in the same
// state() call, so a tool that awaits something slow inside a step (a download, a native read) and then re-checks the
// document sees a UI edit made meanwhile. These tests drive the real PlasticityOperations over a fake runtime whose
// native reads, probes and downloads can wait or let a "UI edit" land at a chosen moment.

type Vec = [number, number, number];
type Body = RuntimeState["bodies"][number];
type Event = { kind: "state" | "probe" | "mutate" | "step" | "native"; binding?: string };

const lineEdge = (id: string, center: Vec) => ({
  id, curveType: "Line", line: true, circle: false, lengthMm: 10, centerMm: center, tangent: [0, 0, 1],
  boundsMm: { min: center, max: center }, faceIds: [`${id}-f`], vertexIds: [],
});

function boxBody(id: number, versionId: number, origin: Vec, size: Vec, name: string | null): Body {
  const max: Vec = [origin[0] + size[0], origin[1] + size[1], origin[2] + size[2]];
  const edges = [lineEdge(`${id}e1`, origin), lineEdge(`${id}e2`, max)];
  const faces = [{
    id: `${id}f1`, surfaceType: "Plane", planar: true, centerMm: [(origin[0] + max[0]) / 2, (origin[1] + max[1]) / 2, max[2]], normal: [0, 0, 1],
    radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [origin[0], origin[1], max[2]], max }, edgeIds: edges.map((edge) => edge.id),
  }, {
    id: `${id}f2`, surfaceType: "Plane", planar: true, centerMm: [(origin[0] + max[0]) / 2, (origin[1] + max[1]) / 2, origin[2]], normal: [0, 0, -1],
    radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: origin, max: [max[0], max[1], origin[2]] }, edgeIds: edges.map((edge) => edge.id),
  }];
  return {
    id, versionId, type: "Solid", name, materialId: 0, visible: true, hidden: false, locked: false,
    boundsMm: { min: origin, max }, boundsMethod: "native-box",
    faceIds: faces.map((face) => face.id), edgeIds: edges.map((edge) => edge.id), faces, edges, vertices: [],
  } as unknown as Body;
}

function wireBody(id: number): Body {
  return {
    id, versionId: id * 10, type: "Wire", name: "profile", materialId: 0, visible: true, hidden: false, locked: false,
    boundsMm: { min: [0, 0, 0], max: [10, 10, 0] }, boundsMethod: "native-box", faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [],
  } as unknown as Body;
}

class SlowRuntime {
  events: Event[] = [];
  current: RuntimeState;
  private readonly undoStack: RuntimeState[] = [];
  private version = 1;
  private nextId = 10;
  private mutations = 0;
  // Runs inside the next native read (runtime.read / readNative), as a UI edit landing while it is pending.
  duringNativeRead: (() => void) | undefined;
  // When set, getState snapshots the document at the call and then waits for this gate (a slow full read).
  stateGate: Promise<void> | undefined;

  constructor() {
    this.current = {
      targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0,
      regions: [], referenceMeshes: [], construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "workplane:none" },
      bodies: [boxBody(1, 100, [0, 0, 0], [40, 30, 10], "plate"), wireBody(2)],
    } as unknown as RuntimeState;
  }

  count(kind: Event["kind"], from = 0, to = this.events.length) {
    return this.events.slice(from, to).filter((event) => event.kind === kind).length;
  }
  mutateCount(binding: string) { return this.events.filter((event) => event.kind === "mutate" && event.binding === binding).length; }

  isUncertain() { return false; }
  mutationCount() { return this.mutations; }

  async getState(): Promise<RuntimeState> {
    this.events.push({ kind: "state" });
    const snapshot = structuredClone(this.current);
    if (this.stateGate) await this.stateGate;
    return snapshot;
  }

  async readRevisionProbe(): Promise<RevisionProbe> {
    this.events.push({ kind: "probe" });
    const state = this.current;
    return {
      documentToken: state.documentToken, revision: state.revision, viewStateToken: state.construction.viewStateToken,
      activePlaneId: state.construction.activePlaneId, bodyNames: state.bodies.map((body) => [body.id, body.name]), regions: structuredClone(state.regions),
    };
  }

  // A change made in the Plasticity UI: a new revision, a new body and an Undo entry, without this process calling mutate().
  externalEdit(): void {
    this.commit((bodies) => [...bodies, boxBody(this.nextId++, 9_000 + this.version, [500, 0, 0], [5, 5, 5], "user")], "ext");
  }

  async mutate<T>(_source: string, bindings: string[], values: unknown[] = []): Promise<T> {
    this.mutations += 1;
    const binding = bindings[0] ?? "history";
    this.events.push({ kind: "mutate", binding });
    const args = (values[0] ?? {}) as Record<string, any>;
    if (binding === "ThreePointBoxFactory") {
      const mm = (value: number) => Math.round(value * 1e6) / 1e3;
      const id = this.nextId++;
      this.commit((bodies) => [...bodies, boxBody(id, id * 10, args.origin.map(mm), args.size.map(mm), args.name ?? null)]);
    } else if (binding === "MeshImportFactory") {
      const id = this.nextId++;
      this.undoStack.push(this.current);
      this.version += 1;
      this.current = {
        ...this.current, revision: `r${this.version}`, dbVersion: this.version, undoDepth: this.current.undoDepth + 1, redoDepth: 0,
        referenceMeshes: [...(this.current.referenceMeshes ?? []), {
          id, type: "ReferenceMesh", name: "mesh", sourcePath: args.path, sourceFormat: "obj", measurementSource: "reference-mesh",
          boundsMm: { min: [0, 0, 0], max: [1, 1, 0] }, translationMm: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1], sceneScaleToMeters: [0.001, 0.001, 0.001],
          vertexEntries: 3, triangles: 1, visible: true, hidden: false, locked: false,
        }],
      } as RuntimeState;
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

  async read<T>(): Promise<T> { return this.native<T>([]); }
  async readNative<T>(_source: string, bindings: string[] = [], values: unknown[] = []): Promise<T> {
    if (bindings[0] === "pk_default") {
      // Exact face properties for the requested faces (the native read behind sortBy "area").
      const faces = (values[0] as { faces: Array<{ bodyId: number; faceId: string }> }).faces;
      return this.native<T>(faces.map((face) => {
        const body = this.current.bodies.find((candidate) => candidate.id === face.bodyId)!;
        return {
          face, bodyVersionId: body.versionId, entityId: 1, surfaceType: "Plane", planar: true, areaM2: face.faceId.endsWith("f1") ? 2e-3 : 1e-3,
          boundaryLengthM: 0.1, areaCentroidM: [0, 0, 0], loopCount: 1, innerLoopCount: 0, nativeCheckCodes: [],
        };
      }));
    }
    return this.native<T>([]);
  }

  private async native<T>(value: unknown): Promise<T> {
    this.events.push({ kind: "native" });
    const edit = this.duringNativeRead;
    this.duringNativeRead = undefined;
    edit?.();
    return value as T;
  }

  private commit(change: (bodies: Body[]) => Body[], suffix = ""): void {
    this.undoStack.push(this.current);
    this.version += 1;
    this.current = {
      ...this.current, bodies: change(this.current.bodies), revision: `r${this.version}${suffix}`, dbVersion: this.version,
      undoDepth: this.current.undoDepth + 1, redoDepth: 0,
    } as RuntimeState;
  }
}

// Records, for every state() call while reuse is on, whether it did a full read and whether it probed.
type StateCall = { step: number; full: number; probe: number };
class CheckedOperations extends PlasticityOperations {
  onStep: ((step: number) => void) | undefined;
  readonly slow: SlowRuntime;
  stateCalls: StateCall[] = [];
  private step = -1;
  private reuseOn = false;
  constructor(slow: SlowRuntime) {
    super(slow as unknown as PlasticityRuntime, "session-1");
    this.slow = slow;
  }
  override beginStateReuse(): void { this.reuseOn = true; this.step = -1; super.beginStateReuse(); }
  override endStateReuse(): void { this.reuseOn = false; super.endStateReuse(); }
  override beginStateReuseStep(): void {
    this.step += 1;
    this.slow.events.push({ kind: "step" });
    this.onStep?.(this.step);
    super.beginStateReuseStep();
  }
  override async state(timeoutMs?: number): Promise<RuntimeState> {
    const from = this.slow.events.length;
    const value = await super.state(timeoutMs);
    if (this.reuseOn) this.stateCalls.push({ step: this.step, full: this.slow.count("state", from), probe: this.slow.count("probe", from) });
    return value;
  }
}

function harness(downloader?: StepReferenceDownloaderLike) {
  const runtime = new SlowRuntime();
  const operations = new CheckedOperations(runtime);
  const journal: ConstructionHistoryEntry[] = [];
  const history = { async append(entry: ConstructionHistoryEntry) { journal.push(entry); } } as unknown as ConstructionHistoryStore;
  const session = {
    async windows() { return []; }, async connect() { return null; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: operations.constructionCapabilities() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createCompactServer(session, undefined, undefined, undefined, history, downloader);
  const client = new Client({ name: "batch-state-reuse-slow-await", version: "1.0.0" });
  return {
    runtime, operations, journal,
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

async function opened(downloader?: StepReferenceDownloaderLike) {
  const h = harness(downloader);
  await h.open();
  return h;
}

const BOX_STEP = { toolName: "plasticity_create_box", arguments: { originMm: [2000, 0, 0], sizeMm: [10, 10, 10], name: "block" } };

test("(a) a UI edit while a reference mesh downloads inside a batch fails the step before any import, as a direct call does", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "batch-slow-download-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "downloaded.obj");
  const contents = "o part\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
  await writeFile(path, contents);
  let h!: Awaited<ReturnType<typeof opened>>;
  const downloader: StepReferenceDownloaderLike = {
    async download() { throw new Error("wrong download path"); },
    async downloadParasolid() { throw new Error("wrong download path"); },
    async downloadReferenceMesh(url: string) {
      await new Promise((resolve) => setTimeout(resolve, 5)); // the slow network wait
      h.runtime.externalEdit(); // the user adds a body in Plasticity meanwhile
      return { path, bytes: Buffer.byteLength(contents), sha256: createHash("sha256").update(contents).digest("hex"), sourceUrl: url, finalUrl: url, format: "reference-mesh-obj" as const };
    },
  };
  h = await opened(downloader);
  const reply = await h.call("plasticity_batch", { steps: [
    BOX_STEP,
    { toolName: "plasticity_download_and_import_reference_mesh", arguments: {
      source: { sourceKind: "verified-community-cad", sourceUrl: "https://community.example/files/part.obj", confidence: "approximate" },
      format: "obj", sourceUnit: "millimeter",
    } },
  ] });
  assert.equal(reply.isError, true, reply.text);
  assert.equal(reply.json.failedStep, 1);
  assert.match(reply.json.error, /Plasticity document changed while the reference mesh was downloading/);
  assert.equal(h.runtime.mutateCount("MeshImportFactory"), 0, "no import mutation ran on the changed document");
  assert.deepEqual(h.journal.map((entry) => entry.operation), ["create-box"], "only the tool's own edit is journaled");
  assert.doesNotMatch(JSON.stringify(h.journal), /"user"/, "the user's UI body is never attributed to a tool");
  assert.deepEqual(reply.json.completedSteps.map((step: { step: number }) => step.step), [0]);
  await h.close();
});

test("(b) list_curve_endpoints in a batch fails when a UI edit lands during its native read", async () => {
  const h = await opened();
  h.operations.onStep = (step) => { if (step === 1) h.runtime.duringNativeRead = () => h.runtime.externalEdit(); };
  const reply = await h.call("plasticity_batch", { steps: [BOX_STEP, { toolName: "plasticity_list_curve_endpoints", arguments: {} }] });
  assert.equal(reply.isError, true, reply.text);
  assert.equal(reply.json.failedStep, 1);
  assert.equal(reply.json.error, "Plasticity document changed while curve endpoints were being listed");
  await h.close();

  // Without the edit the same batch passes, so the error above is the guard and nothing else.
  const clean = await opened();
  const ok = await clean.call("plasticity_batch", { steps: [BOX_STEP, { toolName: "plasticity_list_curve_endpoints", arguments: {} }] });
  assert.equal(ok.isError, false, ok.text);
  await clean.close();
});

test("(c) export_svg in a batch fails when a UI edit lands while the SVG geometry is read, and writes no file", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "batch-slow-svg-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const h = await opened();
  h.operations.onStep = (step) => { if (step === 1) h.runtime.duringNativeRead = () => h.runtime.externalEdit(); };
  const output = join(root, "profile.svg");
  const reply = await h.call("plasticity_batch", { steps: [BOX_STEP, { toolName: "plasticity_export_svg", arguments: { ids: [2], path: output } }] });
  assert.equal(reply.isError, true, reply.text);
  assert.equal(reply.json.failedStep, 1);
  assert.equal(reply.json.error, "Plasticity document changed while SVG geometry was being read");
  await assert.rejects(import("node:fs/promises").then((fs) => fs.stat(output)), /ENOENT/);
  await h.close();
});

test("(d) a mutate() that starts while a state read is pending leaves no cached state behind", async () => {
  const h = await opened();
  h.operations.beginStateReuse();
  let release!: () => void;
  h.runtime.stateGate = new Promise((resolve) => { release = resolve; });
  const pending = h.operations.state();
  await new Promise((resolve) => setImmediate(resolve));
  await h.runtime.mutate("", ["ThreePointBoxFactory"], [{ origin: [2, 0, 0], size: [0.01, 0.01, 0.01] }]);
  release();
  h.runtime.stateGate = undefined;
  const stale = await pending;
  assert.equal(stale.revision, "r1", "the pending read answers what it read, as a direct read would");
  const from = h.runtime.events.length;
  const next = await h.operations.state();
  assert.equal(next.revision, "r2", "the next state() sees the mutation");
  assert.equal(h.runtime.count("probe", from), 0, "nothing was cached, so there was nothing to probe");
  assert.equal(h.runtime.count("state", from), 1, "a fresh full read");
  // And a read with no mutate() in flight is cached and reused (after a probe).
  const reused = h.runtime.events.length;
  assert.equal((await h.operations.state()).revision, "r2");
  assert.deepEqual([h.runtime.count("state", reused), h.runtime.count("probe", reused)], [0, 1]);
  h.operations.endStateReuse();
  await h.close();
});

test("(d) a probe that races a mutate() is not trusted: a full read follows", async () => {
  const h = await opened();
  h.operations.beginStateReuse();
  await h.operations.state();
  // A mutate() that starts while the probe is pending: the cached state must not be served.
  const probe = h.runtime.readRevisionProbe.bind(h.runtime);
  h.runtime.readRevisionProbe = async () => {
    const value = await probe();
    await h.runtime.mutate("", ["ThreePointBoxFactory"], [{ origin: [3, 0, 0], size: [0.01, 0.01, 0.01] }]);
    return value;
  };
  const from = h.runtime.events.length;
  const state = await h.operations.state();
  h.runtime.readRevisionProbe = probe;
  assert.equal(h.runtime.count("state", from), 1, "the probe raced a mutation, so a full read followed");
  assert.equal(state.revision, h.runtime.current.revision);
  h.operations.endStateReuse();
  await h.close();
});

test("criterion 2: every cached answer in a batch comes with a matching probe in the same call, for every step kind", async () => {
  const h = await opened();
  const reply = await h.call("plasticity_batch", { steps: [
    BOX_STEP,
    { toolName: "plasticity_create_box", arguments: { originMm: [2002, 2, 5], sizeMm: [2, 2, 10] } },
    { toolName: "plasticity_find_edges", arguments: { query: { bodyIds: ["$0.added[0]"] } }, return: ["count"] },
    { toolName: "plasticity_find_faces", arguments: { query: { bodyIds: ["$0.added[0]"] }, sortBy: "area", limit: 1 }, return: ["matches[0].id"] },
    { toolName: "plasticity_list_curve_endpoints", arguments: {}, return: ["revision"] },
    { toolName: "plasticity_undo", arguments: {} },
    { toolName: "plasticity_status", arguments: {}, return: ["revision"] },
  ] });
  assert.equal(reply.isError, false, reply.text);
  const calls = h.operations.stateCalls;
  assert.ok(calls.length > 0);
  for (const call of calls) assert.ok(call.full === 1 || call.probe === 1, `state() at step ${call.step} answered with neither a full read nor a probe`);
  const kinds = ["batch start", "create_box", "create_box", "find_edges", "find_faces sortBy area", "list_curve_endpoints", "undo", "status", "batch end"];
  const perStep = kinds.map((kind, index) => {
    const mine = calls.filter((call) => call.step === index - 1);
    const hits = mine.filter((call) => call.full === 0).length;
    const probes = mine.reduce((sum, call) => sum + call.probe, 0);
    return { kind, calls: mine.length, fullReads: mine.reduce((sum, call) => sum + call.full, 0), hits, probes };
  });
  for (const step of perStep) assert.ok(step.probes >= step.hits, `${step.kind}: ${step.probes} probes for ${step.hits} cache hits`);
  assert.ok(perStep.some((step) => step.hits > 0), "the cache is used");
  // The area sort answers from the validated state: no extra full reads inside the batch.
  assert.equal(perStep[4]!.fullReads, 0, "find_faces sortBy area: probes only");
  assert.equal(perStep[3]!.fullReads, 0, "find_edges: probes only");
  await h.close();
});

test("direct calls keep doing no probe and the same full reads; the area sort reads twice through the runtime as before", async () => {
  const h = await opened();
  const direct = async (name: string, args: Record<string, unknown>) => {
    const revision = (await h.operations.state()).revision;
    const from = h.runtime.events.length;
    const reply = await h.call(name, { ...args, revision });
    assert.equal(reply.isError, false, reply.text);
    return { state: h.runtime.count("state", from), probe: h.runtime.count("probe", from), reply };
  };
  const area = await direct("plasticity_find_faces", { query: { bodyIds: [1] }, sortBy: "area", limit: 1 });
  assert.deepEqual({ state: area.state, probe: area.probe }, { state: 3, probe: 0 }, "the find read plus the measurement's before/after reads");
  assert.equal(area.reply.json.matches[0].id, "1f1");
  const from = h.runtime.events.length;
  const endpoints = await h.call("plasticity_call", { toolName: "plasticity_list_curve_endpoints", arguments: {} });
  assert.equal(endpoints.isError, false, endpoints.text);
  assert.deepEqual({ state: h.runtime.count("state", from), probe: h.runtime.count("probe", from) }, { state: 2, probe: 0 }, "before and after the native read");
  assert.equal(h.operations.stateCalls.length, 0, "reuse never turned on");
  await h.close();
});

test("item 8: the area measurement's stale revision error uses the normal stale-reference wording", async () => {
  const h = await opened();
  await assert.rejects(h.operations.measureFaceProperties([{ bodyId: 1, faceId: "1f1" }], "r0"), {
    message: "Stale reference: expected revision r0, current revision is r1",
  });
  await h.close();
});
