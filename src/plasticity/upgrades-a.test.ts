import assert from "node:assert/strict";
import { test } from "node:test";
import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

// Executes the source each operation hands to runtime.mutate against a stub editor and records what the
// native factories received. Enum values are the numbers FINDINGS (probes-2026-11) read from Plasticity 26.1.3.
const ENUMS: Record<string, Record<string, number>> = {
  ExtensionShape: { Linear: 22750, Soft: 22751, Reflective: 22752, Natural: 22753, Arc: 22754 },
  BodyExtensionType: { Distance: 22760, Target: 22761, Bbox: 22762 },
  ExtensionLimit: { Minimal: 23800, Outside: 23801, Inside: 23802 },
  SweepGuideMethod: { Point: 23250, Chord: 23251, Curve: 23252 },
  SweepAlignmentType: { Normal: 1, Parallel: 2, Transport: 3 },
  SweepCornerType: { Mitre: 1, Round: 2 },
};

type Fields = Record<string, any>;

function fixture(options: { measurementName?: string | null } = {}) {
  const wire = (id: number) => ({ id, versionId: 100 + id, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] });
  const solid = (id: number) => ({ id, versionId: 100 + id, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] });
  const edge = (id: string, faceIds: string[]) => ({ id, curveType: "Line", line: true, circle: false, lengthMm: 10, centerMm: [0, 0, 0], tangent: [1, 0, 0], boundsMm: { min: [0, 0, 0], max: [1, 0, 0] }, faceIds, vertexIds: [] });
  const sheetEdges = [edge("e1", ["f1"]), edge("e2", ["f1"]), edge("e3", ["f1", "f2"])];
  const sheet = { id: 5, versionId: 105, type: "Sheet", name: null, boundsMm: null, faceIds: ["f1", "f2"], edgeIds: ["e1", "e2", "e3"], faces: [], edges: sheetEdges };
  const measurement = {
    id: 1, versionId: 1, type: "DistanceMeasurement", name: options.measurementName === undefined ? "label" : options.measurementName,
    measurementSource: "native-brep",
    first: { bodyId: 10, topologyId: 1, landmark: 0, topologyType: "vertex", topologyRefId: 1, positionMm: [2800, 0, 0] },
    second: { bodyId: 10, topologyId: 2, landmark: 0, topologyType: "vertex", topologyRefId: 2, positionMm: [2820, 0, 0] },
    distanceMm: 20, direction: [1, 0, 0], normal: [0, 0, 1], offsetMm: [0, 0],
  };
  const radius = { ...measurement, id: 2, versionId: 5, type: "RadiusMeasurement", direction: null, normal: null };
  const state = {
    targetId: "window", title: "Upgrades A", documentToken: "document", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0,
    construction: { planes: [], activePlaneId: "standard:top", planeStateToken: "planes", viewStateToken: "view" },
    regions: [{ id: "12r34", entityId: 34, islandVersionId: 12, sketchId: 3, sketchWireIds: [7], measurementSource: "render-mesh", displayBoundsMm: { min: [0, 0, 0], max: [1, 1, 0] } }],
    bodies: [wire(7), wire(8), wire(9), wire(11), solid(10), sheet, solid(12)],
    measurements: [measurement, radius],
  } as unknown as RuntimeState;

  const views = new Map<number, Fields>();
  const geometryModel = new Map<number, { view: Fields }>();
  for (const body of state.bodies) {
    const view: Fields = { kind: body.type, constructor: { name: body.type } };
    if (body.type === "Sheet") {
      view.high = { edges: { versionIds: ["e1", "e2", "e3"], get: (index: number) => ({ edgeView: ["e1", "e2", "e3"][index] }) } };
    }
    views.set(body.id, view);
    geometryModel.set(body.versionId, { view });
  }
  const regionView = { versionId: "12r34" };
  geometryModel.set(12, { view: { constructor: { name: "SketchIsland" }, regions: { length: 1, get: () => regionView } } });
  const automatics = new Set([12]);

  const created: Fields[] = [];
  const executed: string[] = [];
  const selected: Fields = { added: [] as unknown[], removed: 0, add(item: unknown) { this.added.push(item); }, removeAll() { this.removed += 1; } };
  // The native measurement repo: a move bumps the version and, like Plasticity, drops userData.name.
  const nativeMeasurement: Fields = { versionId: 1, userData: options.measurementName === null ? {} : { name: options.measurementName ?? "label" } };
  const repo: { measurements: Fields[] } = { measurements: [nativeMeasurement] };

  const stub = (name: string) => class {
    resource() { return this; }
    start = vectorStub();
    end = vectorStub();
    direction = vectorStub();
    offset = vectorStub();
    async commit() {
      created.push({ factory: name, ...(this as unknown as Fields) });
      if (name === "MoveMeasurementFactory") repo.measurements = [{ versionId: 2, userData: {} }];
      return [];
    }
  };
  const editor = {
    // The real editor reads through geo.read; the plain geo.geometryModel branch of nativeApi is a legacy shape.
    geo: { read: { geometryModel, automatics }, lookupStableId(version: number) { return version - 100; } },
    db: { version: 1, commit() { return undefined; } },
    executor: { isBusy: false },
    selection: { selected },
    measurements: {
      lookupByStableId(id: number) { return id === 1 ? nativeMeasurement : undefined; },
      lookupStableId(version: number) { return version === 1 || version === 2 ? 1 : undefined; },
      snapshot() { return { repo: { measurements: repo.measurements } }; },
    },
    commands: new Proxy({}, {
      get: (_target, name: string) => class { remember = true; execute: () => Promise<unknown> = async () => undefined; constructor() { executed.push(name); } },
    }),
    async exec(command: { execute(): Promise<unknown> }) { await command.execute(); },
  };

  const calls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const runtime = {
    async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) {
      // state() redraws the measurement overlay through its own native call; it is not under test here.
      if (source.includes("distanceLabels")) return {};
      calls.push({ source, bindings, values });
      const native = Function(`return (${source})`)();
      const bound = bindings.map((binding) => ENUMS[binding] ?? stub(binding));
      await native.call(editor, ...bound, ...values);
      return {};
    },
    isUncertain() { return false; },
  } as unknown as PlasticityRuntime;
  return { operations: new PlasticityOperations(runtime), state, created, executed, calls, views, regionView, selected, nativeMeasurement, repo, editor };
}

