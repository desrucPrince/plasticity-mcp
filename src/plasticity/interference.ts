import { nativeFunction } from "./native-function.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

type Vector3 = [number, number, number];

export interface BodyInterferencePair {
  firstBodyId: number;
  secondBodyId: number;
}

export interface NativeIntersectionBody {
  type: string;
  faceCount: number;
  boundsMm: { min: Vector3; max: Vector3 };
  nativeCheckCodes: number[];
  /** Volume from the kernel's mass properties, when it was evaluated without error. Measured against analytic values: about 1e-15 relative on overlaps bounded by planar faces, within 1e-4 relative on curved ones (largest measured error 6.2e-5); not a proof of an exact value on curved overlaps. */
  volumeMm3?: number;
}

/** A kernel body as the renderer describes it: volumeM3 is null when the kernel's mass properties did not answer. */
export interface NativeBodyFacts extends Omit<NativeIntersectionBody, "volumeMm3"> {
  volumeM3?: number | null;
}

/** One kernel intersection of a target clone with a tool clone. */
export interface NativeIntersectionPass {
  outcome: "intersection" | "no-effect" | "error";
  intersectionBodies?: NativeBodyFacts[];
  error?: string;
}

/** The kernel's clash test of two bodies (PK_TOPOL_clash): type names, or null with the reason it gave none. */
export interface NativeClashFacts {
  types: string[] | null;
  error?: string;
}

// outcome, intersectionBodies and error are the pass in the given order (first body as target). When it made no
// intersection body, the renderer adds what else the kernel says: both clones' own facts, its clash test in both
// roles, and the pass in the reversed order.
export interface NativeInterferencePairResult extends BodyInterferencePair, NativeIntersectionPass {
  first?: NativeBodyFacts;
  second?: NativeBodyFacts;
  clash?: { firstAsTarget?: NativeClashFacts; secondAsTarget?: NativeClashFacts };
  reversed?: NativeIntersectionPass;
}

export interface BodyInterferencePairEvidence extends BodyInterferencePair {
  status: "interfere" | "no-volumetric-interference" | "unsupported";
  intersectionBodies?: NativeIntersectionBody[];
  reasons: string[];
  /** interfere: the volume of the intersection from the kernel's mass properties (the sum over its bodies); about 1e-15 relative agreement with analytic values on overlaps bounded by planar faces, within 1e-4 relative on curved ones (largest measured error 6.2e-5), not a proof of an exact value on curved overlaps. no-volumetric-interference: 0. */
  overlapVolumeMm3?: number;
  /** interfere: the exact bounds of the intersection. */
  overlapBoundsMm?: { min: Vector3; max: Vector3 };
  /** What the kernel answered when the pass in the given order made no intersection body. */
  kernelEvidence?: { givenOrder: NativeIntersectionPass["outcome"]; givenOrderError?: string; reversedOrder?: NativeIntersectionPass["outcome"]; clashTypes?: string[]; reversedClashTypes?: string[] };
}

export interface BodyInterferenceEvidence {
  sessionId: string;
  documentToken: string;
  revision: string;
  source: "native-brep-temporary-intersection";
  pairs: BodyInterferencePairEvidence[];
}

interface TemporaryIds {
  firstVersionId: number;
  firstStableId: number;
  secondVersionId: number;
  secondStableId: number;
}

const MAX_PAIRS = 256;
// Clash types that say two bodies touch there without sharing volume (an abutment with the second body inside the
// first, AbutBInA, is not one of them).
const OUTSIDE_CONTACT = ["AbutNoClass", "AbutBOutA"] as const;
// Two solids count as possibly the same solid when every bound agrees within this and their volumes within this ratio.
const SAME_SOLID_BOUNDS_MM = 1e-6;
const SAME_SOLID_VOLUME_RATIO = 1e-9;
let nextTemporaryVersionId = 2_146_000_001;

