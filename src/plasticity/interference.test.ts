import assert from "node:assert/strict";
import test from "node:test";

import {
  checkBodyInterference,
  type NativeInterferencePairResult,
} from "./interference.ts";
import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

const pairs = [{ firstBodyId: 7, secondBodyId: 8 }];

test("reports exact temporary native intersection evidence", async () => {
  const state = runtimeState();
  let source = "";
  let bindings: string[] = [];
  let arguments_: unknown;
  const runtime = {
    async getState() { return state; },
    async readNative(script: string, names: string[], values: unknown[]) {
      source = script;
      bindings = names;
      arguments_ = values[0];
      return [interferenceResult()];
    },
  } as unknown as PlasticityRuntime;

  const evidence = await checkBodyInterference(runtime, pairs, "r1", "session-1");

  assert.equal(evidence.sessionId, "session-1");
  assert.equal(evidence.documentToken, "doc-1");
  assert.equal(evidence.revision, "r1");
  assert.equal(evidence.source, "native-brep-temporary-intersection");
  assert.equal(evidence.pairs[0]?.status, "interfere");
  assert.deepEqual(evidence.pairs[0]?.intersectionBodies, [{
    type: "SolidBody",
    faceCount: 6,
    boundsMm: { min: [5, 0, 0], max: [10, 10, 10] },
    nativeCheckCodes: [],
  }]);
  assert.deepEqual(bindings, ["BooleanFactory", "kernel_Solid", "pk_default"]);
  assert.deepEqual(arguments_, { pairs, temporaryIds: [{ firstVersionId: 2_146_000_001, firstStableId: 2_146_000_000, secondVersionId: 2_145_999_999, secondStableId: 2_145_999_998 }] });
  assert.match(source, /makeTemporary/);
  assert.match(source, /findModel\(pair\.firstBodyId\)\.Clone\(\)/);
  assert.match(source, /operationType = 15901/);
  assert.match(source, /keepTools = false/);
  assert.match(source, /calculate\(factory\.partition\)/);
  assert.match(source, /FindBox/);
  assert.match(source, /await factory\.cancel/);
  assert.doesNotMatch(source, /this\.exec|commit\(/);
});

test("distinguishes absence of volume without claiming clearance or separation", async () => {
  const evidence = await inspect([{ firstBodyId: 7, secondBodyId: 8, outcome: "no-effect", error: "Operation has no effect", ...apart }]);

  assert.equal(evidence.pairs[0]?.status, "no-volumetric-interference");
  assert.deepEqual(evidence.pairs[0]?.reasons, ["native-intersection-has-no-volume"]);
  assert.equal(evidence.pairs[0]?.intersectionBodies, undefined);
  assert.equal("clearanceMm" in evidence.pairs[0]!, false);
  assert.equal(evidence.pairs[0]?.overlapVolumeMm3, 0);
});

test("returns bounded unsupported evidence for native failures and invalid intersection results", async () => {
  const nativeFailure = await inspect([{ firstBodyId: 7, secondBodyId: 8, outcome: "error", error: "kernel failure" }]);
  assert.equal(nativeFailure.pairs[0]?.status, "unsupported");
  assert.deepEqual(nativeFailure.pairs[0]?.reasons, ["native-intersection-failed"]);

  const invalid = interferenceResult();
  invalid.intersectionBodies![0]!.nativeCheckCodes = [17];
  const invalidEvidence = await inspect([invalid]);
  assert.equal(invalidEvidence.pairs[0]?.status, "unsupported");
  assert.deepEqual(invalidEvidence.pairs[0]?.reasons, ["native-check-failed"]);
});

test("rejects stale, duplicate, self, unknown and non-Solid pairs before native work", async () => {
  const candidates: Array<[typeof pairs, string, (state: RuntimeState) => void]> = [
    [pairs, "old", () => {}],
    [[...pairs, { firstBodyId: 8, secondBodyId: 7 }], "r1", () => {}],
    [[{ firstBodyId: 7, secondBodyId: 7 }], "r1", () => {}],
    [[{ firstBodyId: 7, secondBodyId: 99 }], "r1", () => {}],
    [pairs, "r1", (state) => { state.bodies[1]!.type = "Sheet"; }],
  ];
  for (const [candidatePairs, revision, mutateState] of candidates) {
    const state = runtimeState();
    mutateState(state);
    let reads = 0;
    const runtime = {
      async getState() { return state; },
      async readNative() { reads += 1; return []; },
    } as unknown as PlasticityRuntime;
    await assert.rejects(checkBodyInterference(runtime, candidatePairs, revision, "session-1"));
    assert.equal(reads, 0);
  }
});

test("discards all evidence when persistent document state changes during inspection", async () => {
  for (const changed of [
    { documentToken: "doc-2" },
    { revision: "r2" },
    { undoDepth: 3 },
    { redoDepth: 1 },
    { bodies: [{ ...runtimeState().bodies[0]!, versionId: 99 }, runtimeState().bodies[1]!] },
  ]) {
    let reads = 0;
    const runtime = {
      async getState() { reads += 1; return reads === 1 ? runtimeState() : { ...runtimeState(), ...changed }; },
      async readNative() { return [interferenceResult()]; },
    } as unknown as PlasticityRuntime;
    const evidence = await checkBodyInterference(runtime, pairs, "r1", "session-1");
    assert.equal(evidence.pairs[0]?.status, "unsupported");
    assert.deepEqual(evidence.pairs[0]?.reasons, ["document-changed-during-interference-check"]);
  }
});

test("ignores conservative floating bound drift when native identities and topology are unchanged", async () => {
  let reads = 0;
  const runtime = {
    async getState() {
      reads += 1;
      const state = runtimeState();
      if (reads === 2) {
        state.bodies[0]!.boundsMm!.max[0] += 1e-9;
      }
      return state;
    },
    async readNative() { return [interferenceResult()]; },
  } as unknown as PlasticityRuntime;

  const evidence = await checkBodyInterference(runtime, pairs, "r1", "session-1");
  assert.equal(evidence.pairs[0]?.status, "interfere");
});

test("requires a session and allocates fresh temporary identities", async () => {
  const state = runtimeState();
  const identities: unknown[] = [];
  const runtime = {
    async getState() { return state; },
    async readNative(_script: string, _names: string[], values: unknown[]) {
      identities.push((values[0] as { temporaryIds: unknown }).temporaryIds);
      return [interferenceResult()];
    },
  } as unknown as PlasticityRuntime;
  await assert.rejects(checkBodyInterference(runtime, pairs, "r1", ""), /session ID/i);
  await checkBodyInterference(runtime, pairs, "r1", "session-1");
  await checkBodyInterference(runtime, pairs, "r1", "session-1");
  assert.notDeepEqual(identities[0], identities[1]);
});

test("PlasticityOperations binds interference evidence to its owned session", async () => {
  const state = runtimeState();
  const runtime = {
    async getState() { return state; },
    async readNative() { return [interferenceResult()]; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "owned-session");

  const evidence = await operations.checkInterference(pairs, "r1");

  assert.equal(evidence.sessionId, "owned-session");
});

// What the kernel adds for two bodies that are apart: its clash test finds nothing in either role, and the reversed order
// has no effect either. "Operation has no effect" alone does not prove an empty intersection (a body strictly inside
// the other answers the same), so a no-effect result needs these facts.
const apart = { clash: { firstAsTarget: { types: [] }, secondAsTarget: { types: [] } }, reversed: { outcome: "no-effect" as const, error: "Operation has no effect" } };
const solid = (min: [number, number, number], max: [number, number, number], volumeM3: number | null) => ({ type: "SolidBody", faceCount: 6, boundsMm: { min, max }, nativeCheckCodes: [], volumeM3 });
const noEffect = { outcome: "no-effect" as const, error: "Operation has no effect" };
const touching = { firstAsTarget: { types: ["AbutNoClass", "AbutNoClass", "AbutNoClass"] }, secondAsTarget: { types: ["AbutNoClass", "AbutNoClass", "AbutNoClass"] } };

test("an interfering pair carries the overlap volume from the kernel's mass properties and the bounds from the kernel", async () => {
  // Two 10 mm boxes that share 4 x 10 x 10 mm: the kernel's mass properties give 4.000000000000001e-7 m3.
  const one = await inspect([{ firstBodyId: 7, secondBodyId: 8, outcome: "intersection", intersectionBodies: [solid([6, 0, 0], [10, 10, 10], 4.000000000000001e-7)] }]);
  const pair = one.pairs[0]!;
  assert.equal(pair.status, "interfere");
  assert.deepEqual(pair.reasons, []);
  assert.ok(Math.abs(pair.overlapVolumeMm3! - 400) <= 400 * 1e-12, String(pair.overlapVolumeMm3));
  assert.deepEqual(pair.overlapBoundsMm, { min: [6, 0, 0], max: [10, 10, 10] });
  assert.deepEqual(pair.intersectionBodies, [{ type: "SolidBody", faceCount: 6, boundsMm: { min: [6, 0, 0], max: [10, 10, 10] }, nativeCheckCodes: [], volumeMm3: pair.overlapVolumeMm3 }]);
  assert.equal("kernelEvidence" in pair, false, "a plain intersection needs no further kernel answer");

  // Several intersection bodies: the volume is their sum, the bounds their union.
  const two = await inspect([{ firstBodyId: 7, secondBodyId: 8, outcome: "intersection", intersectionBodies: [solid([0, 0, 0], [1, 1, 1], 1e-9), solid([8, 2, 3], [10, 4, 4], 4e-9)] }]);
  assert.ok(Math.abs(two.pairs[0]!.overlapVolumeMm3! - 5) < 1e-12);
  assert.deepEqual(two.pairs[0]!.overlapBoundsMm, { min: [0, 0, 0], max: [10, 4, 4] });
  assert.deepEqual(two.pairs[0]!.intersectionBodies!.map((body) => body.volumeMm3), [1, 4]);

  // The kernel's mass properties did not answer for one body: the pair still interferes, but no volume is claimed.
  for (const bad of [null, Number.NaN, 0, -1e-9]) {
    const missing = await inspect([{ firstBodyId: 7, secondBodyId: 8, outcome: "intersection", intersectionBodies: [solid([0, 0, 0], [1, 1, 1], 1e-9), solid([8, 2, 3], [10, 4, 4], bad)] }]);
    assert.equal(missing.pairs[0]!.status, "interfere");
    assert.equal("overlapVolumeMm3" in missing.pairs[0]!, false);
    assert.deepEqual(missing.pairs[0]!.reasons, ["overlap-volume-unavailable"]);
    assert.deepEqual(missing.pairs[0]!.overlapBoundsMm, { min: [0, 0, 0], max: [10, 4, 4] });
  }
});

test("bodies that touch without sharing volume: no-volumetric-interference with volume 0, in both body orders", async () => {
  const first = solid([0, 0, 0], [10, 10, 10], 1e-6);
  const second = solid([10, 0, 0], [20, 10, 10], 1e-6);
  for (const order of [{ firstBodyId: 7, secondBodyId: 8, first, second }, { firstBodyId: 8, secondBodyId: 7, first: second, second: first }]) {
    const state = runtimeState();
    const evidence = await checkBodyInterference({
      async getState() { return state; },
      async readNative() { return [{ ...order, ...noEffect, clash: touching, reversed: noEffect }]; },
    } as unknown as PlasticityRuntime, [{ firstBodyId: order.firstBodyId, secondBodyId: order.secondBodyId }], "r1", "session-1");
    const pair = evidence.pairs[0]!;
    assert.equal(pair.status, "no-volumetric-interference");
    assert.deepEqual(pair.reasons, ["native-intersection-has-no-volume", "contact-without-volume"]);
    assert.equal(pair.overlapVolumeMm3, 0);
    assert.equal(pair.intersectionBodies, undefined);
    assert.deepEqual(pair.kernelEvidence, { givenOrder: "no-effect", reversedOrder: "no-effect", clashTypes: ["AbutNoClass"], reversedClashTypes: ["AbutNoClass"] });
  }
  // The clash test alone (abutments only) is enough with the given order's no effect: the reversed order may fail.
  const reversedFails = await inspect([{ firstBodyId: 7, secondBodyId: 8, ...noEffect, first, second, clash: touching, reversed: { outcome: "error", error: "Operation Boolean failed at PK_BODY_boolean_2 with error `21653`" } }]);
  assert.equal(reversedFails.pairs[0]!.status, "no-volumetric-interference");
  assert.equal(reversedFails.pairs[0]!.overlapVolumeMm3, 0);
  // AbutBOutA (the second body outside the first) counts as touching too.
  const outside = await inspect([{ firstBodyId: 7, secondBodyId: 8, ...noEffect, first, second, clash: { firstAsTarget: { types: ["AbutBOutA", "AbutNoClass"] }, secondAsTarget: { types: ["AbutBOutA"] } }, reversed: noEffect }]);
  assert.deepEqual(outside.pairs[0]!.reasons, ["native-intersection-has-no-volume", "contact-without-volume"]);
});

test("the given order fails in the kernel (coplanar contact, error 21653): the reversed order and the clash test decide", async () => {
  const failure = { outcome: "error" as const, error: "Operation Boolean failed at PK_BODY_boolean_2 with error `21653`" };
  const first = solid([0, 0, 0], [30, 30, 10], 8.5e-6);
  const second = solid([10, 10, 5], [20, 20, 10], 5e-7);
  // Reversed order: no effect, and the clash test with the second body as A finds abutments only: no shared volume.
  const contact = await inspect([{ firstBodyId: 7, secondBodyId: 8, ...failure, first, second, clash: touching, reversed: noEffect }]);
  assert.equal(contact.pairs[0]!.status, "no-volumetric-interference");
  assert.deepEqual(contact.pairs[0]!.reasons, ["contact-without-volume"]);
  assert.equal(contact.pairs[0]!.overlapVolumeMm3, 0);
  assert.deepEqual(contact.pairs[0]!.kernelEvidence, { givenOrder: "error", givenOrderError: failure.error, reversedOrder: "no-effect", clashTypes: ["AbutNoClass"], reversedClashTypes: ["AbutNoClass"] });
  // Reversed order: no effect, no contact.
  const none = await inspect([{ firstBodyId: 7, secondBodyId: 8, ...failure, first, second, ...apart }]);
  assert.deepEqual([none.pairs[0]!.status, none.pairs[0]!.reasons, none.pairs[0]!.overlapVolumeMm3], ["no-volumetric-interference", ["native-intersection-has-no-volume"], 0]);
  // Reversed order made the intersection body: its volume (kernel mass properties) is the overlap.
  const body = await inspect([{ firstBodyId: 7, secondBodyId: 8, ...failure, first, second, clash: { firstAsTarget: { types: ["Interfere"] }, secondAsTarget: { types: ["Interfere"] } }, reversed: { outcome: "intersection", intersectionBodies: [solid([10, 10, 5], [20, 20, 7], 2e-7)] } }]);
  assert.deepEqual([body.pairs[0]!.status, body.pairs[0]!.reasons], ["interfere", ["intersection-from-reversed-body-order"]]);
  assert.ok(Math.abs(body.pairs[0]!.overlapVolumeMm3! - 200) < 1e-9);
  // Reversed order: no effect, and the second body lies strictly inside the first: the overlap is the second body.
  const inside = await inspect([{ firstBodyId: 7, secondBodyId: 8, ...failure, first, second, clash: { firstAsTarget: { types: ["BinA"] }, secondAsTarget: { types: ["AinB"] } }, reversed: noEffect }]);
  assert.deepEqual([inside.pairs[0]!.status, inside.pairs[0]!.reasons], ["interfere", ["second-body-inside-first"]]);
  assert.ok(Math.abs(inside.pairs[0]!.overlapVolumeMm3! - 500) < 1e-9);
  assert.deepEqual(inside.pairs[0]!.overlapBoundsMm, { min: [10, 10, 5], max: [20, 20, 10] });
  // Not provable: the reversed order fails too, the clash test reports interference, or it gave no answer.
  for (const unproven of [
    { clash: touching, reversed: failure },
    { clash: { firstAsTarget: { types: ["Interfere"] }, secondAsTarget: { types: ["Interfere", "AbutNoClass"] } }, reversed: noEffect },
    { clash: { firstAsTarget: { types: null, error: "x" }, secondAsTarget: { types: null, error: "x" } }, reversed: noEffect },
    { clash: { firstAsTarget: { types: ["AbutBInA"] }, secondAsTarget: { types: ["AbutBInA"] } }, reversed: noEffect },
    {},
  ]) {
    const evidence = await inspect([{ firstBodyId: 7, secondBodyId: 8, ...failure, first, second, ...unproven }]);
    assert.equal(evidence.pairs[0]!.status, "unsupported", JSON.stringify(unproven));
    assert.deepEqual(evidence.pairs[0]!.reasons, ["native-intersection-failed"]);
    assert.equal("overlapVolumeMm3" in evidence.pairs[0]!, false);
  }
});

test("\"Operation has no effect\" alone is not a zero: a body inside the other interferes, and what is not proven is unsupported", async () => {
  const small = solid([2, 2, 2], [5, 5, 5], 2.7e-8);
  const large = solid([0, 0, 0], [10, 10, 10], 1e-6);
  // The first body lies strictly inside the second: the given order changes nothing, the reversed order makes the body.
  const reversed = await inspect([{ firstBodyId: 7, secondBodyId: 8, ...noEffect, first: small, second: large, clash: { firstAsTarget: { types: ["AinB"] }, secondAsTarget: { types: ["BinA"] } }, reversed: { outcome: "intersection", intersectionBodies: [solid([2, 2, 2], [5, 5, 5], 2.7000000000000027e-8)] } }]);
  assert.deepEqual([reversed.pairs[0]!.status, reversed.pairs[0]!.reasons], ["interfere", ["intersection-from-reversed-body-order"]]);
  assert.ok(Math.abs(reversed.pairs[0]!.overlapVolumeMm3! - 27) < 1e-9);
  assert.deepEqual(reversed.pairs[0]!.kernelEvidence, { givenOrder: "no-effect", reversedOrder: "intersection", clashTypes: ["AinB"], reversedClashTypes: ["BinA"] });
  // The reversed order failed: the clash test (AinB) with the no effect still proves containment; the overlap is the first body.
  const clashOnly = await inspect([{ firstBodyId: 7, secondBodyId: 8, ...noEffect, first: small, second: large, clash: { firstAsTarget: { types: ["AinB"] }, secondAsTarget: { types: ["BinA"] } }, reversed: { outcome: "error", error: "kernel failure" } }]);
  assert.deepEqual([clashOnly.pairs[0]!.status, clashOnly.pairs[0]!.reasons], ["interfere", ["first-body-inside-second"]]);
  assert.ok(Math.abs(clashOnly.pairs[0]!.overlapVolumeMm3! - 27) < 1e-9);
  assert.deepEqual(clashOnly.pairs[0]!.intersectionBodies, [{ type: "SolidBody", faceCount: 6, boundsMm: { min: [2, 2, 2], max: [5, 5, 5] }, nativeCheckCodes: [], volumeMm3: clashOnly.pairs[0]!.overlapVolumeMm3 }]);

  // No further kernel answer at all (what the tool returned before): not proven.
  const bare = await inspect([{ firstBodyId: 7, secondBodyId: 8, ...noEffect }]);
  assert.deepEqual([bare.pairs[0]!.status, bare.pairs[0]!.reasons, "overlapVolumeMm3" in bare.pairs[0]!], ["unsupported", ["native-intersection-not-proven-empty"], false]);
  // The clash test reports interference although both orders changed nothing: not proven.
  const interfere = await inspect([{ firstBodyId: 7, secondBodyId: 8, ...noEffect, first: small, second: large, clash: { firstAsTarget: { types: ["Interfere"] }, secondAsTarget: { types: ["Interfere"] } }, reversed: noEffect }]);
  assert.deepEqual([interfere.pairs[0]!.status, interfere.pairs[0]!.reasons], ["unsupported", ["native-intersection-not-proven-empty"]]);
  // The reversed order made a body although the clash test saw no contact, or abutments only: contradictory.
  for (const types of [[], ["AbutNoClass"]]) {
    const odd = await inspect([{ firstBodyId: 7, secondBodyId: 8, ...noEffect, first: small, second: large, clash: { firstAsTarget: { types }, secondAsTarget: { types } }, reversed: { outcome: "intersection", intersectionBodies: [small] } }]);
    assert.deepEqual([odd.pairs[0]!.status, odd.pairs[0]!.reasons], ["unsupported", ["native-evidence-contradictory"]]);
  }
  // Without a clash answer, two orders with no effect prove an empty intersection only for two different solids.
  const noClash = { firstAsTarget: { types: null, error: "unavailable" }, secondAsTarget: { types: null, error: "unavailable" } };
  const different = await inspect([{ firstBodyId: 7, secondBodyId: 8, ...noEffect, first: small, second: large, clash: noClash, reversed: noEffect }]);
  assert.deepEqual([different.pairs[0]!.status, different.pairs[0]!.reasons, different.pairs[0]!.overlapVolumeMm3], ["no-volumetric-interference", ["native-intersection-has-no-volume"], 0]);
  const same = await inspect([{ firstBodyId: 7, secondBodyId: 8, ...noEffect, first: large, second: solid([0, 0, 0], [10, 10, 10], 1e-6), clash: noClash, reversed: noEffect }]);
  assert.deepEqual([same.pairs[0]!.status, same.pairs[0]!.reasons], ["unsupported", ["native-intersection-not-proven-empty"]]);
  const sameBoundsOtherVolume = await inspect([{ firstBodyId: 7, secondBodyId: 8, ...noEffect, first: large, second: solid([0, 0, 0], [10, 10, 10], 5e-7), clash: noClash, reversed: noEffect }]);
  assert.equal(sameBoundsOtherVolume.pairs[0]!.status, "no-volumetric-interference");
  const unmeasured = await inspect([{ firstBodyId: 7, secondBodyId: 8, ...noEffect, first: large, second: solid([0, 0, 0], [10, 10, 10], null), clash: noClash, reversed: noEffect }]);
  assert.equal(unmeasured.pairs[0]!.status, "unsupported");
});

test("the status values are the three they always were, and the native source only reads", async () => {
  const statuses = new Set<string>();
  const cases: NativeInterferencePairResult[] = [
    interferenceResult(),
    { firstBodyId: 7, secondBodyId: 8, ...noEffect, ...apart },
    { firstBodyId: 7, secondBodyId: 8, ...noEffect, clash: touching, reversed: noEffect },
    { firstBodyId: 7, secondBodyId: 8, ...noEffect },
    { firstBodyId: 7, secondBodyId: 8, outcome: "error", error: "kernel failure" },
    { firstBodyId: 9, secondBodyId: 8, outcome: "no-effect" },
  ];
  for (const native of cases) statuses.add((await inspect([native])).pairs[0]!.status);
  assert.deepEqual([...statuses].sort(), ["interfere", "no-volumetric-interference", "unsupported"]);

  let source = "";
  const state = runtimeState();
  await checkBodyInterference({
    async getState() { return state; },
    async readNative(script: string) { source = script; return [interferenceResult()]; },
  } as unknown as PlasticityRuntime, pairs, "r1", "session-1");
  // The volume comes from the kernel's mass properties of the intersection body, read before the cleanup removes it.
  assert.match(source, /MassProperties\(Int32Array\.of\(body\.Id\(\)\), Float64Array\.of\(1\)\)/);
  assert.ok(source.indexOf("calculation.bodies.map(describe)") < source.indexOf("await factory.cancel"), "described before the cleanup");
  // The contact question is asked of the kernel's clash test and of the reversed order, on clones in the temporary database.
  assert.match(source, /Collisions\(Int32Array\.of\(findModel\(targetId\)\.Id\(\)\), Int32Array\.of\(findModel\(toolId\)\.Id\(\)\)\)/);
  assert.match(source, /intersect\(\(\) => findModel\(pair\.secondBodyId\)\.Clone\(\), \(\) => findModel\(pair\.firstBodyId\)\.Clone\(\), ids\)/);
  // Nothing in it runs a command, commits a factory, or adds or removes an item of the document.
  assert.doesNotMatch(source, /this\.exec|\.exec\(|commit\(|\.undo\(\)|\.redo\(\)|nativeApi\.geo\.(addItem|removeItem|replaceItem)|this\.db\.(addItem|removeItem)/);
  assert.equal(source.match(/removeItem\(/g)?.length, 2, "only the two temporary items are removed, from the temporary database");
  assert.match(source, /await temporary\.removeItem\(secondView, 'user'\)/);
  assert.match(source, /await temporary\.removeItem\(firstView, 'user'\)/);
});

async function inspect(result: NativeInterferencePairResult[]) {
  const state = runtimeState();
  return await checkBodyInterference({
    async getState() { return state; },
    async readNative() { return structuredClone(result); },
  } as unknown as PlasticityRuntime, pairs, "r1", "session-1");
}

function interferenceResult(): NativeInterferencePairResult {
  return {
    firstBodyId: 7,
    secondBodyId: 8,
    outcome: "intersection",
    intersectionBodies: [{
      type: "SolidBody",
      faceCount: 6,
      boundsMm: { min: [5, 0, 0], max: [10, 10, 10] },
      nativeCheckCodes: [],
    }],
  };
}

function runtimeState(): RuntimeState {
  const body = (id: number, versionId: number, min: [number, number, number], max: [number, number, number]): RuntimeState["bodies"][number] => ({
    id, versionId, type: "Solid", name: `Body ${id}`, boundsMm: { min, max }, faceIds: [], edgeIds: [], faces: [], edges: [],
  });
  return {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1",
    dbVersion: 1, undoDepth: 2, redoDepth: 0, regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" },
    bodies: [body(7, 17, [0, 0, 0], [10, 10, 10]), body(8, 18, [5, 0, 0], [15, 10, 10])],
  };
}