function vectorStub() {
  return { value: [] as number[], fromArray(value: number[]) { this.value = value; return this; } };
}

test("extendSheetEdges with no options still sets a linear distance extension that merges", async () => {
  const f = fixture();
  await f.operations.extendSheetEdges(5, ["e1", "e2"], 10, "r1");
  assert.deepEqual(f.calls[0]!.bindings, ["ExtendSheetFactory", "ExtensionShape", "BodyExtensionType", "ExtensionLimit"]);
  assert.deepEqual(f.calls[0]!.values, [{ id: 5, edgeIds: ["e1", "e2"], distance: 0.01 }]);
  assert.deepEqual(f.executed, ["ExtendSheetCommand"]);
  const factory = f.created[0]!;
  assert.deepEqual(factory.edges, [{ edgeView: "e1" }, { edgeView: "e2" }]);
  assert.equal(factory.distance, 0.01);
  assert.equal(factory.shape, ENUMS.ExtensionShape!.Linear);
  assert.equal(factory.type, ENUMS.BodyExtensionType!.Distance);
  assert.equal(factory.limit, ENUMS.ExtensionLimit!.Minimal);
  assert.equal(factory.modify, true);
  assert.equal(factory.target, undefined);
});

test("extendSheetEdges maps shape names to the native ExtensionShape values", async () => {
  for (const [shape, native] of [["linear", 22750], ["soft", 22751], ["reflective", 22752], ["natural", 22753]] as const) {
    const f = fixture();
    await f.operations.extendSheetEdges(5, ["e1"], 2.5, "r1", { shape });
    assert.equal(f.created[0]!.shape, native, shape);
    assert.equal(f.created[0]!.distance, 0.0025);
    assert.equal(f.created[0]!.type, ENUMS.BodyExtensionType!.Distance);
  }
});