export async function checkBodyInterference(
  runtime: PlasticityRuntime,
  pairs: BodyInterferencePair[],
  revision: string,
  sessionId: string,
): Promise<BodyInterferenceEvidence> {
  if (!sessionId) throw new Error("MCP session ID is required");
  if (pairs.length === 0) throw new Error("At least one body pair is required");
  if (pairs.length > MAX_PAIRS) throw new Error(`At most ${MAX_PAIRS} body pairs can be checked at once`);
  const before = await runtime.getState();
  if (before.revision !== revision) throw new Error(`Stale reference: expected revision ${revision}, current revision is ${before.revision}`);
  validatePairs(before, pairs);

  const temporaryIds = pairs.map(() => allocateTemporaryIds());
  const native = await collectNativeIntersections(runtime, pairs, temporaryIds);
  const after = await runtime.getState();
  if (!samePersistentState(before, after)) {
    return evidence(sessionId, before, pairs.map((pair) => ({
      ...pair,
      status: "unsupported",
      reasons: ["document-changed-during-interference-check"],
    })));
  }
  if (native.length !== pairs.length) {
    return evidence(sessionId, before, pairs.map((pair) => ({
      ...pair,
      status: "unsupported",
      reasons: ["native-result-count-mismatch"],
    })));
  }

  return evidence(sessionId, before, pairs.map((pair, index) => interpret(pair, native[index]!)));
}