test("extendSheetEdges merge=false sets modify=false and merge=true keeps it true", async () => {
  const separate = fixture();
  await separate.operations.extendSheetEdges(5, ["e1"], 10, "r1", { merge: false });
  assert.equal(separate.created[0]!.modify, false);
  assert.deepEqual(separate.calls[0]!.values, [{ id: 5, edgeIds: ["e1"], distance: 0.01, merge: false }]);
  const merged = fixture();
  await merged.operations.extendSheetEdges(5, ["e1"], 10, "r1", { merge: true });
  assert.equal(merged.created[0]!.modify, true);
});

test("extendSheetEdges with targetId extends up to the body and sets no distance", async () => {
  const f = fixture();
  await f.operations.extendSheetEdges(5, ["e1"], undefined, "r1", { targetId: 10, shape: "soft" });
  assert.deepEqual(f.calls[0]!.values, [{ id: 5, edgeIds: ["e1"], shapeName: "Soft", targetId: 10 }]);
  const factory = f.created[0]!;
  assert.equal(factory.type, ENUMS.BodyExtensionType!.Target);
  assert.equal(factory.target, f.views.get(10));
  assert.equal(factory.distance, undefined);
  assert.equal(factory.shape, ENUMS.ExtensionShape!.Soft);
  assert.equal(factory.modify, true);
});

test("rejects invalid Sheet extension options before any native call", async () => {
  const f = fixture();
  const ops = f.operations;
  await assert.rejects(ops.extendSheetEdges(5, ["e1"], 10, "r1", { targetId: 10 }), /either a distance or a target/i);
  await assert.rejects(ops.extendSheetEdges(5, ["e1"], undefined, "r1"), /distance or a target/i);
  await assert.rejects(ops.extendSheetEdges(5, ["e1"], undefined, "r1", { shape: "soft" }), /distance or a target/i);
  await assert.rejects(ops.extendSheetEdges(5, ["e1"], 10, "r1", { shape: "arc" as never }), /shape must be one of/i);
  await assert.rejects(ops.extendSheetEdges(5, ["e1"], undefined, "r1", { targetId: 5 }), /different current Solid or Sheet/i);
  await assert.rejects(ops.extendSheetEdges(5, ["e1"], undefined, "r1", { targetId: 7 }), /different current Solid or Sheet/i);
  await assert.rejects(ops.extendSheetEdges(5, ["e1"], undefined, "r1", { targetId: 999 }), /different current Solid or Sheet/i);
  await assert.rejects(ops.extendSheetEdges(5, ["e1"], -1, "r1"), /positive/i);
  await assert.rejects(ops.extendSheetEdges(5, ["e1"], Number.NaN, "r1"), /positive/i);
  await assert.rejects(ops.extendSheetEdges(5, ["e1"], 10, "stale"), /stale reference/i);
  assert.equal(f.calls.length, 0);
});

test("sweepRegions with guides binds SweepGuideMethod and passes the rails and the method", async () => {
  const f = fixture();
  await f.operations.sweepRegions(["12r34"], 8, { guideIds: [9], guideMethod: "curve" }, "r1");
  assert.deepEqual(f.calls[0]!.bindings, ["SweepFactory", "SweepAlignmentType", "SweepCornerType", "SweepGuideMethod"]);
  assert.deepEqual(f.calls[0]!.values, [{
    regionIds: ["12r34"], spineId: 8, alignmentName: "Normal", cornerName: "Mitre", twistDegrees: 0, scale: 1, simplify: false,
    guideIds: [9], guideMethodName: "Curve",
  }]);
  const factory = f.created[0]!;
  assert.deepEqual(factory.regions, [f.regionView]);
  assert.equal(factory.spine, f.views.get(8));
  assert.deepEqual(factory.guides, [f.views.get(9)]);
  assert.equal(factory.guideMethod, ENUMS.SweepGuideMethod!.Curve);
});

test("sweepRegions guides without a method leave the native default and no guides leave the factory untouched", async () => {
  const guided = fixture();
  await guided.operations.sweepRegions(["12r34"], 8, { guideIds: [9] }, "r1");
  assert.deepEqual(guided.created[0]!.guides, [guided.views.get(9)]);
  assert.equal(guided.created[0]!.guideMethod, undefined);
  const plain = fixture();
  await plain.operations.sweepRegions(["12r34"], 8, { guideIds: [] }, "r1");
  assert.deepEqual(plain.calls[0]!.bindings, ["SweepFactory", "SweepAlignmentType", "SweepCornerType"]);
  assert.equal(plain.created[0]!.guides, undefined);
  assert.equal(plain.created[0]!.guideMethod, undefined);
});

test("rejects invalid sweepRegions guide inputs before mutation", async () => {
  const f = fixture();
  const ops = f.operations;
  await assert.rejects(ops.sweepRegions(["12r34"], 8, { guideIds: [9], guideMethod: "arc" as never }, "r1"), /guide method must be one of/i);
  await assert.rejects(ops.sweepRegions(["12r34"], 8, { guideMethod: "curve" }, "r1"), /requires guide IDs/i);
  await assert.rejects(ops.sweepRegions(["12r34"], 8, { guideIds: [9, 9] }, "r1"), /unique/i);
  await assert.rejects(ops.sweepRegions(["12r34"], 8, { guideIds: [10] }, "r1"), /current Wire IDs/i);
  await assert.rejects(ops.sweepRegions(["12r34"], 8, { guideIds: [999] }, "r1"), /current Wire IDs/i);
  await assert.rejects(ops.sweepRegions(["12r34"], 8, { guideIds: [8] }, "r1"), /must not be the spine/i);
  await assert.rejects(ops.sweepRegions(["12r34"], 8, { guideIds: [7] }, "r1"), /profile curves/i);
  assert.equal(f.calls.length, 0);
});

test("sweepCurves sweeps Wire profiles along a spine with guides, twist and scale", async () => {
  const f = fixture();
  await f.operations.sweepCurves([7, 11], 8, { guideIds: [9], guideMethod: "chord", twistDegrees: 45, scale: 1.5 }, "r1");
  assert.deepEqual(f.calls[0]!.bindings, ["SweepFactory", "SweepGuideMethod"]);
  assert.deepEqual(f.calls[0]!.values, [{ profileIds: [7, 11], spineId: 8, twistDegrees: 45, scale: 1.5, guideIds: [9], guideMethodName: "Chord" }]);
  assert.deepEqual(f.executed, ["SweepCommand"]);
  const factory = f.created[0]!;
  assert.equal(factory.factory, "SweepFactory");
  assert.deepEqual(factory.curves, [f.views.get(7), f.views.get(11)]);
  assert.equal(factory.spine, f.views.get(8));
  assert.deepEqual(factory.guides, [f.views.get(9)]);
  assert.equal(factory.guideMethod, ENUMS.SweepGuideMethod!.Chord);
  assert.equal(factory.twistDegrees, 45);
  assert.equal(factory.scale, 1.5);
  assert.equal(factory.regions, undefined);
  assert.equal(factory.thickness, undefined);
});

test("sweepCurves with only profiles and a spine sets nothing else", async () => {
  const f = fixture();
  await f.operations.sweepCurves([7], 8, {}, "r1");
  assert.deepEqual(f.calls[0]!.values, [{ profileIds: [7], spineId: 8 }]);
  const factory = f.created[0]!;
  assert.deepEqual(factory.curves, [f.views.get(7)]);
  for (const field of ["guides", "guideMethod", "twistDegrees", "scale", "alignment", "cornerType", "thickness", "simplify"]) {
    assert.equal(factory[field], undefined, field);
  }
});

test("rejects invalid sweepCurves inputs before mutation", async () => {
  const f = fixture();
  const ops = f.operations;
  await assert.rejects(ops.sweepCurves([], 8, {}, "r1"), /nonempty unique/i);
  await assert.rejects(ops.sweepCurves([7, 7], 8, {}, "r1"), /nonempty unique/i);
  await assert.rejects(ops.sweepCurves([10], 8, {}, "r1"), /profiles must be current Wire IDs/i);
  await assert.rejects(ops.sweepCurves([999], 8, {}, "r1"), /profiles must be current Wire IDs/i);
  await assert.rejects(ops.sweepCurves([7], 10, {}, "r1"), /Wire spine/i);
  await assert.rejects(ops.sweepCurves([7], 7, {}, "r1"), /spine must not be one of the profile/i);
  await assert.rejects(ops.sweepCurves([7], 8, { guideMethod: "curve" }, "r1"), /requires guide IDs/i);
  await assert.rejects(ops.sweepCurves([7], 8, { guideIds: [8] }, "r1"), /must not be the spine/i);
  await assert.rejects(ops.sweepCurves([7], 8, { guideIds: [7] }, "r1"), /profile curves/i);
  await assert.rejects(ops.sweepCurves([7], 8, { guideIds: [9, 9] }, "r1"), /unique/i);
  await assert.rejects(ops.sweepCurves([7], 8, { guideIds: [10] }, "r1"), /current Wire IDs/i);
  await assert.rejects(ops.sweepCurves([7], 8, { guideIds: [9], guideMethod: "arc" as never }, "r1"), /guide method must be one of/i);
  await assert.rejects(ops.sweepCurves([7], 8, { scale: 0 }, "r1"), /scale/i);
  await assert.rejects(ops.sweepCurves([7], 8, { twistDegrees: Number.POSITIVE_INFINITY }, "r1"), /twist/i);
  await assert.rejects(ops.sweepCurves([7], 8, {}, "stale"), /stale reference/i);
  assert.equal(f.calls.length, 0);
});