async function collectNativeIntersections(
  runtime: PlasticityRuntime,
  pairs: BodyInterferencePair[],
  temporaryIds: TemporaryIds[],
): Promise<NativeInterferencePairResult[]> {
  return await runtime.readNative<NativeInterferencePairResult[]>(nativeFunction`async function (BooleanFactory, kernel_Solid, pk_default, args) {
    const mm = value => value * 1000;
    const point = value => [mm(value.x), mm(value.y), mm(value.z)];
    const message = error => String(error?.message ?? error).slice(0, 240);
    const kernel = pk_default?.a ?? pk_default;
    const findEntry = id => {
      const matches = [];
      for (const [versionId, item] of nativeApi.geo.geometryModel) {
        if (nativeApi.db.lookupStableId(versionId) === id) matches.push({ versionId, item });
      }
      if (matches.length !== 1 || matches[0].item.view?.constructor?.name !== 'Solid') {
        throw new Error('Requested current Solid is unavailable');
      }
      return matches[0];
    };
    const findModel = id => findEntry(id).item.model;
    // Volume of one kernel body in cubic metres from the kernel's mass properties (Eval.MassProperties, density 1), or null when it gave no clean answer.
    // The kernel integrates curved overlaps numerically: about 1e-15 relative agreement with analytic values on overlaps bounded by planar faces,
    // within 1e-4 relative on curved ones (largest measured error 6.2e-5); not a proof of an exact value on curved overlaps.
    const volumeOf = body => {
      try {
        const mass = new kernel.Eval(kernel.Context.Get()).MassProperties(Int32Array.of(body.Id()), Float64Array.of(1));
        const errors = Array.from(mass?.errors ?? [], Number);
        const amount = Number(mass?.amountSum);
        return mass?.ok === 1 && errors.length === 1 && errors[0] === 0 && Number.isFinite(amount) ? amount : null;
      } catch { return null; }
    };
    const describe = body => {
      const box = body?.FindBox?.();
      return {
        type: String(body?.constructor?.name ?? 'Unknown'),
        faceCount: Number(body?.GetFaces?.().Size?.() ?? -1),
        boundsMm: box ? { min: point(box.min), max: point(box.max) } : null,
        nativeCheckCodes: Array.from(body?.Check?.() ?? [-1], Number),
        volumeM3: volumeOf(body),
      };
    };
    // The kernel's clash test (Eval.Collisions, Parasolid PK_TOPOL_clash) of two document bodies: every clashing pair
    // of their faces, as Interfere (the bodies interpenetrate there), Abut* (they touch there), AinB or BinA (one body
    // lies inside the other without touching it); no entry at all when they are apart. A query: it changes neither body.
    const clash = (targetId, toolId) => {
      try {
        const result = new kernel.Eval(kernel.Context.Get()).Collisions(Int32Array.of(findModel(targetId).Id()), Int32Array.of(findModel(toolId).Id()));
        const types = result?.clashTypes;
        if (!types || typeof types.length !== 'number') throw new Error('The clash test returned no type list');
        return { types: Array.from(types, type => String(kernel.ClashType?.[Number(type)] ?? type)) };
      } catch (error) { return { types: null, error: message(error) }; }
    };
    // One kernel intersection of two clones in a temporary geometry database. cloneTarget and cloneTool make the
    // clones; describeClones, when given, receives their own facts before the kernel changes them.
    const intersect = async (cloneTarget, cloneTool, ids, describeClones) => {
      const temporary = nativeApi.geo.makeTemporary();
      Object.defineProperty(temporary, 'primaryPartition', { value: nativeApi.geo.primaryPartition });
      const temporaryDatabase = Object.create(this.db);
      Object.defineProperty(temporaryDatabase, 'geo', { value: temporary });
      const temporaryEditor = Object.create(this);
      Object.defineProperties(temporaryEditor, {
        geo: { value: temporary },
        db: { value: temporaryDatabase },
      });
      let firstCopy;
      let secondCopy;
      let firstView;
      let secondView;
      let factory;
      let output;
      let cleanupFailed = false;
      try {
        firstCopy = cloneTarget();
        secondCopy = cloneTool();
        if (describeClones) describeClones(describe(firstCopy), describe(secondCopy));
        const models = temporary.read?.geometryModel ?? temporary.geometryModel;
        const usedVersions = new Set(models.keys());
        while (usedVersions.has(ids.firstVersionId) || temporary.hasStableId(ids.firstStableId) ||
          usedVersions.has(ids.secondVersionId) || temporary.hasStableId(ids.secondStableId)) {
          ids.firstVersionId -= 4;
          ids.firstStableId -= 4;
          ids.secondVersionId -= 4;
          ids.secondStableId -= 4;
        }
        const firstJob = nativeApi.temporaryModelData(firstCopy, ids.firstVersionId, ids.firstStableId);
        const secondJob = nativeApi.temporaryModelData(secondCopy, ids.secondVersionId, ids.secondStableId);
        const views = await this.views.build([
          firstJob, secondJob,
        ], 'real');
        firstView = views[0];
        secondView = views[1];
        await nativeApi.addTemporaryItem(temporary, firstJob, firstView);
        await nativeApi.addTemporaryItem(temporary, secondJob, secondView);
        factory = new BooleanFactory(temporaryEditor);
        factory.targets = [firstView];
        factory.tools = [secondView];
        factory.operationType = 15901;
        factory.keepTools = false;
        try {
          const calculation = await nativeApi.calculateBoolean(factory, kernel_Solid);
          // The volume is read here, while the intersection bodies exist: the cleanup below removes them.
          const intersectionBodies = calculation.bodies.map(describe);
          output = calculation.noEffect
            ? { outcome: 'no-effect', error: 'Operation has no effect' }
            : { outcome: 'intersection', intersectionBodies };
        } catch (error) {
          output = /Operation has no effect/i.test(String(error?.message ?? error))
            ? { outcome: 'no-effect', error: 'Operation has no effect' }
            : { outcome: 'error', error: message(error) };
        }
      } catch (error) {
        output = { outcome: 'error', error: message(error) };
      } finally {
        try { if (factory) await factory.cancel(); } catch { cleanupFailed = true; }
        try {
          if (secondView && (temporary.read?.geometryModel ?? temporary.geometryModel).has(ids.secondVersionId)) await temporary.removeItem(secondView, 'user');
        } catch { cleanupFailed = true; }
        try {
          if (firstView && (temporary.read?.geometryModel ?? temporary.geometryModel).has(ids.firstVersionId)) await temporary.removeItem(firstView, 'user');
        } catch { cleanupFailed = true; }
        try {
          if (typeof kernel_Solid.Exists !== 'function') throw new Error('Solid existence check is unavailable');
          const idsToRemove = [firstCopy, secondCopy].filter(Boolean).map(body => body.Id()).filter(id => kernel_Solid.Exists(id));
          if (idsToRemove.length > 0) kernel_Solid.Remove(idsToRemove);
        } catch { cleanupFailed = true; }
      }
      return cleanupFailed ? { outcome: 'error', error: 'Temporary native cleanup failed' } : output;
    };
    const cleanupFailed = pass => pass?.outcome === 'error' && pass.error === 'Temporary native cleanup failed';
    const inspectPair = async (pair, ids) => {
      let first = null;
      let second = null;
      const given = await intersect(() => findModel(pair.firstBodyId).Clone(), () => findModel(pair.secondBodyId).Clone(), ids, (target, tool) => { first = target; second = tool; });
      if (given.outcome === 'intersection' || cleanupFailed(given)) return { ...pair, ...given };
      // No intersection body in this order. What else the kernel says decides between "no shared volume", "one body
      // inside the other" and "not proven": its clash test in both roles, and the same intersection in the other order.
      const clashes = { firstAsTarget: clash(pair.firstBodyId, pair.secondBodyId), secondAsTarget: clash(pair.secondBodyId, pair.firstBodyId) };
      const reversed = await intersect(() => findModel(pair.secondBodyId).Clone(), () => findModel(pair.firstBodyId).Clone(), ids);
      if (cleanupFailed(reversed)) return { ...pair, ...reversed };
      return { ...pair, ...given, first, second, clash: clashes, reversed };
    };
    const results = [];
    for (let index = 0; index < args.pairs.length; index += 1) {
      results.push(await inspectPair(args.pairs[index], args.temporaryIds[index]));
    }
    return results;
  }`, ["BooleanFactory", "kernel_Solid", "pk_default"], [{ pairs, temporaryIds }]);
}