const close = (actual: unknown, expected: number[]) => {
  const value = actual as number[];
  assert.equal(value.length, expected.length);
  expected.forEach((item, index) => assert.ok(Math.abs(value[index]! - item) < 1e-9, `[${index}] ${value[index]} != ${item}`));
};

test("moveMeasurementLabel feeds the native factory a world offset in meters and keeps the name", async () => {
  const f = fixture();
  await f.operations.moveMeasurementLabel(1, [10, -10], "r1");
  assert.deepEqual(f.calls[0]!.bindings, ["MoveMeasurementFactory", "MoveMeasurementCommand"]);
  const factory = f.created[0]!;
  assert.equal(factory.factory, "MoveMeasurementFactory");
  assert.equal(factory.measurement, f.nativeMeasurement);
  close(factory.start.value, [2.8, 0, 0]);
  close(factory.end.value, [2.82, 0, 0]);
  close(factory.direction.value, [1, 0, 0]);
  // FINDINGS gap 4: offset (2.81, -0.01, 0) reads back as offsetMm [10, -10].
  close(factory.offset.value, [2.81, -0.01, 0]);
  assert.equal(f.selected.added[0], f.nativeMeasurement);
  assert.ok(f.selected.removed >= 2, "the selection is cleared before and after the move");
  // The stub drops the name on commit like Plasticity; the preservation step puts it back.
  assert.equal(f.repo.measurements[0]!.userData.name, "label");
});

test("moveMeasurementLabel offsets run along the direction and across normal x direction", async () => {
  const f = fixture();
  await f.operations.moveMeasurementLabel(1, [0, 5], "r1");
  close(f.created[0]!.offset.value, [2.8, 0.005, 0]);
  const rotated = fixture();
  const measurement = rotated.state.measurements![0]!;
  measurement.direction = [0, 1, 0];
  await rotated.operations.moveMeasurementLabel(1, [3, 4], "r1");
  // along = +y, across = normal x direction = (0,0,1) x (0,1,0) = -x
  close(rotated.created[0]!.offset.value, [2.8 - 0.004, 0.003, 0]);
});

test("moveMeasurementLabel does not invent a name for an unnamed measurement", async () => {
  const f = fixture({ measurementName: null });
  await f.operations.moveMeasurementLabel(1, [1, 1], "r1");
  assert.equal(f.repo.measurements[0]!.userData.name, undefined);
});

test("rejects invalid moveMeasurementLabel inputs before mutation", async () => {
  const f = fixture();
  const ops = f.operations;
  await assert.rejects(ops.moveMeasurementLabel(99, [0, 0], "r1"), /unknown current measurement/i);
  await assert.rejects(ops.moveMeasurementLabel(2, [0, 0], "r1"), /distance measurement/i);
  await assert.rejects(ops.moveMeasurementLabel(1, [Number.NaN, 0], "r1"), /finite/i);
  await assert.rejects(ops.moveMeasurementLabel(1, [0, Number.POSITIVE_INFINITY], "r1"), /finite/i);
  await assert.rejects(ops.moveMeasurementLabel(1, [0] as never, "r1"), /two finite/i);
  await assert.rejects(ops.moveMeasurementLabel(1, [0, 0], "stale"), /stale reference/i);
  assert.equal(f.calls.length, 0);
});