function validatePairs(state: RuntimeState, pairs: BodyInterferencePair[]): void {
  const bodies = new Map(state.bodies.map((body) => [body.id, body]));
  const seen = new Set<string>();
  for (const pair of pairs) {
    if (!Number.isInteger(pair.firstBodyId) || pair.firstBodyId <= 0 || !Number.isInteger(pair.secondBodyId) || pair.secondBodyId <= 0) {
      throw new Error("Interference body IDs must be positive integers");
    }
    if (pair.firstBodyId === pair.secondBodyId) throw new Error("An interference pair must contain two different bodies");
    const key = [pair.firstBodyId, pair.secondBodyId].sort((left, right) => left - right).join(":");
    if (seen.has(key)) throw new Error(`Duplicate unordered interference pair: ${key}`);
    seen.add(key);
    const first = bodies.get(pair.firstBodyId);
    const second = bodies.get(pair.secondBodyId);
    if (!first || !second) throw new Error(`Unknown current body in interference pair: ${key}`);
    if (first.type !== "Solid" || second.type !== "Solid") throw new Error(`Interference checks require two Solid bodies: ${key}`);
  }
}

// Reads the kernel's answers for one pair. A value is given only where the kernel proves it.
// Measured on 26.1.3 (discovery/tools-2026-11): the intersection of a target with a tool answers "Operation has no
// effect" when the target lies strictly inside the tool and when the two share no volume (apart, or touching on a face,
// an edge, a vertex or a tangent point); the clash test answers nothing for bodies that are apart, AinB or BinA for
// strict containment, Interfere for every overlap (also a body inside another that touches its faces, and two equal
// bodies), and only AbutNoClass for bodies that touch without overlap.
//   interfere                    the kernel made an intersection body (in the given order, or in the reversed order), or
//                                it changed nothing and its clash test puts the whole first body inside the second;
//   no-volumetric-interference   the kernel changed nothing in the given order and containment is ruled out: its clash
//                                test finds no contact, or finds abutments only, or the reversed order has no effect
//                                either while the two bodies are not the same solid. When the given order failed in
//                                the kernel: the reversed order changed nothing and the clash test finds no contact
//                                or abutments only;
//   unsupported                  anything else.
function interpret(pair: BodyInterferencePair, native: NativeInterferencePairResult): BodyInterferencePairEvidence {
  if (native.firstBodyId !== pair.firstBodyId || native.secondBodyId !== pair.secondBodyId) {
    return { ...pair, status: "unsupported", reasons: ["native-pair-mismatch"] };
  }
  if (native.outcome === "intersection") return interfering(pair, native.intersectionBodies ?? [], []);

  const reversed = native.reversed;
  const clashTypes = clashTypesOf(native.clash?.firstAsTarget);
  const reversedClashTypes = clashTypesOf(native.clash?.secondAsTarget);
  const kernelEvidence: NonNullable<BodyInterferencePairEvidence["kernelEvidence"]> = {
    givenOrder: native.outcome,
    ...(native.outcome === "error" && typeof native.error === "string" ? { givenOrderError: native.error } : {}),
    ...(reversed ? { reversedOrder: reversed.outcome } : {}),
    ...(clashTypes ? { clashTypes: [...new Set(clashTypes)].sort() } : {}),
    ...(reversedClashTypes ? { reversedClashTypes: [...new Set(reversedClashTypes)].sort() } : {}),
  };
  const withEvidence = (result: BodyInterferencePairEvidence): BodyInterferencePairEvidence => ({ ...result, kernelEvidence });
  const noVolume = (reasons: string[]) => withEvidence({ ...pair, status: "no-volumetric-interference", reasons, overlapVolumeMm3: 0 });
  const unsupported = (reason: string) => withEvidence({ ...pair, status: "unsupported", reasons: [reason] });
  const noContact = (types: string[] | undefined) => types !== undefined && types.length === 0;
  const all = (types: string[] | undefined, names: readonly string[]) => types !== undefined && types.length > 0 && types.every((type) => names.includes(type));
  const touchOnly = (types: string[] | undefined) => all(types, OUTSIDE_CONTACT);

  if (native.outcome === "no-effect") {
    // The given order changed nothing: the first body lies inside the second, or they share no volume.
    if (reversed?.outcome === "intersection") {
      // The reversed order made a body, so there is volume; a clash test that saw no contact or abutments only contradicts it.
      if (noContact(clashTypes) || touchOnly(clashTypes)) return unsupported("native-evidence-contradictory");
      return withEvidence(interfering(pair, reversed.intersectionBodies ?? [], ["intersection-from-reversed-body-order"]));
    }
    if (noContact(clashTypes)) return noVolume(["native-intersection-has-no-volume"]);
    if (all(clashTypes, ["AinB"])) return withEvidence(interfering(pair, native.first ? [native.first] : [], ["first-body-inside-second"]));
    if (touchOnly(clashTypes)) return noVolume(["native-intersection-has-no-volume", "contact-without-volume"]);
    // Without a clash answer: both orders changed nothing, so each body lies inside the other or they share no volume,
    // and two bodies that differ in extent or volume cannot each lie inside the other.
    if (clashTypes === undefined && reversed?.outcome === "no-effect" && distinctSolids(native.first, native.second)) {
      return noVolume(["native-intersection-has-no-volume"]);
    }
    return unsupported("native-intersection-not-proven-empty");
  }

  // The given order failed in the kernel (for example PK_BODY_boolean_2 error 21653 on coplanar contact).
  if (reversed?.outcome === "intersection") {
    if (noContact(reversedClashTypes) || touchOnly(reversedClashTypes)) return unsupported("native-evidence-contradictory");
    return withEvidence(interfering(pair, reversed.intersectionBodies ?? [], ["intersection-from-reversed-body-order"]));
  }
  if (reversed?.outcome === "no-effect") {
    // The second body lies inside the first, or they share no volume; the clash test with the second body as A decides.
    if (noContact(reversedClashTypes)) return noVolume(["native-intersection-has-no-volume"]);
    if (all(reversedClashTypes, ["AinB"])) return withEvidence(interfering(pair, native.second ? [native.second] : [], ["second-body-inside-first"]));
    if (touchOnly(reversedClashTypes)) return noVolume(["contact-without-volume"]);
  }
  return unsupported("native-intersection-failed");
}