test("moveMeasurementLabel offsets round-trip on a Z-direction measurement", async () => {
  const f = fixture();
  const measurement = f.state.measurements![0]!;
  measurement.first!.positionMm = [2800, 0, 0];
  measurement.second!.positionMm = [2800, 0, 5];
  measurement.direction = [0, 0, 1];
  measurement.normal = [1, 0, 0];
  await f.operations.moveMeasurementLabel(1, [0, 5], "r1");
  // across = normal x direction = (1,0,0) x (0,0,1) = (0,-1,0)
  close(f.created[0]!.offset.value, [2.8, -0.005, 0]);
  const second = fixture();
  const other = second.state.measurements![0]!;
  other.second!.positionMm = [2800, 0, 5];
  other.direction = [0, 0, 1];
  other.normal = [1, 0, 0];
  await second.operations.moveMeasurementLabel(1, [3, 4], "r1");
  close(second.created[0]!.offset.value, [2.8, -0.004, 0.003]);
});

// A Plasticity build without an enum member must fail with a named error, not hand undefined to the factory.
async function withoutEnumMember(enumName: string, member: string, run: () => Promise<void>): Promise<void> {
  const original = ENUMS[enumName]![member]!;
  delete ENUMS[enumName]![member];
  try { await run(); } finally { ENUMS[enumName]![member] = original; }
}

test("a missing SweepGuideMethod member throws a clear native error before any guide is assigned", async () => {
  await withoutEnumMember("SweepGuideMethod", "Curve", async () => {
    const curves = fixture();
    await assert.rejects(curves.operations.sweepCurves([7], 8, { guideIds: [9], guideMethod: "curve" }, "r1"), /Plasticity build has no SweepGuideMethod\.Curve/);
    assert.equal(curves.created.length, 0, "the factory is never committed");
    const regions = fixture();
    await assert.rejects(regions.operations.sweepRegions(["12r34"], 8, { guideIds: [9], guideMethod: "curve" }, "r1"), /Plasticity build has no SweepGuideMethod\.Curve/);
    assert.equal(regions.created.length, 0);
    // Other members of the same enum and the no-method path still work.
    const chord = fixture();
    await chord.operations.sweepCurves([7], 8, { guideIds: [9], guideMethod: "chord" }, "r1");
    assert.equal(chord.created[0]!.guideMethod, ENUMS.SweepGuideMethod!.Chord);
  });
});

test("a missing ExtensionShape member throws a clear native error", async () => {
  await withoutEnumMember("ExtensionShape", "Soft", async () => {
    const f = fixture();
    await assert.rejects(f.operations.extendSheetEdges(5, ["e1"], 10, "r1", { shape: "soft" }), /Plasticity build has no ExtensionShape\.Soft/);
    assert.equal(f.created.length, 0);
  });
  await withoutEnumMember("ExtensionShape", "Linear", async () => {
    // The default shape is looked up by name too.
    const f = fixture();
    await assert.rejects(f.operations.extendSheetEdges(5, ["e1"], 10, "r1"), /Plasticity build has no ExtensionShape\.Linear/);
  });
});

test("a missing BodyExtensionType or ExtensionLimit member throws a clear native error", async () => {
  await withoutEnumMember("BodyExtensionType", "Target", async () => {
    const f = fixture();
    await assert.rejects(f.operations.extendSheetEdges(5, ["e1"], undefined, "r1", { targetId: 10 }), /Plasticity build has no BodyExtensionType\.Target/);
    // Distance extensions do not need the Target member.
    await f.operations.extendSheetEdges(5, ["e1"], 10, "r1");
    assert.equal(f.created[0]!.type, ENUMS.BodyExtensionType!.Distance);
  });
  await withoutEnumMember("BodyExtensionType", "Distance", async () => {
    await assert.rejects(fixture().operations.extendSheetEdges(5, ["e1"], 10, "r1"), /Plasticity build has no BodyExtensionType\.Distance/);
  });
  await withoutEnumMember("ExtensionLimit", "Minimal", async () => {
    await assert.rejects(fixture().operations.extendSheetEdges(5, ["e1"], 10, "r1"), /Plasticity build has no ExtensionLimit\.Minimal/);
  });
});