function clashTypesOf(clash: NativeClashFacts | undefined): string[] | undefined {
  return Array.isArray(clash?.types) && clash.types.every((type) => typeof type === "string") ? clash.types : undefined;
}

function interfering(pair: BodyInterferencePair, bodies: NativeBodyFacts[], reasons: string[]): BodyInterferencePairEvidence {
  if (bodies.length === 0) return { ...pair, status: "unsupported", reasons: ["empty-native-intersection-result"] };
  if (bodies.some((body) => body.type !== "SolidBody" || body.faceCount <= 0 || !validBounds(body.boundsMm))) {
    return { ...pair, status: "unsupported", reasons: ["invalid-native-intersection-result"] };
  }
  if (bodies.some((body) => body.nativeCheckCodes.length > 0)) {
    return { ...pair, status: "unsupported", reasons: ["native-check-failed"] };
  }
  const volumes = bodies.map((body) => (typeof body.volumeM3 === "number" && Number.isFinite(body.volumeM3) && body.volumeM3 > 0 ? body.volumeM3 * 1_000_000_000 : undefined));
  const measured = volumes.every((volume) => volume !== undefined);
  const intersectionBodies = bodies.map((body, index): NativeIntersectionBody => ({
    type: body.type,
    faceCount: body.faceCount,
    boundsMm: body.boundsMm,
    nativeCheckCodes: body.nativeCheckCodes,
    ...(volumes[index] !== undefined ? { volumeMm3: volumes[index] } : {}),
  }));
  const overlapBoundsMm = {
    min: [0, 1, 2].map((axis) => Math.min(...bodies.map((body) => body.boundsMm.min[axis]!))) as Vector3,
    max: [0, 1, 2].map((axis) => Math.max(...bodies.map((body) => body.boundsMm.max[axis]!))) as Vector3,
  };
  return {
    ...pair,
    status: "interfere",
    intersectionBodies,
    // The volume is given only when the kernel evaluated every intersection body without error.
    reasons: measured ? reasons : [...reasons, "overlap-volume-unavailable"],
    ...(measured ? { overlapVolumeMm3: volumes.reduce<number>((sum, volume) => sum + volume!, 0) } : {}),
    overlapBoundsMm,
  };
}

/** Whether two solids are provably not the same solid: their exact bounds or volumes differ. */
function distinctSolids(first: NativeBodyFacts | undefined, second: NativeBodyFacts | undefined): boolean {
  if (!first || !second || !validBounds(first.boundsMm) || !validBounds(second.boundsMm)) return false;
  const boundsDiffer = [...first.boundsMm.min, ...first.boundsMm.max].some((value, index) =>
    Math.abs(value - [...second.boundsMm.min, ...second.boundsMm.max][index]!) > SAME_SOLID_BOUNDS_MM);
  if (boundsDiffer) return true;
  const volumes = [first.volumeM3, second.volumeM3];
  if (!volumes.every((volume): volume is number => typeof volume === "number" && Number.isFinite(volume) && volume > 0)) return false;
  return Math.abs(volumes[0]! - volumes[1]!) > SAME_SOLID_VOLUME_RATIO * Math.max(volumes[0]!, volumes[1]!);
}

function validBounds(bounds: NativeIntersectionBody["boundsMm"]): boolean {
  return Boolean(bounds) && [...bounds.min, ...bounds.max].every(Number.isFinite) &&
    bounds.min.every((value, index) => value <= bounds.max[index]!);
}

function evidence(
  sessionId: string,
  state: RuntimeState,
  pairs: BodyInterferencePairEvidence[],
): BodyInterferenceEvidence {
  return {
    sessionId,
    documentToken: state.documentToken,
    revision: state.revision,
    source: "native-brep-temporary-intersection",
    pairs,
  };
}

function allocateTemporaryIds(): TemporaryIds {
  if (nextTemporaryVersionId < 1_500_000_001) nextTemporaryVersionId = 2_146_000_001;
  const firstVersionId = nextTemporaryVersionId;
  nextTemporaryVersionId -= 4;
  return {
    firstVersionId,
    firstStableId: firstVersionId - 1,
    secondVersionId: firstVersionId - 2,
    secondStableId: firstVersionId - 3,
  };
}

function samePersistentState(before: RuntimeState, after: RuntimeState): boolean {
  return before.documentToken === after.documentToken &&
    before.revision === after.revision &&
    before.undoDepth === after.undoDepth &&
    before.redoDepth === after.redoDepth &&
    bodyIdentity(before) === bodyIdentity(after);
}

function bodyIdentity(state: RuntimeState): string {
  return JSON.stringify([...state.bodies]
    .sort((left, right) => left.id - right.id)
    .map((body) => ({
      id: body.id,
      versionId: body.versionId,
      type: body.type,
      name: body.name,
      materialId: body.materialId ?? null,
      visible: body.visible ?? null,
      hidden: body.hidden ?? null,
      locked: body.locked ?? null,
      faceIds: [...body.faceIds].sort(),
      edgeIds: [...body.edgeIds].sort(),
    })));
}
