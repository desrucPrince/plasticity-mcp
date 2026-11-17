import { requireWholeHelixTurns } from "./helix-turns.ts";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readFile, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import { NATIVE_VIEWPORT_CAPTURE } from "./viewport-capture.ts";
import { boundsExactness, CAMERA_RESTORE_TOLERANCE, exactBounds, explainXNurbsError, probeSurface, SCREENSHOT_VIEW_SOURCE, type ScreenshotViewRestored, SQUARE_ENDS_SOURCE, squareClosureProblem, SURFACE_ALIGN_CONTINUITY, SURFACE_ALIGN_COINCIDENCE_MM, SURFACE_ALIGN_DRIVE, SURFACE_ALIGN_FALLBACK_WAIT_MS, SURFACE_ALIGN_READBACK_SOURCE, SURFACE_ALIGN_READY_MS, SURFACE_ALIGN_TIMEOUTS, type AlignReadBackNative, type SurfaceAlignContinuity, readSupportBounds, supportBounds, validateScreenshotView, withScreenshotView, type ExactBoundsEvidence, type ProbeSurfaceEvidence, type ProbeSurfaceRequest, type ScreenshotViewOptions } from "./surfacing.ts";
import { nativeFunction } from "./native-function.ts";
import { classifyPickOutcome, type PickCancelResult, type PickOutcome, type PickOutcomeFacts } from "./pick-command-outcome.ts";
import { LONG_NATIVE_IMPORT_TIMEOUT_MS, NATIVE_STATE_READ_TIMEOUT_MS, PlasticityRuntime, type RevisionProbe, type RuntimeState } from "./runtime.ts";
import { add, ConstructionGeometry, cross, dot, frameFromOriginNormalX, localPointToWorld, normalize, scale, subtract } from "./construction.ts";
import {
  DatumRegistry,
  type AxisDefinition,
  type DatumAxisRef,
  type DatumPointRef,
  type DatumReference,
  type PlaneDefinition,
  type ReferenceIdentity,
  type ConstructionPlaneRef,
  type PointDefinition,
} from "./references.ts";
import { resolveAxis, resolvePlaneFrame, resolvePoint, type Resolution } from "./semantic.ts";
import { degreesToRadians, millimetersToMeters } from "./units.ts";
import { calculateConeDevelopment, planConeDevelopmentCurves } from "./cone-development.ts";
import { quaternionFromXyzDegrees, type QuaternionXyzw } from "./print-orientation.ts";
import { countActiveCurveSpans } from "./curve-span-count.ts";
import {
  inspectRectangularMember,
  type MemberEvidence,
  type MemberRequest,
} from "./member-geometry.ts";
import {
  inspectPlanarSection,
  type SectionEvidence,
  type SectionRequest,
} from "./section-geometry.ts";
import {
  inspectArbitrarySection,
  type ArbitrarySectionEvidence,
  type ArbitrarySectionRequest,
} from "./arbitrary-section.ts";
import {
  checkBodyInterference,
  type BodyInterferenceEvidence,
  type BodyInterferencePair,
} from "./interference.ts";
import {
  measureSolidProperties,
  type SolidPropertiesEvidence,
} from "./solid-properties.ts";
import {
  measureFaceProperties,
  type FacePropertiesEvidence,
} from "./face-properties.ts";
import {
  inspectSingleFastenerPlate,
  type FastenerPlateEvidence,
  type FastenerPlateRequest,
} from "./fastener-geometry.ts";
import {
  inspectIntegralRectangularPlate,
  type IntegralPlateEvidence,
  type IntegralPlateRequest,
} from "./integral-plate-geometry.ts";
import {
  inspectFastenerGroupGeometry,
  type FastenerGroupGeometryEvidence,
  type FastenerGroupGeometryRequest,
} from "./fastener-group-geometry.ts";
import {
  inspectFastenerGroupLayout,
  type FastenerGroupLayoutEvidence,
  type FastenerGroupLayoutRequest,
} from "./fastener-group-layout.ts";
import {
  measureFastenerGripStack,
  measureLinearEdges,
  measureNonparallelPlanarPolygonFaceClearance,
  measureParallelPlanarFaceClearance,
  measurePlanarFaces,
  measurePointDistance,
  measurePointToCircularEdge,
  measurePointToLinearEdge,
  measurePointToPlanarFace,
  measurePointToSampledCurveEdge,
  type EdgeReference,
  type NativeSampledWireCurveSegment,
  type NativeWireCircularSegment,
  type FastenerGripLayerReference,
  type FaceReference,
  type MeasurementPointReference,
  type WireSegmentReference,
} from "./measurements.ts";
import { MAX_REFERENCE_THREE_MF_ARCHIVE_BYTES, MAX_THREE_MF_ARCHIVE_BYTES, validateReferenceThreeMfArchive, validateThreeMfArchive, type ThreeMfValidation } from "./three-mf.ts";
import { MAX_OBJ_BYTES, validateObj, type ObjValidation } from "./obj.ts";
import { serializeHiddenLineSvg, type HiddenLineProjectionSegment } from "./hiddenline-svg.ts";
import { tessellateCurve } from "./svg-tessellation.ts";
import { analyzeSvgEllipseArc, fitSvgConicEllipse, fitSvgEllipse } from "./svg-ellipse.ts";
import { evaluateSvgCubicBezier, fitSvgCubicBezier, isExactSvgCubicPolynomialDegree, svgCubicBezierBoundsPoints } from "./svg-cubic.ts";

type Vector3 = [number, number, number];
type Vector2 = [number, number];
export type NativeImportUnit = "millimeter" | "centimeter" | "meter" | "inch" | "foot";
export type ReferenceMeshUnit = NativeImportUnit;
export type TopologyMeasurementPointReference = Exclude<MeasurementPointReference, { type: "coordinates" }>;

export interface PlasticitySelection {
  documentToken: string;
  revision: string;
  bodyIds: number[];
  curveIds: number[];
  instanceIds: number[];
  referenceMeshIds: number[];
  groupIds: number[];
  faces: Array<{ bodyId: number | null; faceId: string }>;
  edges: Array<{ bodyId: number | null; edgeId: string }>;
  regionIds: string[];
  curveControlPoints: CurveControlPointReference[];
}

export interface CurveFragmentDescriptor {
  id: string;
  bodyId: number;
  ancestorVersionId: number;
  fragmentViewId: number;
  entityId: number;
  measurementSource: "native-brep";
  startMm: Vector3;
  midpointMm: Vector3;
  endMm: Vector3;
  lengthMm: number;
}

export interface CurveEndpointDescriptor {
  id: string;
  bodyId: number;
  bodyVersionId: number;
  entityId: number;
  measurementSource: "native-brep";
  positionMm: Vector3;
}

export interface CurveVertexDescriptor {
  id: string;
  bodyId: number;
  bodyVersionId: number;
  vertexId: number;
  viewVersionId: string;
  measurementSource: "native-brep";
  positionMm: Vector3;
  endpoint: boolean;
  adjacentEdgeEntityIds: number[];
}

export interface CurveDirectionDescriptor {
  id: number;
  versionId: number;
  measurementSource: "native-brep";
  closed: boolean;
  segments: Array<{
    entityId: number;
    curveType: string;
    startMm: Vector3;
    endMm: Vector3;
    startTangent: Vector3;
    endTangent: Vector3;
    lengthMm: number;
    circleGeometry?: {
      centerMm: Vector3;
      radiusMm: number;
      normal: Vector3;
      reference: Vector3;
      startMm: Vector3;
      midpointMm: Vector3;
      endMm: Vector3;
    };
  }>;
}

export interface CurveSegmentReference {
  bodyId: number;
  segmentEntityId: number;
}

export type CurvatureEdgeReference = EdgeReference | CurveSegmentReference;

export type FaceDraftClassification = "positive" | "negative" | "neutral" | "mixed";

export interface FaceDraftAnalysis {
  face: FaceReference;
  bodyVersionId: number;
  surfaceType: string;
  measurementSource: "native-brep-face-normal-grid";
  classification: FaceDraftClassification;
  sampleCount: number;
  sampleCounts: { positive: number; negative: number; neutral: number };
  minimumSignedDraft: { valueDeg: number; positionMm: Vector3; normal: Vector3 };
  maximumSignedDraft: { valueDeg: number; positionMm: Vector3; normal: Vector3 };
  minimumAbsoluteDraftDeg: number;
  maximumAbsoluteDraftDeg: number;
}

interface NativeFaceDraftSamples {
  face: FaceReference;
  bodyVersionId: number;
  surfaceType: string;
  samples: Array<{ positionMm: Vector3; normal: Vector3 }>;
}

export interface CurveSegmentEndpointReference extends CurveSegmentReference {
  at: "start" | "end";
}

export interface CurveSegmentSampleReference extends CurveSegmentReference {
  normalizedParameter: number;
}

export interface CurveSegmentSampleDescriptor {
  reference: CurveSegmentSampleReference;
  bodyVersionId: number;
  curveType: string;
  measurementSource: "native-brep";
  positionMm: Vector3;
  tangent: Vector3;
}

export interface ShellEdgeEndpointReference extends EdgeReference {
  vertexId: number;
}

export interface CurveStructureDescriptor {
  id: number;
  versionId: number;
  measurementSource: "native-brep";
  segments: Array<{
    entityId: number;
    curveType: string;
    lengthMm: number;
    degree: number | null;
    controlPointCount: number | null;
    spanCount: number | null;
    activeSpanCount: number | null;
    distinctKnotCount: number | null;
    knots: Array<{ normalizedParameter: number; multiplicity: number; withinSegment: boolean }> | null;
    rational: boolean | null;
    periodic: boolean | null;
    circle: { centerMm: Vector3; radiusMm: number; normal: Vector3 } | null;
  }>;
}

export interface SurfaceStructureDescriptor {
  bodyId: number;
  faceId: string;
  bodyVersionId: number;
  measurementSource: "native-brep";
  surfaceType: string;
  trimmed: boolean;
  faceParameterBounds: { uMin: number; uMax: number; vMin: number; vMax: number };
  naturalParameterBounds: { uMin: number; uMax: number; vMin: number; vMax: number } | null;
  naturalParameterBoundsSource?: "surface" | "untrimmed-face" | null;
  bSpline: {
    uDegree: number;
    vDegree: number;
    uSpanCount: number;
    vSpanCount: number;
    uControlPointCount: number;
    vControlPointCount: number;
    rational: boolean;
  } | null;
}

export interface CurvePlanarityDescriptor {
  id: number;
  versionId: number;
  measurementSource: "native-brep";
  planar: boolean;
  plane: { originMm: Vector3; normal: Vector3 } | null;
}

export type CurveControlPointReference =
  | { bodyId: number; kind: "vertex"; pointId: number }
  | { bodyId: number; kind: "control-point"; pointId: number };

export interface CurveControlPointDescriptor {
  id: number;
  versionId: number;
  positionSource: "native-control-handle";
  boundaryVertices: Array<{
    reference: { bodyId: number; kind: "vertex"; pointId: number };
    versionId: string;
    positionMm: Vector3;
    slideDirections: { positiveU: Vector3; negativeU: Vector3 } | null;
  }>;
  interiorControlPoints: Array<{
    reference: { bodyId: number; kind: "control-point"; pointId: number };
    versionId: string;
    positionMm: Vector3;
    slideDirections: { positiveU: Vector3; negativeU: Vector3 } | null;
  }>;
}

export type RebuildCurveOptions =
  | { method: "tolerance"; toleranceMm: number; preserveParameterization?: boolean; preserveChain?: boolean; keepCorners?: boolean }
  | { method: "control-points"; pointCount: number; preserveParameterization?: boolean; preserveChain?: boolean; keepCorners?: boolean }
  | { method: "degree-spans"; degree: number; spans: number; preserveParameterization?: boolean; preserveChain?: boolean; keepCorners?: boolean };

export interface CurveIntersectionDescriptor {
  id: string;
  bodyIds: [number, number];
  bodyVersionIds: [number, number];
  edgeEntityIds: [number, number];
  measurementSource: "native-brep";
  positionMm: Vector3;
}

export interface BodyValidationDescriptor {
  id: number;
  versionId: number;
  type: string;
  name: string | null;
  measurementSource: "native-brep";
  faceCount: number;
  edgeCount: number;
  boundaryEdgeIds: string[];
  closed: boolean;
  nativeCheckCodes: number[];
  nativeValid: boolean;
  printableSolid: boolean;
}

export type AppearanceMaterialInput =
  | { materialId: number }
  | { name: string; colorHex: string; roughness: number; metalness: number; opacity: number };

export interface VertexReference {
  bodyId: number;
  vertexId: number;
}

export interface CreateTextInput {
  text: string;
  fontSizeMm: number;
  originMm: Vector3 | Vector2;
  font?: "inter";
  name?: string;
  revision?: string;
  normal?: Vector3;
  xDirection?: Vector3;
  plane?: ReferenceIdentity;
  angleDegrees?: number;
}

const findView = `const find = id => {
  for (const [versionId, item] of nativeApi.geo.geometryModel) {
    if (nativeApi.db.lookupStableId(versionId) === id) return item.view;
  }
  throw new Error('Unknown body ID: ' + id);
};`;

const findFaceViews = `${findView}
const selectedFaces = args.faces.map(reference => {
  const view = find(reference.bodyId);
  const index = view.high.faces.versionIds.indexOf(reference.faceId);
  if (index < 0) throw new Error('Stale or unknown face: ' + reference.bodyId + ':' + reference.faceId);
  return view.high.faces.get(index);
});`;

const findEdgeViews = `${findView}
const view = find(args.edges[0].bodyId);
const selectedEdges = args.edges.map(reference => {
  if (reference.bodyId !== args.edges[0].bodyId) throw new Error('Native edge edit requires one body');
  const index = view.high.edges.versionIds.indexOf(reference.edgeId);
  if (index < 0) throw new Error('Stale or unknown edge: ' + reference.bodyId + ':' + reference.edgeId);
  return view.high.edges.get(index);
});`;

const findCurveControlPoints = `const views = new Map();
for (const bodyId of new Set(args.points.map(point => point.bodyId))) {
  for (const [versionId, item] of nativeApi.geo.geometryModel) {
    if (nativeApi.db.lookupStableId(versionId) === bodyId && item.view?.constructor?.name === 'Wire') {
      views.set(bodyId, item.view);
      break;
    }
  }
  if (!views.has(bodyId)) throw new Error('Unknown current Wire ID: ' + bodyId);
}
const vertices = [];
const cvs = [];
for (const point of args.points) {
  const view = views.get(point.bodyId);
  const collection = point.kind === 'vertex' ? view.vertices : view.cvs;
  const found = Array.from(collection ?? []).find(candidate => Number(candidate.id) === point.pointId);
  if (!found) throw new Error('Unknown current curve control point: ' + point.bodyId + ':' + point.kind + ':' + point.pointId);
  (point.kind === 'vertex' ? vertices : cvs).push(found);
}`;

const findWritableInstanceEmpty = `const find = id => {
  const store = nativeApi.db.empties.write;
  const original = store.id2empty.get(id);
  if (original?.constructor?.name !== 'InstanceEmpty') throw new Error('Unknown native instance ID: ' + id);
  const copy = original.clone(false);
  copy.versionId = original.versionId;
  copy.targetKey = original.targetKey;
  copy.kind = original.kind;
  store.id2empty.set(id, copy);
  return copy;
};`;

const commandStart = (commandName: string, factoryName = "Factory") => `
  if (this.executor.isBusy) throw new Error('Plasticity is busy');
  const editor = this;
  let failure;
  const command = new this.commands.${commandName}(this);
  command.remember = false;
  command.execute = async function () {
    try {
      const factory = new ${factoryName}(editor).resource(this);`;

const FILLET_SHAPE_G2 = 22202;

const commandEnd = `
      return await factory.commit();
    } catch (error) {
      failure = error;
      throw error;
    }
  };
  await this.exec(command);
  if (failure) throw failure;`;

// Equal-distance chamfer (FilletShellFactory with a negative distance). Besides committing it returns what
// chamferFaceCheck needs: the edges the factory chamfers (extendedEdges: the selection plus its tangent chain, read
// before commit) and every face's topology identity (entityId) before and after. A face keeps its entityId when the
// chamfer only trims it, so an entityId the body did not have before marks a face the chamfer made.
export const CHAMFER_SOURCE = nativeFunction`async function (Factory, args) {
  ${findView}
  const faceIdentity = item => { const faces = item.high.faces; return Array.from(faces.versionIds, (faceId, index) => [String(faceId), Number(faces.get(index)?.entityId)]); };
  const evidence = { chain: null, chainError: null, facesBefore: faceIdentity(find(args.id)), facesAfter: [] };
  ${commandStart("FilletShellCommand")}
      const view = find(args.id);
      const edges = view.high.edges;
      factory.shell = view;
      factory.edges = args.edgeIds.map(id => {
        const index = edges.versionIds.indexOf(id);
        if (index < 0) throw new Error('Stale or unknown edge: ' + id);
        return edges.get(index);
      });
      factory.distance = args.distance;
      try { evidence.chain = Array.from(factory.extendedEdges ?? [], edge => String(edge.versionId)); } catch (error) { evidence.chainError = String(error?.message ?? error); }
  ${commandEnd}
  evidence.facesAfter = faceIdentity(find(args.id));
  return evidence;
}`;

// ExtensionShape members the MCP exposes (probes-2026-11 FINDINGS gap 3). Arc fails on NURBS sheets and
// bias, Bbox have no measurable effect, so they stay out.
export const SHEET_EXTENSION_SHAPES = { linear: "Linear", soft: "Soft", reflective: "Reflective", natural: "Natural" } as const;
export type SheetExtensionShape = keyof typeof SHEET_EXTENSION_SHAPES;

// SweepGuideMethod members (FINDINGS gap 1); resolved by name from the bound enum.
export const SWEEP_GUIDE_METHODS = { point: "Point", chord: "Chord", curve: "Curve" } as const;
export type SweepGuideMethodName = keyof typeof SWEEP_GUIDE_METHODS;

// ContinuityType members the MCP exposes for X-sided patch boundary edges (FINDINGS gap 2); resolved by name
// from the bound enum. G1/G2 bulge the patch off the rim and G0 stays flat. C1-C3, G3 and Free stay out.
export const XSIDED_CONTINUITY = { g0: "G0", g1: "G1", g2: "G2" } as const;
// The XNurbs dialog's Quality buttons (Auto, High, Max) set XNurbsFactory.enforceTolerance to these EnforceToleranceType members.
export const XSIDED_QUALITY = { auto: "Automatic", high: "High", max: "Max" } as const;
export type XSidedContinuity = keyof typeof XSIDED_CONTINUITY;

export interface FaceControlPoint {
  /**
   * The ShellCV versionId ("<body version>c<index>", e.g. "54c10"). Plasticity's own per-body index (ShellCV id)
   * renumbers when points of another face are shown or hidden (discovery/probes-2026-11-followups/
   * probe-facepoints-order.json), so a stale index could name a different point. The versionId changes with every
   * edit of the body (show, hide, move), so a stale cvId is unknown instead of wrong.
   */
  cvId: string;
  /** Current ID of the face the point belongs to (face IDs change with every edit of the body, show included). */
  faceId: string;
  /** Index of the point in that face's B-Surface control grid (kernel order). */
  index: number;
  positionMm: Vector3;
}

export interface FaceControlPointFace {
  /** The face ID the caller gave. */
  requestedFaceId: string;
  /** The same face's ID after the call. */
  faceId: string;
  controlPointCount: number;
}

/** Shape of a face's B-Surface control grid: u x v points in kernel order; a point's index is uIndex * v + vIndex (GetInfo().vertices order). */
export interface FaceControlGridShape {
  faceId: string;
  u: number;
  v: number;
}

interface FaceControlPointLayout {
  /** [faceId, kernel entity id] for every face of the body view. */
  entities: Array<[string, number | null]>;
  blocks: Array<{ faceId: string; entityId: number | null; start: number; count: number }>;
  /** Points with their unrounded position (rawMm), for read-back comparisons; publicPoint() strips it. */
  points: Array<FaceControlPoint & { rawMm: Vector3 }>;
  /** Control grid shape per BSurf face, when the kernel grids were read. */
  grids?: Array<{ faceId: string; u: number; v: number }>;
  /** Groups of BSurf faces whose control grids are identical (a face split on one surface), when requested. */
  duplicates?: string[][];
  /** Tolerant reads only: why the shown points could not be attributed to faces (blocks and points are then empty). */
  unattributed?: string | null;
  /** Number of shown control points of the body. */
  cvCount?: number;
  /** When requested: the kernel control points of BSurf faces whose points are not shown (raw and weight-projected). */
  hiddenPoints?: Array<{ faceId: string; index: number; rawMm: Vector3; projectedMm: Vector3 }>;
}

const publicPoint = ({ rawMm: _raw, ...point }: FaceControlPoint & { rawMm?: Vector3 }): FaceControlPoint => point;

/**
 * Read-back tolerance for one coordinate of a face control point, in mm. Native positions are float32 (machine
 * epsilon about 1.2e-7), so a correct move can miss by a few units in the last place: 1e-3 mm near the origin,
 * |coordinate| x 2e-7 x 4 farther out (0.032 mm at 40 m, 0.096 mm at 120 m).
 */
export function faceControlPointTolerance(coordinateMm: number): number {
  return Math.max(1e-3, Math.abs(coordinateMm) * 2e-7 * 4);
}

const undoStepsText = (steps: number) => steps === 1 ? "one Undo step" : `${steps} Undo steps`;

// Reads view.high.cvs and attributes each ShellCV to its face. ShellCV carries no face link (keys: parentItem, id,
// layers, position, versionId). On 26.1.3 the shown points are laid out face by face in kernel face order, each
// block in the order of the face's BSurf GetInfo().vertices (probe-facepoints-order.json). Each block is matched
// against those kernel vertices, so the attribution never relies on the order alone; a block no face matches, or
// that two faces match, is an error. A one-face body needs no kernel lookup. Native positions are float32;
// rounding to a micrometre hides the float noise. `this` is the editor; args.bodyId.
const FACE_CONTROL_POINT_LAYOUT = `
  let item = null;
  for (const [versionId, candidate] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(versionId) === args.bodyId) { item = candidate; break; }
  if (!item) throw new Error('Unknown body ID: ' + args.bodyId);
  const view = item.view;
  const cvs = Array.from(view.high?.cvs ?? []);
  const faceViews = view.high?.faces;
  const faceIds = Array.from(faceViews?.versionIds ?? []).map(String);
  const entities = faceIds.map((id, index) => [id, faceViews.get(index)?.entityId ?? null]);
  const faceOfEntity = new Map(entities.map(([id, entity]) => [entity, id]));
  const position = cv => [cv.position.x, cv.position.y, cv.position.z];
  const near = (actual, expected) => Math.abs(actual - expected) <= 1e-6 + 1e-6 * Math.abs(expected);
  // The BSurf control grids of the body's faces, in kernel face order. Read only when needed.
  let gridCache = null;
  const kernelGrids = (required) => {
    if (gridCache) return gridCache;
    const kernelFaces = item.model?.GetFaces?.();
    if (!kernelFaces) {
      if (required) throw new Error('Native kernel faces are unavailable for body ' + args.bodyId);
      return [];
    }
    const grids = [];
    for (let index = 0; index < kernelFaces.Size(); index += 1) {
      const face = kernelFaces.Get(index);
      const faceId = faceOfEntity.get(face.Id());
      if (faceId === undefined) continue;
      let info = null;
      try { const surface = face.GetSurface()?.surface; if (surface?.constructor?.name === 'BSurf') info = surface.GetInfo(); } catch { info = null; }
      const u = Number(info?.uVertices), v = Number(info?.vVertices);
      const count = u * v;
      const vertices = info?.vertices;
      if (!vertices || !Number.isInteger(count) || count <= 0 || (vertices.length !== count * 3 && vertices.length !== count * 4)) continue;
      grids.push({ faceId, entityId: face.Id(), u, v, count, stride: vertices.length / count, vertices });
    }
    gridCache = grids;
    return grids;
  };
  const blocks = [];
  let unattributed = null;
  if (cvs.length > 0 && faceIds.length === 1) {
    blocks.push({ faceId: faceIds[0], entityId: entities[0][1], start: 0, count: cvs.length });
  } else if (cvs.length > 0) {
    const grids = kernelGrids(true);
    const matches = (grid, start) => {
      if (start + grid.count > cvs.length) return false;
      for (let offset = 0; offset < grid.count; offset += 1) {
        const point = position(cvs[start + offset]);
        const base = offset * grid.stride;
        const weight = grid.stride === 4 ? grid.vertices[base + 3] : 1;
        const raw = point.every((value, axis) => near(value, grid.vertices[base + axis]));
        const projected = weight !== 0 && point.every((value, axis) => near(value, grid.vertices[base + axis] / weight));
        if (!raw && !projected) return false;
      }
      return true;
    };
    const used = new Set();
    let start = 0;
    while (start < cvs.length) {
      const candidates = grids.filter(grid => !used.has(grid) && matches(grid, start));
      if (candidates.length !== 1) {
        const reason = candidates.length > 1
          ? 'Face control points of body ' + args.bodyId + ' are ambiguous from index ' + start + ': faces ' + candidates.map(grid => grid.faceId).join(', ') + ' match'
          : 'Face control points of body ' + args.bodyId + ' from index ' + start + ' match no face control grid';
        // A tolerant read (hide) reports the reason instead of failing: hiding by face needs no attribution.
        if (!args.tolerant) throw new Error(reason);
        unattributed = reason;
        blocks.length = 0;
        break;
      }
      const grid = candidates[0];
      used.add(grid);
      blocks.push({ faceId: grid.faceId, entityId: grid.entityId, start, count: grid.count });
      start += grid.count;
    }
  }
  const points = blocks.flatMap(block => cvs.slice(block.start, block.start + block.count).map((cv, index) => {
    if ((typeof cv.versionId !== 'string' && typeof cv.versionId !== 'number') || String(cv.versionId) === '') throw new Error('Face control point ' + cv.id + ' of body ' + args.bodyId + ' has no versionId');
    return {
      cvId: String(cv.versionId), faceId: block.faceId, index,
      positionMm: position(cv).map(value => Math.round(value * 1000 * 1000) / 1000),
      rawMm: position(cv).map(value => value * 1000),
    };
  }));
  if (new Set(points.map(point => point.cvId)).size !== points.length) throw new Error('Face control point versionIds of body ' + args.bodyId + ' are not unique');
  const grids = kernelGrids(false);
  // Faces split on one B-Surface carry identical grids: their shown points could never be told apart.
  let duplicates = undefined;
  if (args.duplicates) {
    duplicates = [];
    const seen = new Set();
    for (const grid of grids) {
      if (seen.has(grid)) continue;
      const twins = grids.filter(other => other !== grid && !seen.has(other) && other.count === grid.count && other.stride === grid.stride
        && other.vertices.every((value, index) => near(value, grid.vertices[index])));
      if (twins.length === 0) continue;
      for (const twin of twins) seen.add(twin);
      seen.add(grid);
      duplicates.push([grid.faceId, ...twins.map(twin => twin.faceId)]);
    }
  }
  // Kernel points of faces whose points are not shown: a shared-edge twin of a moved point may sit there.
  let hiddenPoints = undefined;
  if (args.hiddenGrids) {
    const shownFaces = new Set(blocks.map(block => block.faceId));
    hiddenPoints = [];
    for (const grid of grids) {
      if (shownFaces.has(grid.faceId)) continue;
      for (let index = 0; index < grid.count; index += 1) {
        const base = index * grid.stride;
        const weight = grid.stride === 4 ? grid.vertices[base + 3] : 1;
        const raw = [0, 1, 2].map(axis => grid.vertices[base + axis] * 1000);
        hiddenPoints.push({ faceId: grid.faceId, index, rawMm: raw, projectedMm: weight ? raw.map(value => value / weight) : raw });
      }
    }
  }
  return {
    entities, blocks, points, cvCount: cvs.length, unattributed,
    grids: grids.map(grid => ({ faceId: grid.faceId, u: grid.u, v: grid.v })),
    ...(duplicates ? { duplicates } : {}),
    ...(hiddenPoints ? { hiddenPoints } : {}),
  };`;

// Maps the caller's face IDs to the same faces in a later layout: through the kernel entity ids the edit returned,
// else through the earlier layout's entity map.
function mapFaceIds(before: FaceControlPointLayout, after: FaceControlPointLayout, faceIds: string[], entities?: Array<number | null>): Map<string, string> {
  const entityOf = new Map(before.entities);
  const faceOfEntity = new Map(after.entities.map(([id, entity]) => [entity, id]));
  return new Map(faceIds.map((id, index) => {
    const entity = entities?.[index] !== undefined ? entities[index]! : entityOf.get(id) ?? null;
    const current = faceOfEntity.get(entity);
    if (current === undefined) throw new Error(`Face ${id} is missing after the control point edit; inspect the body`);
    return [id, current];
  }));
}

function faceControlPointSelection(layout: FaceControlPointLayout, faceIds: string[], current: Map<string, string>): { faces: FaceControlPointFace[]; controlPoints: FaceControlPoint[] } {
  const wanted = new Set(faceIds.map((id) => current.get(id)!));
  return {
    faces: faceIds.map((id) => {
      const faceId = current.get(id)!;
      return { requestedFaceId: id, faceId, controlPointCount: layout.blocks.find((block) => block.faceId === faceId)?.count ?? 0 };
    }),
    controlPoints: layout.points.filter((point) => wanted.has(point.faceId)).map(publicPoint),
  };
}

// Resolves a native enum member by name. A Plasticity build that lacks the member fails loudly instead of
// handing the factory undefined.
const enumMember = `const enumMember = (enumeration, enumerationName, member) => {
  const value = enumeration?.[member];
  if (value === undefined) throw new Error('Plasticity build has no ' + enumerationName + '.' + member);
  return value;
};`;

// Guide rails for a sweep (FINDINGS gap 1): Wire guides plus an optional SweepGuideMethod resolved by name.
// The guide views and the method are checked before anything is assigned to the factory.
const sweepGuides = `
      if (args.guideIds !== undefined) {
        ${enumMember}
        const guides = args.guideIds.map(find);
        if (guides.some(guide => guide.constructor.name !== 'Wire')) throw new Error('Sweep guides must be Wires');
        const guideMethod = args.guideMethodName !== undefined ? enumMember(SweepGuideMethod, 'SweepGuideMethod', args.guideMethodName) : undefined;
        factory.guides = guides;
        if (guideMethod !== undefined) factory.guideMethod = guideMethod;
      }`;

// ---- Viewport-pick commands (discovery/probes-2026-11-pick/FINDINGS.md)
// Some commands read the selection click point (editor.selection.hits) and then wait for their own space dialog.
// runPickCommand seeds the selection and the hits, runs the real command, drives its dialog and always cleans up.

export interface PickItemReference {
  kind: "body" | "face" | "edge";
  bodyId: number;
  /** Face or edge id; not used for kind "body". */
  id?: string;
}

export interface PickHitSeed {
  item: PickItemReference;
  pointM: Vector3;
  normalM?: Vector3;
  /**
   * Face hits only: replace pointM with the kernel's own point on the face (Face.GetAnyPointOn). A face midpoint
   * can lie off the face (a washer's midpoint sits in its hole), and a hit off the face gives "no effect" in
   * single-face Dimension mode (discovery/probes-2026-11-followups/probe-washer.json).
   */
  onFace?: boolean;
}

export interface PickCommandTimeouts {
  /** Wait for the command's dialog to appear. */
  dialogMs: number;
  /** Shared deadline for the drive step and for the command to settle after it. */
  finishMs: number;
  /** Wait for executor.cancelActiveCommand() to settle the command. After finish() it also bounds the settle window. */
  cancelMs: number;
  /** Late-commit settle window after a cancel that followed finish(); defaults to PICK_COMMAND_SETTLE_MS. */
  settleMs?: number;
}

export const PICK_COMMAND_TIMEOUTS: Readonly<PickCommandTimeouts> = Object.freeze({ dialogMs: 3_000, finishMs: 8_000, cancelMs: 3_000 });

// After finish() was called, a cancelled command is watched this long (and never past the cancelMs budget) for a
// commit that lands late. Live on 26.1.3 a commit lands about 9 ms after finish(), and a cancel after finish() always
// discarded it (discovery/probes-2026-11-followups/probe-late-commit.json). That is one build, so a timeout after
// finish() stays uncertain unless the commit is seen to land in this window.
export const PICK_COMMAND_SETTLE_MS = 250;

// The CDP call outlives every internal wait by this margin, so a Node-side timeout cannot leave a command awaiting.
export const PICK_COMMAND_CDP_MARGIN_MS = 6_000;

export function pickCommandCdpTimeoutMs(timeouts: PickCommandTimeouts): number {
  return timeouts.dialogMs + timeouts.finishMs + timeouts.cancelMs + PICK_COMMAND_CDP_MARGIN_MS;
}

export interface PickCommandSpec {
  /** Native command binding, e.g. DimensionDistanceCommand. */
  command: string;
  /** Native dialog class binding the command opens, e.g. DimensionDistanceSpaceDialog. */
  dialog: string;
  /** Items to select, in order. */
  select: PickItemReference[];
  /** Selection click points to record, in meters. */
  hits: PickHitSeed[];
  /** Renderer source of the drive step: the body of `async (dialog, driveArgs) => result`. It must finish the dialog. */
  drive: string;
  driveArgs?: unknown;
  /** Error message when the command rejects before it opens its dialog (for example "Operation has no effect"). */
  rejectedMessage: string;
  /** Short name for error messages. */
  label: string;
  timeouts?: PickCommandTimeouts;
  /**
   * The caller's read-back after the native call: whether the edited body changed and, for a one-step commit after
   * finish(), the geometry check. Without it the helper compares the selected bodies before and after the call and
   * treats a one-step commit as unverified (undetermined).
   */
  readBack?: (run: PickCommandRun<unknown>) => Promise<PickReadBack>;
  /** A rejected-unchanged run the caller turns into a result (the equal-distance no-op) instead of an error. */
  acceptUnchanged?: (run: PickCommandRun<unknown>) => boolean;
  /** More native bindings the drive step uses by name (e.g. ContinuityType). Default none: the source and bindings are unchanged. */
  extraBindings?: string[];
  /** The dialog is a DOM element, not a scene object (Surface Align's AlignEdgeDialog): also search the document for it. */
  domDialog?: boolean;
  /** Never cancel the command while its state is not Awaiting (it is computing); leave it running and report undetermined. */
  cancelOnlyWhenAwaiting?: boolean;
  /** Put the user's selection back after the command, on success and on failure. */
  restoreSelection?: boolean;
}

export interface PickReadBack {
  bodyChanged: boolean | null;
  geometry: "pass" | "ambiguous" | "fail" | null;
  /** The document revision after the call. */
  revision: string;
  /** What the edit touches, for messages ("body 5"). */
  subject: string;
  /** The read-back result in words, for the one-step cases. */
  readback: string;
  /** "Plasticity made no change: ...", for the no-step cases. */
  noChange: string;
}

export interface PickCommandEnd {
  activeCommand: string | null;
  selectedCount: number | null;
  hitCount: number | null;
  spaceInputFocused: boolean;
}

// The native record. It reports facts only; classifyPickOutcome (pick-command-outcome.ts) decides what they mean.
interface PickCommandNativeResult {
  /** What happened mechanically (not a verdict): "committed" = execute() resolved after the dialog. */
  outcome: "committed" | "rejected" | "cancelled" | "cancel-failed" | "failed" | "undetermined";
  phase: "dialog" | "drive" | "finish" | "chained" | "unexpected" | null;
  /** The drive step's or the helper's own error (not the execute() error, which is execError). */
  error: string | null;
  drive: unknown;
  /** The drive step threw (as opposed to not returning in time). */
  driveThrew: boolean;
  /** Undo depth change at the last measurement (after the settle window when one ran). */
  undoDelta: number;
  /** Undo depth change when the command flow ended, before the settle window. */
  undoDeltaAtReturn?: number;
  /** Our exec() promise settled. */
  settled: boolean;
  /** Our command (by identity) is still the executor's active command. */
  ourActive: boolean;
  /** Name of a different command that is active at the end; it is never cancelled. */
  foreignActive: string | null;
  /** The drive step called dialog.finish(): a cancel after this point cannot prove the commit was discarded. */
  finishCalled?: boolean;
  /** finish() was called after the drive step returned; the call was refused. */
  lateFinish?: boolean;
  /** The dialog's finish() threw after it started. */
  finishThrew?: boolean;
  /** The commit landed after a cancel, inside the settle window. */
  lateCommit?: boolean;
  /** How long the settle window ran, in ms (0 when none ran). */
  settleWaitMs?: number;
  /** The execute() error (captured in the wrapped execute(); the 26.1.3 executor swallows it), or the exec() rejection. */
  execError?: string | null;
  /** Constructor name of the execute() error, when there was one. */
  execErrorName?: string | null;
  /** Our wrapped execute() resolved. */
  executeResolved?: boolean;
  /** execError came from a later exec() rejection, not from our execute(): with executeResolved it is a chained command's. */
  execRejected?: boolean;
  /** "not-needed", "ok", "failed" (did not settle in time) or "threw". */
  cancel?: PickCancelResult;
  cancelError: string | null;
  cleanupError: string | null;
  /** The hit points seeded, in meters (the kernel's own point on the face for onFace hits). */
  hits?: Vector3[];
  end: PickCommandEnd | null;
}

/** A pick-command run as Node sees it: the validated native record plus the classifier facts it supports. */
export interface PickCommandRun<T> {
  native: PickCommandNativeResult;
  drive: T;
  /** Facts for classifyPickOutcome; bodyChanged and geometry come from the read-back. */
  facts: Omit<PickOutcomeFacts, "bodyChanged" | "geometry">;
  timeouts: PickCommandTimeouts;
}

/** What runPickCommand returns: a verified commit, or a rejected-unchanged run the caller accepted (acceptUnchanged). */
export interface PickCommandResult<T> extends PickCommandRun<T> {
  outcome: PickOutcome;
}

// Generic renderer source for runPickCommand. The drive step is spliced in as the body of an async function, so
// one source serves every pick command; everything else comes from the bindings and args.
// Lifecycle contract: once the command has started, the function never throws. Every path returns facts, and a
// cancel that throws is reported as such. The executor swallows errors from execute() and resolves exec()
// (26.1.3, discovery/probes-2026-11-pick/prove-driving-distance.json trials 9 and 11), so the error is captured
// inside the wrapped execute(), not only from an exec() rejection. cancel() only ever cancels OUR command
// (identity check); a different active command is reported, never cancelled.
// Drive contract: the drive step must call finish() before it returns (synchronously, or before its promise
// settles). Once the drive step has returned or timed out, finish() is refused and the late call is reported, so a
// commit can never start after the helper stopped watching.
// Settle window: after finish(), whenever no Undo step has landed yet, the helper watches the Undo stack for
// settleMs (never past the cancelMs budget) and measures it again, so a no-effect rejection is only reported
// after the window shows nothing landed.
function pickCommandSource(drive: string, extraBindings: string[] = []): string {
  return nativeFunction`async function (Command, Dialog, Vector3, ${extraBindings.map((name) => `${name}, `).join("")}args) {
    const editor = this;
    const executor = this.executor;
    const selection = this.selection;
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const message = error => String(error?.message ?? error);
    const commandName = command => command?.constructor?.name ?? 'unknown';
    const activeName = () => executor.active ? commandName(executor.active.command) : null;
    // isBusy is false while a command awaits its dialog, so the active command is checked too.
    if (executor.isBusy || executor.active) {
      throw new Error('Plasticity is busy' + (activeName() ? ' (' + activeName() + ' is active)' : '') + '; finish or cancel it first');
    }
    const findItem = id => {
      for (const [versionId, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(versionId) === id) return item;
      throw new Error('Unknown body ID: ' + id);
    };
    const resolveItem = reference => {
      const view = findItem(reference.bodyId).view;
      if (reference.kind === 'body') return view;
      const collection = reference.kind === 'face' ? view.high?.faces : reference.kind === 'edge' ? view.high?.edges : undefined;
      if (!collection) throw new Error('Unsupported pick item: ' + reference.kind);
      const index = collection.versionIds.indexOf(reference.id);
      if (index < 0) throw new Error('Stale or unknown ' + reference.kind + ': ' + reference.bodyId + ':' + reference.id);
      return collection.get(index);
    };
    // The kernel's own point on a face (Face.GetAnyPointOn); a face midpoint can lie in a hole.
    const unsupported = what => new Error(args.label + ' is not supported on this Plasticity build (' + what + ' is missing); nothing was changed');
    const pointOnFace = (reference, faceView) => {
      const model = findItem(reference.bodyId).model;
      if (typeof model?.GetFaces !== 'function') throw unsupported('the kernel body GetFaces');
      const faces = model.GetFaces();
      for (let index = 0; index < (faces?.Size?.() ?? 0); index += 1) {
        const face = faces.Get(index);
        if (face.Id() !== faceView.entityId) continue;
        if (typeof face.GetAnyPointOn !== 'function') throw unsupported('Face.GetAnyPointOn');
        const point = face.GetAnyPointOn()?.position;
        if (![point?.x, point?.y, point?.z].every(Number.isFinite)) break;
        return [point.x, point.y, point.z];
      }
      throw new Error('Plasticity returned no point on face ' + reference.bodyId + ':' + reference.id);
    };
    const selectItems = args.select.map(resolveItem);
    const hitSeeds = args.hits.map(hit => {
      const item = resolveItem(hit.item);
      if (hit.onFace && hit.item.kind !== 'face') throw new Error('onFace applies to face hits only');
      const pointM = hit.onFace ? pointOnFace(hit.item, item) : hit.pointM;
      return { item, pointM, point: new Vector3(pointM[0], pointM[1], pointM[2]), normal: hit.normalM ? new Vector3(hit.normalM[0], hit.normalM[1], hit.normalM[2]) : undefined };
    });
    // open() is true while the helper still waits for the drive step; a drive that outlives it must stop touching the command.
    const drive = async (dialog, driveArgs, open) => { ${drive} };
    const focusedInput = () => typeof document === 'undefined' ? null : document.querySelector('input.z-space-input-focused');
    const selectedCount = () => {
      let count = 0, known = false;
      for (const value of Object.values(selection.selected)) {
        if ((value instanceof Set || value instanceof Map) && typeof value.size === 'number') { count += value.size; known = true; }
      }
      return known ? count : null;
    };
    const clear = () => { selection.selected.removeAll(); selection.hits.clear(); };
    const undoBefore = this.history.undoStack.length;
    const undoDelta = () => this.history.undoStack.length - undoBefore;
    const result = {
      outcome: 'undetermined', phase: null, error: null, drive: null, driveThrew: false, undoDelta: 0, undoDeltaAtReturn: 0, settled: false,
      ourActive: false, foreignActive: null, cancel: 'not-needed', cancelError: null, cleanupError: null, end: null,
      finishCalled: false, lateFinish: false, finishThrew: false, lateCommit: false, settleWaitMs: 0, execError: null, execErrorName: null,
      hits: hitSeeds.map(seed => seed.pointM),
    };
    let started = false, settled = false, execError = null, execErrorName = null, command = null, finishCalled = false;
    // executeResolved: our wrapped execute() returned. execRejected: the error text came from a LATER exec() rejection, not from our execute().
    let executeResolved = false, execRejected = false;
    let driveOpen = false, lateFinish = false, finishThrew = false, cancelStart = null;
    const ourActive = () => command !== null && executor.active?.command === command;
    // Cancels OUR command only, then waits until it has settled and is no longer active. Never throws.
    // cancelOnlyWhenAwaiting (Surface Align): a command that is computing is never cancelled (a cancel mid-compute killed
    // the renderer); the helper waits up to cancelMs for it to reach Awaiting or settle, and otherwise leaves it running.
    const stateTag = value => value === null || value === undefined ? null : typeof value === 'string' ? value : (value.tag ?? value.constructor?.name ?? null);
    const cancel = async () => {
      if (cancelStart === null) cancelStart = Date.now();
      if (args.cancelOnlyWhenAwaiting && ourActive()) {
        const waitUntil = Date.now() + args.timeouts.cancelMs;
        while (ourActive() && !settled && stateTag(command?._state) !== 'Awaiting' && Date.now() < waitUntil) await sleep(10);
        if (ourActive() && !settled && stateTag(command?._state) !== 'Awaiting') {
          result.cancelError = 'not cancelled: the command was still computing (state ' + String(stateTag(command?._state)) + '); it was left to finish';
          result.cancel = 'failed';
          return false;
        }
      }
      try {
        if (ourActive()) executor.cancelActiveCommand();
      } catch (error) {
        result.cancelError = message(error);
        result.cancel = 'threw';
        return false;
      }
      const deadline = Date.now() + args.timeouts.cancelMs;
      while ((!settled || ourActive()) && Date.now() < deadline) await sleep(10);
      const ok = settled && !ourActive();
      result.cancel = ok ? 'ok' : 'failed';
      return ok;
    };
    // After finish() a cancel may race a commit that is already running: cancel OUR command and report the facts.
    // The settle window below watches for a late commit; the classifier decides what the facts mean.
    const cancelAfterFinish = async phase => {
      result.phase = phase;
      result.outcome = (await cancel()) ? 'cancelled' : 'cancel-failed';
    };
    // restoreSelection: the user's selection is saved as Plasticity's own selection memento and put back at the end. Ids
    // are "<kind>:<versionId>"; an id whose body version is no longer in the document (the rebuilt Sheet) is left out.
    const savedSelection = args.restoreSelection && typeof selection.selected.saveToMemento === 'function' ? selection.selected.saveToMemento() : null;
    const currentId = id => {
      const versionId = String(id).split(':')[1] ?? '';
      const body = Number((/^[0-9]+/.exec(versionId) ?? [])[0]);
      return Number.isInteger(body) && nativeApi.geo.geometryModel.has(body);
    };
    try {
      clear();
      for (const item of selectItems) selection.selected.add(item);
      for (const seed of hitSeeds) selection.hits.record(seed.item, seed.point, seed.normal);
      command = new Command(editor);
      command.remember = false;
      const original = command.execute.bind(command);
      // Clearing the selection before execute() returns stops the executor from chaining the default command
      // for the still-selected items (PushFace, then OffsetFace), which would keep exec() pending.
      command.execute = async function () {
        try { const value = await original(); executeResolved = true; return value; }
        catch (error) { execError = message(error); execErrorName = error?.constructor?.name ?? null; throw error; }
        finally { selection.selected.removeAll(); }
      };
      started = true;
      editor.exec(command).then(() => { settled = true; }, error => { settled = true; if (execError === null) { execError = message(error); execRejected = true; } });

      const findDialog = () => {
        let found = null;
        editor.helpers.scene.traverse(object => { if (!found && object instanceof Dialog && object.params) found = object; });
        // Opt-in: a dialog that is a connected DOM element (no prototype patch is needed to find it).
        if (!found && args.domDialog && typeof document !== 'undefined') {
          for (const element of document.querySelectorAll('*')) if (element instanceof Dialog && element.params && element.isConnected) { found = element; break; }
        }
        return found;
      };
      let dialog = null;
      const dialogDeadline = Date.now() + args.timeouts.dialogMs;
      while (!settled && Date.now() < dialogDeadline) {
        dialog = findDialog();
        if (dialog) break;
        await sleep(10);
      }
      if (!dialog) {
        if (settled) {
          result.outcome = 'rejected';
          result.error = execError ?? 'the command ended without opening its dialog';
        } else {
          result.phase = 'dialog';
          result.outcome = (await cancel()) ? 'cancelled' : 'cancel-failed';
        }
      } else {
        // Record that the drive step called finish(): from then on a commit may be running. A finish() call after
        // the drive step returned (or timed out) is refused and reported: the helper no longer watches then.
        if (typeof dialog.finish === 'function') {
          const finish = dialog.finish;
          dialog.finish = function (...finishArgs) {
            if (!driveOpen) { lateFinish = true; throw new Error('finish() was called after the drive step returned; it was refused'); }
            finishCalled = true;
            try { return finish.apply(this, finishArgs); } catch (error) { finishThrew = true; throw error; }
          };
        }
        const finishDeadline = Date.now() + args.timeouts.finishMs;
        let driveError = null, driveDone = false;
        driveOpen = true;
        let driving;
        try { driving = Promise.resolve(drive(dialog, args.driveArgs, () => driveOpen)); } catch (error) { driving = Promise.reject(error); }
        driving.then(value => { result.drive = value ?? null; driveDone = true; }, error => { driveError = message(error); driveDone = true; });
        while (!driveDone && Date.now() < finishDeadline) await sleep(10);
        driveOpen = false;
        if (driveError !== null || !driveDone) {
          result.driveThrew = driveError !== null;
          result.error = driveError ?? 'the drive step did not return';
          if (finishCalled) await cancelAfterFinish('drive');
          else {
            result.phase = 'drive';
            result.outcome = (await cancel()) ? 'cancelled' : 'cancel-failed';
          }
        } else {
          while (!settled && Date.now() < finishDeadline) await sleep(10);
          if (!settled) {
            if (finishCalled) await cancelAfterFinish('finish');
            else {
              result.phase = 'finish';
              result.outcome = (await cancel()) ? 'cancelled' : 'cancel-failed';
            }
          } else if (execError !== null) {
            result.phase = 'finish';
            result.outcome = 'failed';
            result.error = execError;
          } else {
            result.outcome = 'committed';
          }
        }
      }
    } catch (error) {
      if (!started) throw error;
      driveOpen = false;
      result.error = message(error);
      result.phase = 'unexpected';
      if (settled && !ourActive()) result.outcome = 'failed';
      else result.outcome = (await cancel()) ? 'failed' : 'cancel-failed';
    } finally {
      driveOpen = false;
      try { clear(); focusedInput()?.blur?.(); } catch (error) { result.cleanupError = message(error); }
      if (savedSelection && !ourActive()) {
        try {
          const ids = [...(savedSelection.ids ?? [])];
          const kept = ids.filter(currentId);
          let memento = savedSelection;
          if (kept.length !== ids.length) {
            memento = Object.create(Object.getPrototypeOf(savedSelection));
            Object.assign(memento, savedSelection, { ids: savedSelection.ids instanceof Map ? new Map([...savedSelection.ids].filter(([id]) => currentId(id))) : new Set(kept) });
          }
          selection.selected.restoreFromMemento(memento);
          result.selectionRestored = kept.length;
          if (kept.length !== ids.length) result.selectionDropped = ids.length - kept.length;
        } catch (error) { result.selectionRestoreError = message(error); }
      }
    }
    try {
      result.undoDeltaAtReturn = undoDelta();
      // Settle window: once finish() was called and no Undo step has landed, watch the Undo stack (never past the
      // cancelMs budget, counted from the cancel when there was one) before the last measurement.
      if (finishCalled && undoDelta() === 0) {
        const windowStart = Date.now();
        const windowEnd = Math.min(windowStart + args.settleMs, (cancelStart ?? windowStart) + args.timeouts.cancelMs);
        while (!(undoDelta() !== 0 && settled && !ourActive()) && Date.now() < windowEnd) await sleep(10);
        result.settleWaitMs = Date.now() - windowStart;
      }
      // A commit that is in the Undo history although the helper had to cancel: it landed after (or during) the cancel.
      result.lateCommit = finishCalled && cancelStart !== null && undoDelta() !== 0;
    } catch (error) {
      result.cleanupError = (result.cleanupError ? result.cleanupError + '; ' : '') + message(error);
    }
    try {
      result.undoDelta = undoDelta();
      result.finishCalled = finishCalled;
      result.lateFinish = lateFinish;
      result.finishThrew = finishThrew;
      result.execError = execError;
      result.execErrorName = execErrorName;
      result.executeResolved = executeResolved;
      result.execRejected = execRejected;
      result.settled = settled;
      result.ourActive = ourActive();
      const active = executor.active;
      result.foreignActive = active && active.command !== command ? commandName(active.command) : null;
      if (result.outcome === 'committed' && result.foreignActive !== null) result.phase = 'chained';
      result.end = { activeCommand: activeName(), selectedCount: selectedCount(), hitCount: selection.hits.hits?.size ?? null, spaceInputFocused: Boolean(focusedInput()) };
    } catch (error) {
      result.cleanupError = (result.cleanupError ? result.cleanupError + '; ' : '') + message(error);
    }
    return result;
  }`;
}

const PICK_RECONCILE = "the result is uncertain. Call plasticity_reconcile before any other edit";
const PICK_NATIVE_OUTCOMES = new Set(["committed", "rejected", "cancelled", "cancel-failed", "failed", "undetermined"]);

// Facts for classifyPickOutcome from a native record. A record without the facts this source reports (an older or
// hand-made record) is malformed: it is never trusted for an "unchanged" claim.
function pickCommandFacts(native: PickCommandNativeResult): Omit<PickOutcomeFacts, "bodyChanged" | "geometry"> {
  const missing = [
    typeof native.finishCalled === "boolean" ? null : "finishCalled",
    typeof native.lateFinish === "boolean" ? null : "lateFinish",
    typeof native.settled === "boolean" ? null : "settled",
    typeof native.ourActive === "boolean" ? null : "ourActive",
    Number.isInteger(native.undoDelta) ? null : "undoDelta",
    Number.isInteger(native.undoDeltaAtReturn) ? null : "undoDeltaAtReturn",
    native.execError === null || typeof native.execError === "string" ? null : "execError",
    // The native source always reports both; a record that omits them or types them wrongly (cleanupError: 0) is never read as clean.
    native.foreignActive === null || typeof native.foreignActive === "string" ? null : "foreignActive",
    native.cleanupError === null || typeof native.cleanupError === "string" ? null : "cleanupError",
    typeof native.cancel === "string" && ["not-needed", "ok", "failed", "threw"].includes(native.cancel) ? null : "cancel",
  ].filter((name): name is string => name !== null);
  const execError = typeof native.execError === "string" ? native.execError : null;
  return {
    malformed: missing.length > 0 ? `the native record lacks ${missing.join(", ")}` : null,
    finishCalled: native.finishCalled === true,
    lateFinish: native.lateFinish === true,
    settle: native.settled !== true ? "never" : execError !== null ? "rejected" : "resolved",
    errorText: execError,
    errorName: typeof native.execErrorName === "string" ? native.execErrorName : null,
    undoDeltaAtReturn: Number.isInteger(native.undoDeltaAtReturn) ? native.undoDeltaAtReturn! : native.undoDelta,
    undoDeltaAfterSettle: native.undoDelta,
    ourActive: native.ourActive === true,
    foreignActive: typeof native.foreignActive === "string" && native.foreignActive !== "" ? native.foreignActive : null,
    cancel: native.cancel ?? (native.cancelError ? "threw" : "not-needed"),
    cleanup: native.cleanupError ? "threw" : "ok",
    chainedRejection: native.executeResolved === true && native.execRejected === true,
  };
}

// The note on a verified commit that did not end the plain way. "after the N ms finish wait" only when the helper
// really waited that long; a drive step that threw after an instant commit says so.
function pickVerifiedNote(native: PickCommandNativeResult, timeouts: PickCommandTimeouts): string | null {
  if (native.lateCommit === true) {
    if (native.phase === "finish") return `the commit landed after the ${timeouts.finishMs} ms finish wait; it was read back like any other`;
    if (native.phase === "drive" && native.driveThrew) return `the drive step threw after finish() (${native.error ?? "no message"}); the commit landed and was read back like any other`;
    if (native.phase === "drive") return `the drive step did not return within ${timeouts.finishMs} ms after finish(); the commit landed and was read back like any other`;
    return `the helper cancelled the command after finish()${native.error ? ` (${native.error})` : ""}; the commit landed and was read back like any other`;
  }
  if (native.execError) return `Plasticity reported "${native.execError}" after the dialog was finished, but the commit landed and was read back like any other`;
  if (native.phase === "drive" && native.driveThrew) return `the drive step threw after finish() (${native.error ?? "no message"}); the commit landed and was read back like any other`;
  return null;
}

// A rejected-unchanged outcome: finish() never called (any reason), or Plasticity's no-effect rejection after it.
function pickRejectedMessage(spec: { label: string; rejectedMessage: string }, run: PickCommandRun<unknown>, outcome: PickOutcome): string {
  const { native, timeouts } = run;
  const { label } = spec;
  const detail = native.error ? `: ${native.error}` : "";
  const execDetail = native.execError ? `: ${native.execError}` : "";
  const foreign = native.foreignActive ? `; another Plasticity command (${native.foreignActive}) is active and was left alone` : "";
  if (run.facts.finishCalled) return `${label} failed${execDetail}${foreign}; the document is unchanged`;
  if (outcome.reason === "no-effect") return `${spec.rejectedMessage}${execDetail}${foreign}`;
  if (outcome.reason === "interrupted") {
    const by = native.foreignActive ? ` by another Plasticity command (${native.foreignActive}), which was left alone` : "";
    const when = native.outcome === "rejected" ? "before its dialog opened" : "before its dialog was finished";
    // While a user's command is active, "unchanged" would claim more than we can see: say what is certain (nothing of ours changed).
    const claim = native.foreignActive ? `nothing of ours changed; the user's command ${native.foreignActive} is still active` : "the document is unchanged";
    return `${label} was interrupted ${when}${by}${execDetail}; ${claim}`;
  }
  if (outcome.reason === "cancelled") {
    if (native.phase === "unexpected") return `${label} failed${detail}; the document is unchanged${foreign}`;
    if (native.phase === "drive" && native.driveThrew) return `${label} drive step threw (drive phase)${detail}; Plasticity cancelled it and the document is unchanged${foreign}`;
    const limit = native.phase === "dialog" ? timeouts.dialogMs : timeouts.finishMs;
    return `${label} did not finish within ${limit} ms (${native.phase ?? "unknown"} phase)${detail}; Plasticity cancelled it and the document is unchanged${foreign}`;
  }
  if (native.outcome === "rejected") return `${label} ended before its dialog opened${execDetail || ": the command ended without opening its dialog"}; the document is unchanged${foreign}`;
  return `${label} failed${detail || execDetail}; the document is unchanged${foreign}`;
}

// An undetermined outcome: the runtime is marked uncertain by the caller; the message says why and asks for reconcile.
function pickUndeterminedMessage(label: string, run: PickCommandRun<unknown>, outcome: PickOutcome, context: PickReadBack): string {
  const { native, timeouts, facts } = run;
  const detail = native.error ? `: ${native.error}` : "";
  const foreign = facts.foreignActive ? `; another Plasticity command (${facts.foreignActive}) is active and was left alone` : "";
  const still = native.end?.activeCommand ?? (native.ourActive ? "our command" : "unknown");
  const delta = native.undoDelta;
  let reason = outcome.reason;
  if (reason === "malformed") {
    // A record without the full facts: say the most specific thing it does show.
    if (native.cleanupError) reason = "cleanup-failed";
    else if (native.outcome === "cancel-failed") reason = "cancel-failed";
    else if (native.settled !== true) reason = "never-settled";
    else if (native.ourActive === true) reason = "still-active";
    else if (!Number.isInteger(delta) || delta < 0 || delta > 1 || (native.outcome !== "committed" && delta !== 0)) reason = "too-many-steps";
  }
  switch (reason) {
    case "cleanup-failed": return `${label} ended in an undetermined state (cleanup failed: ${native.cleanupError}); ${PICK_RECONCILE}`;
    case "cancel-failed": return `${label} did not finish and Plasticity could not cancel it (still active: ${still}); ${PICK_RECONCILE}.${native.cancelError ? ` Cancel error: ${native.cancelError}.` : ""}`;
    case "never-settled": return `${label} ended in an undetermined state (the command never settled)${foreign}; ${PICK_RECONCILE}`;
    case "still-active": return `${label} ended in an undetermined state (still active: ${still}); ${PICK_RECONCILE}`;
    case "late-finish": return `${label} drive step called finish() after it had returned; the call was refused, but the helper no longer watched the command${foreign}; ${PICK_RECONCILE}`;
    case "too-many-steps":
    case "history-shrank":
    case "history-changed-before-finish":
      return native.outcome === "committed" && Number.isInteger(delta) && delta >= 0
        ? `${label} committed ${delta} Undo steps instead of 1; ${PICK_RECONCILE}`
        : `${label} ended as ${native.outcome} but changed the Undo history by ${delta}; ${PICK_RECONCILE}`;
    case "body-changed-before-finish": return `${label} ended before its dialog was finished (${native.outcome}${detail}), but ${context.subject} changed${foreign}; ${PICK_RECONCILE}`;
    case "body-unknown": return `${label} ended before its dialog was finished, but ${context.subject} could not be compared; ${PICK_RECONCILE}`;
    case "body-changed-no-step": return `${label} committed no Undo step but ${context.subject} changed${foreign}; ${PICK_RECONCILE}`;
    case "readback-missing":
    case "mismatch-unclean": {
      const why = facts.errorText ? ` although Plasticity reported "${facts.errorText}"` : facts.foreignActive ? ` while another Plasticity command (${facts.foreignActive}) is active` : facts.cancel !== "not-needed" ? " after the helper cancelled it" : "";
      return `${label} committed one Undo step${why}, but the read-back does not match: ${context.readback}; ${PICK_RECONCILE}`;
    }
    case "no-commit": return `${label} ended after its dialog was finished without an Undo step and without Plasticity's no-effect rejection (${context.noChange}); a commit that finish() started may still land${foreign}; ${PICK_RECONCILE}`;
    case "chained-rejection": return `${label} ended after its dialog was finished with a rejection that did not come from this command (${facts.errorText}; our execute() had already resolved), so a commit may still land${foreign}; ${PICK_RECONCILE}`;
    case "no-effect-unclean": {
      const why = facts.foreignActive ? `another Plasticity command (${facts.foreignActive}) is active` : "the helper had to cancel it";
      return `${label} was refused after its dialog was finished (${facts.errorText}), but ${why}, so a commit may still land; ${PICK_RECONCILE}`;
    }
    case "error-after-finish": {
      if (facts.cancel === "ok" && native.phase === "finish") return `${label} did not finish within ${timeouts.finishMs} ms after its dialog was finished (finish phase)${detail}; Plasticity cancelled it, but a commit that finish() started may still land${foreign}; ${PICK_RECONCILE}`;
      if (native.phase === "drive" && native.driveThrew) return `${label} drive step threw after its dialog was finished (drive phase)${detail}; Plasticity cancelled it, but a commit that finish() started may still land${foreign}; ${PICK_RECONCILE}`;
      if (native.phase === "drive") return `${label} did not finish within ${timeouts.finishMs} ms after its dialog was finished (drive phase)${detail}; Plasticity cancelled it, but a commit that finish() started may still land${foreign}; ${PICK_RECONCILE}`;
      if (native.phase === "unexpected") return `${label} failed after its dialog was finished${detail}; a commit that finish() started may still land${foreign}; ${PICK_RECONCILE}`;
      return `${label} failed${facts.errorText ? `: ${facts.errorText}` : detail}${foreign}; its dialog was finished, so a commit may still land; ${PICK_RECONCILE}`;
    }
    default: return `${label} ended in an undetermined state (outcome ${native.outcome}${detail}); ${PICK_RECONCILE}`;
  }
}

// Driving distance (Dimension tool, FINDINGS probes-2026-11-pick): sets the dialog's distance in meters, finishes
// it and returns what the command measured before the edit: refDistance (meters) and the reference point `to`.
const DRIVING_DISTANCE_DRIVE = `
      const params = dialog.params;
      const previous = params.refDistance;
      const to = params.to;
      params.distance = driveArgs.distanceM;
      dialog.finish();
      return {
        previousDistanceM: Number.isFinite(previous) ? previous : null,
        referencePointM: to && [to.x, to.y, to.z].every(Number.isFinite) ? [to.x, to.y, to.z] : null,
      };`;

/** Equal-distance and read-back tolerance for plasticity_set_driving_distance. */
export const DRIVING_DISTANCE_TOLERANCE_MM = 1e-6;

const roundMicro = (value: number) => Math.round(value * 1e6) / 1e6;

export interface DrivingDistanceResult {
  state: RuntimeState;
  /** false for a no-op: the distance already matched and nothing ran or nothing changed. */
  changed: boolean;
  previousDistanceMm: number | null;
  distanceMm: number;
  undoSteps: 0 | 1;
  /** Face ID of the moved face after the edit (face IDs change with the edit); null when nothing moved. */
  movedFaceId: string | null;
  /** Current face ID of the moving face. */
  movingFaceId: string;
  /** Signed offset of the moving face's plane along its outward normal, in mm (dot(normal, point on plane)). */
  planeOffsetMm: number;
  message?: string;
  warning?: string;
  /** Present, as "ambiguous", only when a coplanar sibling's bounds box means the read-back cannot prove which face moved (nothing contradicts the edit). */
  verification?: "ambiguous";
  /** Why the verification is ambiguous, naming the sibling faces. */
  note?: string;
}

/**
 * A certain error after an edit that DID change the document in a known way (an Undo step was added). The document
 * is readable and the runtime stays certain: `revision` is the new revision and plasticity_undo restores the change.
 */
export class CommittedChangeError extends Error {
  readonly revision: string;
  readonly undoSteps: number | null;
  constructor(message: string, revision: string, undoSteps: number | null) {
    super(message);
    // name stays "Error": callers and replies read String(error) as before.
    this.revision = revision;
    this.undoSteps = undoSteps;
  }
}

/** A face as the driving-distance geometry check reads it (the read model's face descriptor). */
export interface DrivingDistanceGeometryFace {
  id: string;
  planar: boolean;
  centerMm: Vector3;
  normal: Vector3;
  boundsMm?: { min: Vector3; max: Vector3 } | null;
}

export interface DrivingDistanceGeometryInput {
  bodyId: number;
  movingFaceId: string;
  /** The reference face (pair mode). Without it, referencePointMm (Plasticity's own `to`) or referenceOffsetMm is used. */
  referenceFaceId?: string | undefined;
  distanceMm: number;
  /** Point on the moving face (the seeded hit), mm; defaults to the face's centre. */
  hitPointMm?: Vector3 | null;
  /** Single-face mode: the reference point Plasticity measured to, mm. */
  referencePointMm?: Vector3 | null;
  /** Single-face mode without a reference point: the reference plane offset along the moving normal, mm. */
  referenceOffsetMm?: number | null;
  /** The body's faces before the edit (a by-value snapshot) and after it. */
  before: readonly DrivingDistanceGeometryFace[];
  after: readonly DrivingDistanceGeometryFace[];
}

export interface DrivingDistanceGeometryCheck {
  ok: boolean;
  /** The first failed condition, naming what changed; null when ok. */
  problem: string | null;
  /** ok, but a coplanar sibling's bounds box means the check cannot prove which face moved; nothing contradicts the edit. */
  ambiguous: boolean;
  /** The sibling faces behind an ambiguous result, in words; null otherwise. */
  note: string | null;
  /** (1) the moving face left its old place, (2) a face reached the target over the hit point, (3) the reference stayed
   * (null: single-face mode with no verifiable reference face), (4) the distance matches, (5) no other plane changed. */
  conditions: { left: boolean; reached: boolean; reference: boolean | null; distance: boolean; others: boolean };
  normal: Vector3;
  movingOffsetMm: number;
  referenceOffsetMm: number;
  /** The same-side target offset. */
  expectedOffsetMm: number;
  /** The face at the target that covers the projected hit point, and its offset. */
  movedFace: DrivingDistanceGeometryFace | null;
  reachedOffsetMm: number | null;
  measuredMm: number | null;
  /** Parallel planes after the edit, as "id@offset". */
  planesNow: string;
  /** The parallel planes (direction and offset) are the same as before the edit. */
  nothingMoved: boolean;
}

// Lateral slack for footprint tests, mm. Face bounds come from the display mesh (float32): 2.4e-4 mm at 2 m.
const DRIVING_DISTANCE_LATERAL_TOLERANCE_MM = 0.01;

/**
 * The post-commit read-back of plasticity_set_driving_distance, anchored on WHERE the faces were before the edit.
 * Face IDs change with the edit, so faces are found by plane and footprint: a face "covers" a point when the point
 * lies inside its bounds (a missing bounds box cannot refute coverage). Conditions:
 * (1) no face with the moving normal remains at the old offset over the hit point (the moving face left);
 * (2) a face with the moving normal at the target offset covers the projected hit point (a merge into a larger
 *     coplanar face, or a split, is fine); either side of the reference is accepted, the same side first;
 * (3) a face with the reference's normal still lies at the reference offset over the reference's pre-edit centre
 *     (single-face mode: over Plasticity's reference point, when a face was found there before the edit);
 * (4) the measured distance (moved plane minus reference plane) equals distanceMm within 1e-6 mm;
 * (5) along the normal, no other plane offset appeared or disappeared, except the moving face's old offset, the
 *     target offset, and offsets strictly between them (a small step the move swallowed).
 * The body version is not part of the check: the planes and footprints prove the edit.
 */
export function checkDrivingDistanceGeometry(input: DrivingDistanceGeometryInput): DrivingDistanceGeometryCheck {
  const tolerance = DRIVING_DISTANCE_TOLERANCE_MM;
  const near = (value: number, target: number) => Math.abs(value - target) <= tolerance;
  const moving = input.before.find((face) => face.id === input.movingFaceId);
  if (!moving) throw new Error(`Driving distance read-back: moving face ${input.bodyId}:${input.movingFaceId} is not in the pre-edit snapshot`);
  const normal = normalize(moving.normal, "Moving face normal");
  const unit = (face: DrivingDistanceGeometryFace): Vector3 | null => {
    const length = Math.hypot(...face.normal);
    return Number.isFinite(length) && length > 0 ? face.normal.map((value) => value / length) as Vector3 : null;
  };
  const parallel = (face: DrivingDistanceGeometryFace) => {
    const direction = unit(face);
    return face.planar && direction !== null && 1 - Math.abs(dot(direction, normal)) <= 1e-9;
  };
  const same = (face: DrivingDistanceGeometryFace) => dot(face.normal, normal) > 0;
  const offset = (face: DrivingDistanceGeometryFace) => dot(normal, face.centerMm);
  const covers = (face: DrivingDistanceGeometryFace, point: Vector3) => {
    const bounds = face.boundsMm;
    if (!bounds) return true;
    return [0, 1, 2].every((axis) => point[axis]! >= bounds.min[axis]! - DRIVING_DISTANCE_LATERAL_TOLERANCE_MM && point[axis]! <= bounds.max[axis]! + DRIVING_DISTANCE_LATERAL_TOLERANCE_MM);
  };
  const onPlane = (point: Vector3, planeOffset: number): Vector3 => add(point, scale(normal, planeOffset - dot(normal, point)));
  const movingOffset = offset(moving);
  const hit = onPlane(input.hitPointMm ?? moving.centerMm, movingOffset);

  // The reference: a face of the pair, or (single-face mode) the face under Plasticity's reference point.
  let referenceOffset: number;
  let referenceFace: DrivingDistanceGeometryFace | undefined;
  let referencePoint: Vector3 | null = null;
  if (input.referenceFaceId !== undefined) {
    referenceFace = input.before.find((face) => face.id === input.referenceFaceId);
    if (!referenceFace) throw new Error(`Driving distance read-back: reference face ${input.bodyId}:${input.referenceFaceId} is not in the pre-edit snapshot`);
    referenceOffset = offset(referenceFace);
    referencePoint = referenceFace.centerMm;
  } else if (input.referencePointMm) {
    referenceOffset = dot(normal, input.referencePointMm);
    referencePoint = input.referencePointMm;
    referenceFace = input.before.find((face) => face.id !== moving.id && parallel(face) && near(offset(face), referenceOffset) && covers(face, referencePoint!));
  } else if (typeof input.referenceOffsetMm === "number" && Number.isFinite(input.referenceOffsetMm)) {
    referenceOffset = input.referenceOffsetMm;
  } else {
    throw new Error("Driving distance read-back: Plasticity reported no reference plane to check the edit against");
  }

  const after = input.after;
  const side = Math.sign(movingOffset - referenceOffset) || 1;
  const expected = referenceOffset + side * input.distanceMm;
  const targets = [expected, referenceOffset - side * input.distanceMm];
  const atHit = (target: number) => add(hit, scale(normal, target - movingOffset));
  const facesAt = (list: readonly DrivingDistanceGeometryFace[], planeOffset: number, point: Vector3, sameDirection = true) =>
    list.filter((face) => parallel(face) && same(face) === sameDirection && near(offset(face), planeOffset) && covers(face, point));

  // (1) the moving face left its old place. A coplanar sibling whose bounds box covers the click point (an island inside a
  // ring-shaped face, a pad beside an L-shaped face) keeps the old plane "occupied" after a correct edit, and a bounds box
  // cannot tell that from a face that did not move. The count of covering faces can: when it fell, the moving face left
  // and the rest are siblings (ambiguous: nothing proves which one moved); when it did not fall, the face is still there.
  const coverBefore = facesAt(input.before, movingOffset, hit);
  const coverAfter = facesAt(after, movingOffset, hit);
  const leftState: "yes" | "ambiguous" | "no" = near(expected, movingOffset) || coverAfter.length === 0 ? "yes" : coverAfter.length < coverBefore.length ? "ambiguous" : "no";
  const left = leftState !== "no";
  const nearest = (candidates: readonly DrivingDistanceGeometryFace[], point: Vector3) =>
    candidates.reduce((best, face) => Math.hypot(...subtract(face.centerMm, point)) < Math.hypot(...subtract(best.centerMm, point)) ? face : best);
  // (2) a face reached the target over the projected hit point. The evidence is fresh when more faces cover the point than
  // before; when a coplanar face already covered it, the reach is real but cannot be told from that face (ambiguous).
  let reachedOffset: number | null = null;
  let movedFace: DrivingDistanceGeometryFace | null = null;
  let reachedFresh = false;
  for (const target of targets) {
    const point = atHit(target);
    const candidates = facesAt(after, target, point);
    if (candidates.length === 0) continue;
    const fresh = candidates.length > facesAt(input.before, target, point).length;
    if (reachedOffset !== null && !(fresh && !reachedFresh)) continue;
    reachedOffset = target;
    reachedFresh = fresh;
    movedFace = nearest(candidates, point);
    if (fresh) break;
  }
  // The moved face can shift sideways (a slanted adjacent wall) so that its bounds box no longer covers the click point.
  // A NEW face at the target whose bounds meet the footprint swept to the target then counts as a reach, as ambiguous.
  let adjacentReach = false;
  if (reachedOffset === null && moving.boundsMm) {
    const meets = (face: DrivingDistanceGeometryFace, target: number) => {
      const bounds = face.boundsMm;
      if (!bounds) return false;
      const shift = scale(normal, target - movingOffset);
      return [0, 1, 2].every((axis) => {
        const low = Math.min(moving.boundsMm!.min[axis]!, moving.boundsMm!.min[axis]! + shift[axis]!);
        const high = Math.max(moving.boundsMm!.max[axis]!, moving.boundsMm!.max[axis]! + shift[axis]!);
        return bounds.max[axis]! >= low - DRIVING_DISTANCE_LATERAL_TOLERANCE_MM && bounds.min[axis]! <= high + DRIVING_DISTANCE_LATERAL_TOLERANCE_MM;
      });
    };
    const onTarget = (list: readonly DrivingDistanceGeometryFace[], target: number) => list.filter((face) => parallel(face) && same(face) && near(offset(face), target));
    for (const target of targets) {
      const now = onTarget(after, target);
      const adjoining = now.filter((face) => meets(face, target));
      if (adjoining.length === 0 || now.length <= onTarget(input.before, target).length) continue;
      reachedOffset = target;
      movedFace = nearest(adjoining, atHit(target));
      adjacentReach = true;
      break;
    }
  }
  // (3) the reference stayed.
  const referenceSame = referenceFace ? same(referenceFace) : true;
  const referenceNow = referenceFace && referencePoint ? facesAt(after, referenceOffset, referencePoint, referenceSame) : [];
  const reference = referenceFace ? referenceNow.length > 0 : null;
  // (4) the measured distance.
  const referenceNowOffset = referenceNow[0] ? offset(referenceNow[0]) : referenceOffset;
  const measured = movedFace ? Math.abs(offset(movedFace) - referenceNowOffset) : null;
  const distance = measured !== null && Math.abs(measured - input.distanceMm) <= tolerance;
  // (5) no other plane offset along the normal appeared or disappeared.
  type Plane = { same: boolean; offset: number; count: number };
  const planes = (list: readonly DrivingDistanceGeometryFace[]): Plane[] => {
    const result: Plane[] = [];
    for (const face of list.filter(parallel)) {
      const key = { same: same(face), offset: offset(face) };
      const found = result.find((plane) => plane.same === key.same && near(plane.offset, key.offset));
      if (found) found.count += 1;
      else result.push({ ...key, count: 1 });
    }
    return result;
  };
  const planesBefore = planes(input.before);
  const planesAfter = planes(after);
  const has = (list: Plane[], plane: Plane) => list.some((candidate) => candidate.same === plane.same && near(candidate.offset, plane.offset));
  const disappeared = planesBefore.filter((plane) => !has(planesAfter, plane));
  const appeared = planesAfter.filter((plane) => !has(planesBefore, plane));
  const goal = reachedOffset ?? expected;
  const between = (value: number) => value > Math.min(movingOffset, goal) + tolerance && value < Math.max(movingOffset, goal) - tolerance;
  const strayGone = disappeared.filter((plane) => !(plane.same && near(plane.offset, movingOffset)) && !between(plane.offset));
  const strayNew = appeared.filter((plane) => !(plane.same && reachedOffset !== null && near(plane.offset, reachedOffset)));
  const others = strayGone.length === 0 && strayNew.length === 0;

  const ok = left && reachedOffset !== null && reference !== false && distance && others;
  // ok with a doubt: nothing contradicts the edit, but a bounds box cannot prove which face moved.
  const names = (list: readonly DrivingDistanceGeometryFace[]) => list.map((face) => `${input.bodyId}:${face.id}`).join(", ");
  const doubts: string[] = [];
  if (ok && leftState === "ambiguous") doubts.push(`another coplanar face overlaps the footprint (${names(coverBefore.filter((face) => face.id !== moving.id))}); could not prove which face moved`);
  if (ok && reachedOffset !== null && !reachedFresh && !adjacentReach) doubts.push(`another coplanar face overlaps the footprint at the target offset (${names(facesAt(input.before, reachedOffset, atHit(reachedOffset)))}); could not prove which face moved`);
  if (ok && adjacentReach) doubts.push(`the moved face no longer covers the click point (it shifted sideways) and ${names([movedFace!])} at the target adjoins the old footprint; could not prove which face moved`);
  const ambiguous = ok && doubts.length > 0;
  const mm = (value: number) => `${roundMicro(value)} mm`;
  const id = (faceId: string) => `${input.bodyId}:${faceId}`;
  const normalText = `[${normal.join(", ")}]`;
  let problem: string | null = null;
  if (!left) {
    // Other same-direction planes that lost a face while the moving face stayed: a different face moved.
    const lostElsewhere = planesBefore
      .filter((plane) => plane.same && !near(plane.offset, movingOffset) && !(reachedOffset !== null && near(plane.offset, reachedOffset)))
      .filter((plane) => (planesAfter.find((candidate) => candidate.same && near(candidate.offset, plane.offset))?.count ?? 0) < plane.count)
      .map((plane) => roundMicro(plane.offset));
    const elsewhere = facesAt(after, expected, atHit(expected)).length === 0 && after.some((face) => parallel(face) && same(face) && near(offset(face), expected));
    problem = lostElsewhere.length > 0
      ? `a different face moved (planes at ${lostElsewhere.join(", ")} mm lost a face; the moving face at ${mm(movingOffset)} did not move)`
      : `no face moved to ${mm(expected)} (the moving face ${id(input.movingFaceId)} is still at ${mm(movingOffset)} over its footprint${elsewhere ? `; a face at ${mm(expected)} exists, but not over the moving face's footprint` : ""})`;
  } else if (reachedOffset === null) {
    const landed = appeared.filter((plane) => plane.same).map((plane) => plane.offset).find((planeOffset) => facesAt(after, planeOffset, atHit(planeOffset)).length > 0);
    problem = after.length === 0
      ? `body ${input.bodyId} has no faces left (the moving face ${id(input.movingFaceId)} was at ${mm(movingOffset)})`
      : landed !== undefined
        ? `no face moved to ${mm(expected)}: the moving face ${id(input.movingFaceId)} left ${mm(movingOffset)} and is at ${mm(landed)}, which is ${mm(Math.abs(landed - referenceOffset))} from the reference, not ${mm(input.distanceMm)}`
        : `no face moved to ${mm(expected)}: the moving face ${id(input.movingFaceId)} was removed (no face facing ${normalText} remains at ${mm(movingOffset)} over its footprint, and none reached either distance from the reference)`;
  } else if (reference === false) {
    problem = input.referenceFaceId !== undefined
      ? `the reference face ${id(input.referenceFaceId)} moved (no face remains at ${mm(referenceOffset)} over its centre)`
      : `the reference plane Plasticity measured to (${mm(referenceOffset)}) moved`;
  } else if (!distance) {
    problem = `the moved plane lies ${measured === null ? "nowhere" : mm(measured)} from the reference, not ${mm(input.distanceMm)}`;
  } else if (!others) {
    const list = (items: Plane[]) => items.map((plane) => `${plane.same ? "" : "opposite "}${mm(plane.offset)}`).join(", ");
    problem = `other faces changed along the normal (${[strayNew.length > 0 ? `new planes at ${list(strayNew)}` : "", strayGone.length > 0 ? `planes gone from ${list(strayGone)}` : ""].filter(Boolean).join("; ")})`;
  }
  const signature = (list: Plane[]) => list.map((plane) => `${plane.same ? "+" : "-"}${roundMicro(plane.offset)}`).sort().join(",");
  return {
    ok, problem, ambiguous, note: ambiguous ? doubts.join("; ") : null,
    conditions: { left, reached: reachedOffset !== null, reference, distance, others },
    normal, movingOffsetMm: movingOffset, referenceOffsetMm: referenceOffset, expectedOffsetMm: expected,
    movedFace, reachedOffsetMm: reachedOffset, measuredMm: measured,
    planesNow: after.filter(parallel).map((face) => `${face.id}@${roundMicro(offset(face))}`).join(", ") || "none",
    nothingMoved: signature(planesBefore) === signature(planesAfter),
  };
}

export interface ExtrudeOptions {
  reverseDistanceMm?: number;
  draftAngleDeg?: number;
  reverseDraftAngleDeg?: number;
  thicknessMm?: number;
}

// Native ExtrudeFactory fields: distance2 is the opposite side, degrees1/2 are draft angles, and
// thickness turns the extrusion into a thin wall of that thickness.
const applyExtrudeOptions = `
      if (args.options.reverseDistance !== undefined) factory.distance2 = args.options.reverseDistance;
      if (args.options.draftAngleDeg !== undefined) factory.degrees1 = args.options.draftAngleDeg;
      if (args.options.reverseDraftAngleDeg !== undefined) factory.degrees2 = args.options.reverseDraftAngleDeg;
      if (args.options.thickness !== undefined) factory.thickness = args.options.thickness;`;

function nativeExtrudeOptions(options: ExtrudeOptions): Record<string, number> {
  const native: Record<string, number> = {};
  // distance2 runs along the extrude direction too (live check: +4 started the solid at z=+4), so a
  // reverse distance is passed negated.
  if (options.reverseDistanceMm !== undefined) native.reverseDistance = -millimetersToMeters(options.reverseDistanceMm);
  if (options.draftAngleDeg !== undefined) native.draftAngleDeg = options.draftAngleDeg;
  if (options.reverseDraftAngleDeg !== undefined) native.reverseDraftAngleDeg = options.reverseDraftAngleDeg;
  if (options.thicknessMm !== undefined) {
    if (!(options.thicknessMm > 0)) throw new Error("Extrude thickness must be positive");
    native.thickness = millimetersToMeters(options.thicknessMm);
  }
  return native;
}

// Capture primitive metadata before commit and restore only missing names on
// surviving stable IDs, inside the command so history snapshots include them.
const commandEndPreservingMeasurementNames = `
      const measurementNames = new Map(Array.from(editor.measurements.snapshot().repo?.measurements ?? [])
        .filter(measurement => typeof measurement.userData?.name === 'string')
        .map(measurement => [editor.measurements.lookupStableId(measurement.versionId), measurement.userData.name]));
      const result = await factory.commit();
      for (const measurement of editor.measurements.snapshot().repo?.measurements ?? []) {
        const name = measurementNames.get(editor.measurements.lookupStableId(measurement.versionId));
        if (name !== undefined && typeof measurement.userData?.name !== 'string') {
          measurement.userData ??= {};
          measurement.userData.name = name;
        }
      }
      return result;
    } catch (error) {
      failure = error;
      throw error;
    }
  };
  await this.exec(command);
  if (failure) throw failure;`;

export class PlasticityOperations {
  readonly runtime: PlasticityRuntime;
  readonly datumRegistry: DatumRegistry;
  readonly constructionGeometry: ConstructionGeometry;
  private measurementOverlaySignature?: string;

  constructor(runtime: PlasticityRuntime, sessionId: string = randomUUID()) {
    this.runtime = runtime;
    this.datumRegistry = new DatumRegistry(sessionId);
    this.constructionGeometry = new ConstructionGeometry(runtime);
  }

  // Batch state reuse. plasticity_batch holds the server lock for all its steps, so nothing in this process can
  // change the document between a state read and the next mutate(). The Plasticity UI can, at any time, and a tool
  // may await something slow (a download, a solver, a native read) between two state() calls. So while reuse is on,
  // EVERY state() that would answer from the cache first runs readRevisionProbe(): the exact revision plus the fields
  // the revision does not hash must equal the cached state's, no mutate() may have started since the cached read
  // (runtime.mutationCount()), and the runtime must not be uncertain. Otherwise the cache is dropped and a full read
  // follows. A probe serialises no topology (a few ms), so a cached answer is never older than its own probe and every
  // "document changed while ..." guard still sees a UI edit. A full read is cached only when no mutate() started while
  // it was pending: the counter is stamped before the read. Off (the default, and for every direct tool call) state()
  // behaves exactly as before: no cache and no probe.
  private stateReuse: { cached: { state: RuntimeState; mutations: number } | undefined } | undefined;

  beginStateReuse(): void {
    if (typeof this.runtime.mutationCount !== "function" || typeof this.runtime.readRevisionProbe !== "function") return;
    this.stateReuse = { cached: undefined };
  }

  // Marks the start of a batch step. Every cached answer is probed anyway, so this needs to do nothing; the server
  // calls it per step and per end read, and test harnesses use it as a step marker.
  beginStateReuseStep(): void {}

  endStateReuse(): void {
    this.stateReuse = undefined;
  }

  async state(timeoutMs = NATIVE_STATE_READ_TIMEOUT_MS): Promise<RuntimeState> {
    const reuse = this.stateReuse;
    if (!reuse) return await this.readState(timeoutMs);
    const usable = (entry: { state: RuntimeState; mutations: number }) => this.stateReuse === reuse
      && reuse.cached === entry
      && entry.mutations === this.runtime.mutationCount()
      && this.runtime.isUncertain?.() !== true;
    const cached = reuse.cached;
    if (cached && usable(cached)) {
      const probe = await this.runtime.readRevisionProbe(timeoutMs);
      // Checked again after the probe: a mutate() that started while it was pending makes the cache unusable.
      if (usable(cached) && probeMatches(probe, cached.state)) return cached.state;
    }
    reuse.cached = undefined;
    // Stamp before the read. readState's own measurement-overlay refresh is one mutate() that leaves the document as
    // read; any other mutate() that starts while the read is pending means the result must not be cached.
    const stamp = this.runtime.mutationCount();
    let readClean = false;
    let ownOverlayMutations = 0;
    const state = await this.readState(timeoutMs, (phase) => {
      if (phase === "read") readClean = this.runtime.mutationCount() === stamp;
      else ownOverlayMutations += 1;
    });
    if (readClean
      && this.stateReuse === reuse
      && this.runtime.isUncertain?.() !== true
      && this.runtime.mutationCount() === stamp + ownOverlayMutations) {
      reuse.cached = { state, mutations: this.runtime.mutationCount() };
    }
    return state;
  }

  // observe("read") runs right after the native read returns; observe("overlay") right before the overlay mutate().
  private async readState(timeoutMs: number, observe?: (phase: "read" | "overlay") => void): Promise<RuntimeState> {
    const state = await this.runtime.getState(timeoutMs);
    observe?.("read");
    const measurements = (state.measurements ?? []).filter((measurement) =>
      measurement.type === "DistanceMeasurement"
      && measurement.first?.positionMm
      && measurement.second?.positionMm
      && measurement.direction
      && measurement.normal
      && measurement.offsetMm.length >= 2
      && typeof measurement.distanceMm === "number"
      && Number.isFinite(measurement.distanceMm),
    );
    const signature = JSON.stringify({
      documentToken: state.documentToken,
      measurements: measurements.map((measurement) => [
        measurement.versionId,
        measurement.first!.positionMm,
        measurement.second!.positionMm,
        measurement.direction,
        measurement.normal,
        measurement.offsetMm.slice(0, 2),
        measurement.distanceMm,
      ]),
    });
    if (this.measurementOverlaySignature !== signature
      && (measurements.length > 0 || this.measurementOverlaySignature !== undefined)
      && this.runtime.isUncertain?.() !== true
      && typeof this.runtime.mutate === "function") {
      observe?.("overlay");
      await this.runtime.mutate(`function (LineSegmentHelper, Vector3, Vector2, makeAxisAlignedMeasurementPath, args) {
        const nativeLabels = this.measurements.distanceLabels;
        for (const label of nativeLabels.labels.slice()) {
          nativeLabels.group.remove(label);
          label.element?.remove();
        }
        nativeLabels.labels.length = 0;
        nativeLabels.segments.clear();
        this.measurements.distanceSegments.clear();
        const managerKey = '__plasticityMcpDistanceOverlays';
        if (!(this[managerKey] instanceof Map)) Object.defineProperty(this, managerKey, { value: new Map(), configurable: true });
        const manager = this[managerKey];
        const managedLabels = new Set(Array.from(manager.values()).flatMap(tag => tag.labels ?? []));
        for (const label of document.querySelectorAll('[data-plasticity-mcp-distance]')) {
          if (!managedLabels.has(label)) label.remove();
        }
        const tagged = this.helpers.scene.children.filter(helper => helper.userData?.plasticityMcpMeasurementOverlay);
        const viewports = Array.from(this.viewports);
        const currentVersions = new Set(args.measurements.map(measurement => measurement.versionId));
        const overlayKey = (documentToken, versionId) => documentToken + ':' + versionId;
        const removeOverlay = (key, tag) => {
          if (tag.frameId !== undefined) cancelAnimationFrame(tag.frameId);
          for (const label of tag.labels ?? []) label.remove();
          for (const helper of tag.helpers ?? (tag.helper ? [tag.helper] : [])) {
            if (helper.parent) this.helpers.remove(helper);
          }
          manager.delete(key);
        };
        for (const helper of tagged) {
          const tag = helper.userData.plasticityMcpMeasurementOverlay;
          const key = overlayKey(tag.documentToken, tag.versionId);
          tag.helper = helper;
          tag.labels ??= [];
          if (!manager.has(key)) manager.set(key, tag);
        }
        for (const [key, tag] of Array.from(manager.entries())) {
          if (tag.documentToken !== args.documentToken || !currentVersions.has(tag.versionId)) removeOverlay(key, tag);
        }
        for (const measurement of args.measurements) {
          const key = overlayKey(args.documentToken, measurement.versionId);
          const previous = manager.get(key);
          if (previous) removeOverlay(key, previous);
          const first = new Vector3(...measurement.firstMm.map(value => value / 1000));
          const second = new Vector3(...measurement.secondMm.map(value => value / 1000));
          const direction = new Vector3(...measurement.direction);
          const normal = new Vector3(...measurement.normal);
          const offset = new Vector2(...measurement.offsetMm.map(value => value / 1000));
          let displayOffset = offset;
          if (offset.length() < 0.0005) {
            const extent = args.bodyBoundsMm
              .filter(body => body.bodyIds.includes(measurement.firstBodyId) || body.bodyIds.includes(measurement.secondBodyId))
              .map(body => body.boundsMm)
              .filter(Boolean);
            const bounds = extent.length ? {
              min: [0, 1, 2].map(axis => Math.min(...extent.map(value => value.min[axis]))),
              max: [0, 1, 2].map(axis => Math.max(...extent.map(value => value.max[axis]))),
            } : undefined;
            const step = Math.max(measurement.distanceMm * 0.08, 2);
            const maxSpan = bounds ? Math.max(...bounds.max.map((value, axis) => value - bounds.min[axis])) : 0;
            const distances = Array.from(new Set([step, maxSpan * 0.25, maxSpan * 0.5, maxSpan * 0.75, maxSpan, maxSpan + step].filter(value => value >= step))).sort((a, b) => a - b);
            const outsideDistance = point => bounds ? Math.hypot(...point.map((value, axis) => Math.max(bounds.min[axis] - value, 0, value - bounds.max[axis]))) : 0;
            let best;
            for (const distanceMm of distances) {
              for (const candidate of [[distanceMm, 0], [-distanceMm, 0], [0, distanceMm], [0, -distanceMm]]) {
                const candidatePath = makeAxisAlignedMeasurementPath(first, second, direction, normal, new Vector2(candidate[0] / 1000, candidate[1] / 1000));
                const startMm = candidatePath[1].toArray().map(value => value * 1000);
                const endMm = candidatePath[3].toArray().map(value => value * 1000);
                const clearance = Math.min(outsideDistance(startMm), outsideDistance(endMm));
                if (!best || clearance > best.clearance) best = { candidate, clearance, path: candidatePath };
                if (clearance > 0.01) {
                  displayOffset = new Vector2(candidate[0] / 1000, candidate[1] / 1000);
                  break;
                }
              }
              if (displayOffset !== offset) break;
            }
            if (displayOffset === offset && best && best.clearance > 0) {
              displayOffset = new Vector2(best.candidate[0] / 1000, best.candidate[1] / 1000);
            }
            if (displayOffset === offset) displayOffset = new Vector2(0, step / 1000);
          }
          const path = makeAxisAlignedMeasurementPath(first, second, direction, normal, displayOffset);
          const linePairs = [[path[0], path[1]], [path[1], path[3]], [path[3], path[4]]];
          const helpers = linePairs
            .filter(([start, end]) => start.distanceToSquared(end) > 1e-16)
            .map(([start, end]) => {
              const helper = new LineSegmentHelper(this);
              helper.p1.copy(start);
              helper.p2.copy(end);
              return helper;
            });
          const helper = helpers.find(candidate => candidate.p1.distanceToSquared(path[1]) < 1e-16
            && candidate.p2.distanceToSquared(path[3]) < 1e-16);
          const labelPoint = path[1].clone().add(path[3]).multiplyScalar(0.5);
          const labels = viewports.map(viewport => {
            const label = document.createElement('div');
            label.dataset.plasticityMcpDistance = String(measurement.versionId);
            label.textContent = measurement.distanceMm.toFixed(2) + ' mm';
            Object.assign(label.style, {
              position: 'absolute',
              zIndex: '30',
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
              transform: 'translate(-50%, -120%)',
              padding: '2px 6px',
              borderRadius: '4px',
              border: '1px solid rgba(183, 243, 151, 0.7)',
              color: '#eef4f0',
              background: 'rgba(10, 13, 16, 0.9)',
              font: '600 12px ui-sans-serif, system-ui, sans-serif',
              lineHeight: '16px',
            });
            viewport.container.append(label);
            return { viewport, label };
          });
          const tag = {
            documentToken: args.documentToken,
            versionId: measurement.versionId,
            helper,
            helpers,
            labels: labels.map(entry => entry.label),
            frameId: undefined,
          };
          helper.userData.plasticityMcpMeasurementOverlay = tag;
          for (const lineHelper of helpers) lineHelper.userData.plasticityMcpMeasurementOverlay = tag;
          manager.set(key, tag);
          for (const lineHelper of helpers) {
            this.helpers.add(lineHelper);
            lineHelper.render();
            lineHelper.line.material.color.setHex(0xb7f397);
            lineHelper.line.material.depthTest = false;
            lineHelper.line.material.depthWrite = false;
            lineHelper.line.material.linewidth = 2;
            lineHelper.line.renderOrder = 1000;
            lineHelper.line.material.needsUpdate = true;
          }
          const updateLabels = () => {
            if (manager.get(key) !== tag) {
              for (const entry of labels) entry.label.remove();
              return;
            }
            for (const { viewport, label } of labels) {
              const camera = viewport.camera;
              camera.updateMatrixWorld(true);
              const point = labelPoint.clone().project(camera);
              const width = viewport.container.clientWidth;
              const height = viewport.container.clientHeight;
              const visible = width > 0 && height > 0 && point.z >= -1 && point.z <= 1
                && point.x >= -1 && point.x <= 1 && point.y >= -1 && point.y <= 1;
              label.style.display = visible ? 'block' : 'none';
              if (visible) {
                label.style.left = ((point.x + 1) * width / 2) + 'px';
                label.style.top = ((1 - point.y) * height / 2) + 'px';
              }
            }
            tag.frameId = requestAnimationFrame(updateLabels);
          };
          // Hidden renderers may suspend RAF. Keep an explicit refresh without
          // starting a second animation loop when a caller advances the camera.
          tag.refreshLabels = () => {
            if (tag.frameId !== undefined) cancelAnimationFrame(tag.frameId);
            updateLabels();
          };
          tag.refreshLabels();
        }
        for (const viewport of viewports) viewport.setNeedsRender();
      }`, ["LineSegmentHelper", "Vector3", "Vector2", "makeAxisAlignedMeasurementPath"], [{
        documentToken: state.documentToken,
          measurements: measurements.map((measurement) => ({
            versionId: measurement.versionId,
            firstMm: measurement.first!.positionMm!,
            secondMm: measurement.second!.positionMm!,
            firstBodyId: measurement.first!.bodyId,
            secondBodyId: measurement.second!.bodyId,
            direction: measurement.direction!,
            normal: measurement.normal!,
            offsetMm: measurement.offsetMm.slice(0, 2),
            distanceMm: measurement.distanceMm!,
          })),
        bodyBoundsMm: state.bodies.flatMap(body => body.boundsMm ? [{ bodyIds: [body.id], boundsMm: body.boundsMm }] : []),
      }]);
      this.measurementOverlaySignature = signature;
    }
    return state;
  }

  async measurePointDistance(first: MeasurementPointReference, second: MeasurementPointReference, revision: string) {
    return measurePointDistance(await this.state(), first, second, revision);
  }

  async measurePointToLinearEdge(point: MeasurementPointReference, edge: EdgeReference, revision: string) {
    return measurePointToLinearEdge(await this.state(), point, edge, revision);
  }

  async measurePointToSampledCurveEdge(
    point: MeasurementPointReference,
    edgeReference: EdgeReference | WireSegmentReference,
    revision: string,
    requestedToleranceMm = 0.01,
    maxSegments = 2048,
  ) {
    const before = await this.assertRevision(revision);
    if (!Number.isFinite(requestedToleranceMm) || requestedToleranceMm <= 0) throw new Error("Curve approximation tolerance must be positive and finite");
    if (!Number.isInteger(maxSegments) || maxSegments < 64 || maxSegments > 8192) throw new Error("Curve approximation maxSegments must be an integer from 64 to 8192");
    const body = before.bodies.find((candidate) => candidate.id === edgeReference.bodyId);
    let expectedCurveType: string | undefined;
    if ("edgeId" in edgeReference) {
      const edge = body?.edges.find((candidate) => candidate.id === edgeReference.edgeId);
      if (!edge) throw new Error(`Unknown current B-Rep edge: ${edgeReference.bodyId}:${edgeReference.edgeId}`);
      if (edge.line || edge.circle) throw new Error("Sampled curved-edge measurement only accepts non-linear, non-circular B-Rep edges; use the exact line or circle measurement tool");
      expectedCurveType = edge.curveType;
    } else {
      if (body?.type !== "Wire") throw new Error(`Curved Wire segment reference requires a current Wire body: ${edgeReference.bodyId}`);
      if (!Number.isInteger(edgeReference.segmentEntityId) || edgeReference.segmentEntityId <= 0) throw new Error("Wire segment entity ID must be a positive integer");
    }

    const sampled = await this.runtime.readNative<{
      curveType: string;
      lengthMm: number;
      isLine: boolean;
      isCircle: boolean;
      samples: Array<{ normalizedParameter: number; positionMm: [number, number, number] }>;
      maxObservedChordDeviationMm: number;
    }>(nativeFunction`function (args) {
      const mm = value => value * 1000;
      const vector = value => [mm(value.x), mm(value.y), mm(value.z)];
      const pointSegmentDistance = (point, first, second) => {
        const dx = second.x - first.x, dy = second.y - first.y, dz = second.z - first.z;
        const length2 = dx * dx + dy * dy + dz * dz;
        const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - first.x) * dx + (point.y - first.y) * dy + (point.z - first.z) * dz) / length2));
        return Math.hypot(point.x - (first.x + dx * t), point.y - (first.y + dy * t), point.z - (first.z + dz * t));
      };
      let item;
      for (const [versionId, candidate] of nativeApi.geo.geometryModel) {
        if (nativeApi.db.lookupStableId(versionId) === args.reference.bodyId) { item = candidate; break; }
      }
      if (!item) throw new Error('Curved-edge body is no longer current: ' + args.reference.bodyId);
      let nativeEdge;
      if (args.reference.kind === 'wire-segment') {
        if (item.view?.constructor?.name !== 'Wire') throw new Error('Curved segment source is no longer a Wire: ' + args.reference.bodyId);
        for (const segmentView of Array.from(item.view.segments ?? [])) {
          const candidate = nativeApi.db.lookupTopologyItem(segmentView);
          if (Number(candidate?.Id?.()) === args.reference.segmentEntityId) { nativeEdge = candidate; break; }
        }
        if (!nativeEdge) throw new Error('Stale or unknown Wire segment: ' + args.reference.bodyId + ':' + args.reference.segmentEntityId);
      } else {
        if (!['Solid', 'Sheet'].includes(item.view?.constructor?.name)) throw new Error('Curved-edge measurement requires a current Solid or Sheet');
        const edgeViews = item.view.high?.edges;
        if (!edgeViews) throw new Error('Native B-Rep edge views are unavailable');
        const viewIndex = edgeViews.versionIds.indexOf(args.reference.edgeId);
        const edgeView = viewIndex >= 0 ? edgeViews.get(viewIndex) : null;
        if (!edgeView) throw new Error('Stale or unknown B-Rep edge: ' + args.reference.bodyId + ':' + args.reference.edgeId);
        const modelEdges = item.model?.GetEdges?.();
        for (let index = 0; index < (modelEdges?.Size?.() ?? 0); index++) {
          const candidate = modelEdges.Get(index);
          if (candidate.Id() === edgeView.entityId) { nativeEdge = candidate; break; }
        }
        if (!nativeEdge) throw new Error('Native B-Rep edge entity is unavailable');
      }
      const wrappedCurve = nativeEdge.GetCurve();
      const curve = wrappedCurve?.curve ?? wrappedCurve;
      const curveType = String(curve?.constructor?.name ?? 'Unknown');
      const nativeLength = nativeEdge.FindLength();
      const lengthMm = mm(typeof nativeLength === 'number' ? nativeLength : nativeLength?.length);
      if (!Number.isFinite(lengthMm) || lengthMm <= 0) throw new Error('Native curved-edge length is unavailable');
      const isLine = typeof nativeEdge.IsLine === 'function' ? Boolean(nativeEdge.IsLine()) : /line/i.test(curveType);
      const isCircle = typeof nativeEdge.IsCircle === 'function' && Boolean(nativeEdge.IsCircle());
      let segmentCount = 64;
      let maxObservedChordDeviationMm = 0;
      let samples = [];
      for (;;) {
        const nativePoints = Array.from({ length: segmentCount + 1 }, (_unused, index) => nativeEdge.GetPointAndTangent(index / segmentCount).position);
        maxObservedChordDeviationMm = 0;
        for (let index = 0; index < segmentCount; index++) {
          const midpoint = nativeEdge.GetPointAndTangent((index + 0.5) / segmentCount).position;
          maxObservedChordDeviationMm = Math.max(maxObservedChordDeviationMm, mm(pointSegmentDistance(midpoint, nativePoints[index], nativePoints[index + 1])));
        }
        samples = nativePoints.map((position, index) => ({ normalizedParameter: index / segmentCount, positionMm: vector(position) }));
        if (maxObservedChordDeviationMm <= args.requestedToleranceMm || segmentCount >= args.maxSegments) break;
        segmentCount = Math.min(segmentCount * 2, args.maxSegments);
      }
      return { curveType, lengthMm, isLine, isCircle, samples, maxObservedChordDeviationMm };
    }`, [], [{ reference: "edgeId" in edgeReference
      ? { kind: "brep-edge", bodyId: edgeReference.bodyId, edgeId: edgeReference.edgeId }
      : { kind: "wire-segment", bodyId: edgeReference.bodyId, segmentEntityId: edgeReference.segmentEntityId }, requestedToleranceMm, maxSegments }]);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while the curved-edge distance was being measured");
    }
    if (expectedCurveType !== undefined && expectedCurveType !== sampled.curveType) throw new Error("Native curved-edge type no longer matches the current edge reference");
    if (sampled.isLine || sampled.isCircle) throw new Error("Sampled curved-edge measurement only accepts non-linear, non-circular B-Rep edges; use the exact line or circle measurement tool");
    return measurePointToSampledCurveEdge(after, point, edgeReference, revision, sampled.samples, {
      requestedToleranceMm,
      maxObservedChordDeviationMm: sampled.maxObservedChordDeviationMm,
    }, "edgeId" in edgeReference ? undefined : {
      bodyId: edgeReference.bodyId,
      segmentEntityId: edgeReference.segmentEntityId,
      curveType: sampled.curveType,
      lengthMm: sampled.lengthMm,
      linear: sampled.isLine,
      circular: sampled.isCircle,
    });
  }

  async measurePointToCircularEdge(point: MeasurementPointReference, edge: EdgeReference | WireSegmentReference, revision: string) {
    const state = await this.state();
    if ("edgeId" in edge) return measurePointToCircularEdge(state, point, edge, revision);
    const inventory = await this.listCurveDirections();
    if (inventory.revision !== revision || inventory.documentToken !== state.documentToken) throw new Error("Circular Wire segment reference is stale");
    const curve = inventory.curves.find((candidate) => candidate.id === edge.bodyId);
    const segment = curve?.segments.find((candidate) => candidate.entityId === edge.segmentEntityId);
    if (!segment?.circleGeometry) throw new Error("Measurement Wire segment requires exact native circular B-Rep geometry");
    const geometry: NativeWireCircularSegment = {
      segmentEntityId: segment.entityId,
      lengthMm: segment.lengthMm,
      circleGeometry: segment.circleGeometry,
    };
    return measurePointToCircularEdge(state, point, edge, revision, geometry);
  }

  async measurePointToPlanarFace(point: MeasurementPointReference, face: FaceReference, revision: string) {
    return measurePointToPlanarFace(await this.state(), point, face, revision);
  }

  async measurePlanarFaces(first: FaceReference, second: FaceReference, revision: string, angularToleranceDeg = 0.01) {
    return measurePlanarFaces(await this.state(), first, second, revision, angularToleranceDeg);
  }

  async measureParallelPlanarFaceClearance(first: FaceReference, second: FaceReference, revision: string) {
    return measureParallelPlanarFaceClearance(await this.state(), first, second, revision);
  }

  async measureNonparallelPlanarPolygonFaceClearance(first: FaceReference, second: FaceReference, revision: string) {
    return measureNonparallelPlanarPolygonFaceClearance(await this.state(), first, second, revision);
  }

  async measureLinearEdges(first: EdgeReference, second: EdgeReference, revision: string, angularToleranceDeg = 0.01) {
    return measureLinearEdges(await this.state(), first, second, revision, angularToleranceDeg);
  }

  async measureFastenerGripStack(layers: FastenerGripLayerReference[], axis: Vector3, revision: string, angularToleranceDeg = 0.01) {
    return measureFastenerGripStack(await this.state(), layers, axis, revision, angularToleranceDeg);
  }

  async analyzeEdgeCurvature(edges: CurvatureEdgeReference[], revision: string) {
    const state = await this.assertRevision(revision);
    if (edges.length === 0) throw new Error("At least one edge is required for curvature analysis");
    const keys = edges.map((edge) => "edgeId" in edge ? `${edge.bodyId}:shell:${edge.edgeId}` : `${edge.bodyId}:wire:${edge.segmentEntityId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Curvature edge references must be unique");
    const bodyVersions = new Map<number, number>();
    for (const reference of edges) {
      const body = state.bodies.find((candidate) => candidate.id === reference.bodyId);
      if (!body || !["Wire", "Solid", "Sheet"].includes(body.type)) {
        throw new Error(`Unknown current Wire, Solid, or Sheet body ID: ${reference.bodyId}`);
      }
      if (body.type === "Wire") {
        if (!("segmentEntityId" in reference)) {
          throw new Error(`Wire curvature reference ${reference.bodyId} requires a native segmentEntityId`);
        }
      } else {
        if (!("edgeId" in reference) || !body.edges.some((candidate) => candidate.id === reference.edgeId)) {
          throw new Error(`Unknown current edge ID ${"edgeId" in reference ? reference.edgeId : "(missing)"} on body ${reference.bodyId}`);
        }
      }
      bodyVersions.set(body.id, body.versionId);
    }
    const analyses = await this.runtime.readNative(nativeFunction`async function (evalCurvatureMeasurements, Measurement, Target, Landmark, args) {
      const selected = args.edges.map(reference => {
        let item;
        for (const [versionId, candidate] of nativeApi.geo.geometryModel) {
          if (nativeApi.db.lookupStableId(versionId) === reference.bodyId) { item = candidate; break; }
        }
        if (!item || !['Wire', 'Solid', 'Sheet'].includes(item.view?.constructor?.name)) {
          throw new Error('Unknown current Wire, Solid, or Sheet body ID: ' + reference.bodyId);
        }
        let entityId;
        if (item.view.constructor.name === 'Wire') {
          if (!Number.isInteger(reference.segmentEntityId)) throw new Error('Wire curvature reference requires a native segmentEntityId');
          const modelEdges = item.model?.GetEdges?.();
          for (let index = 0; index < (modelEdges?.Size?.() ?? 0); index += 1) {
            const modelEdge = modelEdges.Get(index);
            if (Number(modelEdge.Id()) === reference.segmentEntityId) { entityId = reference.segmentEntityId; break; }
          }
          if (!Number.isInteger(entityId)) throw new Error('Stale or unknown Wire segment: ' + reference.bodyId + ':' + reference.segmentEntityId);
        } else {
          const edgeIndex = item.view.high.edges.versionIds.indexOf(reference.edgeId);
          if (edgeIndex < 0) throw new Error('Stale or unknown shell edge: ' + reference.edgeId);
          entityId = Number(item.view.high.edges.get(edgeIndex).entityId);
        }
        return {
          reference,
          bodyVersionId: args.bodyVersions.find(candidate => candidate.bodyId === reference.bodyId)?.versionId,
          modelBodyId: Number(item.model.Id()),
          entityId,
        };
      });
      const measurements = selected.map(candidate => {
        const measurement = new Measurement();
        measurement.target = new Target(Landmark.Edge, candidate.entityId, candidate.modelBodyId);
        measurement.tmin = 0;
        measurement.tmax = 1;
        return measurement;
      });
      const evaluated = await evalCurvatureMeasurements(measurements, [], this.analyzer, undefined, undefined);
      if (evaluated.measurements.length !== selected.length || evaluated.views.length !== selected.length) {
        throw new Error('Plasticity curvature measurements and views are inconsistent');
      }
      const zeroTolerancePerMm = 1e-12;
      return selected.map((candidate, index) => {
        const view = evaluated.views[index];
        const edgeIds = Array.from(view.edgeIds ?? [], Number);
        const analysisIndex = edgeIds.findIndex(edgeId => edgeId === candidate.entityId);
        if (analysisIndex < 0 || !view.analyses?.[analysisIndex]) {
          throw new Error('Plasticity returned curvature data for an unexpected edge');
        }
        const analysis = view.analyses[analysisIndex];
        const spikes = Array.from(analysis.spikes ?? [], Number);
        if (spikes.length === 0 || spikes.length % 6 !== 0) {
          throw new Error('Plasticity returned malformed curvature samples');
        }
        const samples = [];
        for (let offset = 0; offset < spikes.length; offset += 6) {
          const positionMm = [spikes[offset] * 1000, spikes[offset + 1] * 1000, spikes[offset + 2] * 1000];
          const vectorPerMm = [spikes[offset + 3] / 1000, spikes[offset + 4] / 1000, spikes[offset + 5] / 1000];
          const curvaturePerMm = Math.hypot(...vectorPerMm);
          if (![...positionMm, ...vectorPerMm, curvaturePerMm].every(Number.isFinite)) {
            throw new Error('Plasticity returned a non-finite curvature sample');
          }
          samples.push({ positionMm, vectorPerMm, curvaturePerMm });
        }
        let minimum = samples[0];
        let maximum = samples[0];
        let sum = 0;
        let minimumPositive = Infinity;
        let containsZeroCurvature = false;
        for (const sample of samples) {
          if (sample.curvaturePerMm < minimum.curvaturePerMm) minimum = sample;
          if (sample.curvaturePerMm > maximum.curvaturePerMm) maximum = sample;
          sum += sample.curvaturePerMm;
          if (sample.curvaturePerMm <= zeroTolerancePerMm) containsZeroCurvature = true;
          else minimumPositive = Math.min(minimumPositive, sample.curvaturePerMm);
        }
        return {
          edge: candidate.reference,
          bodyVersionId: candidate.bodyVersionId,
          measurementSource: 'native-brep-100-samples',
          sampleCount: samples.length,
          minimumCurvaturePerMm: minimum.curvaturePerMm,
          maximumCurvaturePerMm: maximum.curvaturePerMm,
          meanCurvaturePerMm: sum / samples.length,
          minimumCurvatureAtMm: minimum.positionMm,
          maximumCurvatureAtMm: maximum.positionMm,
          maximumCurvatureVectorPerMm: maximum.vectorPerMm,
          minimumRadiusOfCurvatureMm: maximum.curvaturePerMm > zeroTolerancePerMm ? 1 / maximum.curvaturePerMm : null,
          maximumFiniteRadiusOfCurvatureMm: Number.isFinite(minimumPositive) ? 1 / minimumPositive : null,
          containsZeroCurvature,
        };
      });
    }`, ["evalCurvatureMeasurements", "CurvatureMeasurement", "Target", "TopologyLandmark"], [{
      edges,
      bodyVersions: [...bodyVersions].map(([bodyId, versionId]) => ({ bodyId, versionId })),
    }]);
    return { documentToken: state.documentToken, revision: state.revision, analyses };
  }

  async analyzeFaceDraft(
    faces: FaceReference[],
    pullDirection: Vector3,
    minimumDraftDeg: number,
    samplesPerDirection: number,
    revision: string,
  ): Promise<{
    documentToken: string;
    revision: string;
    pullDirection: Vector3;
    minimumDraftDeg: number;
    samplesPerDirection: number;
    analyses: FaceDraftAnalysis[];
    limitation: string;
  }> {
    const before = await this.assertRevision(revision);
    requireTopologySelection(before, faces, "face");
    const invalidBodies = [...new Set(faces.map((reference) => reference.bodyId))].filter((bodyId) => {
      const type = before.bodies.find((body) => body.id === bodyId)?.type;
      return type !== "Solid" && type !== "Sheet";
    });
    if (invalidBodies.length > 0) throw new Error(`Face draft analysis requires current Solid or Sheet bodies: ${invalidBodies.join(", ")}`);
    if (!Number.isFinite(minimumDraftDeg) || minimumDraftDeg <= 0 || minimumDraftDeg >= 90) {
      throw new Error("Minimum draft angle must be greater than 0 and less than 90 degrees");
    }
    if (!Number.isInteger(samplesPerDirection) || samplesPerDirection < 3 || samplesPerDirection > 32) {
      throw new Error("Draft samples per direction must be an integer from 3 through 32");
    }
    const unitPullDirection = normalize(pullDirection, "Draft pull direction");
    const bodyVersions = new Map(before.bodies.map((body) => [body.id, body.versionId]));
    const native = await this.runtime.readNative<NativeFaceDraftSamples[]>(nativeFunction`function (args) {
      const mm = value => value * 1000;
      const vectorMm = value => [mm(value.x), mm(value.y), mm(value.z)];
      const direction = value => [Number(value.x), Number(value.y), Number(value.z)];
      const result = [];
      for (const reference of args.faces) {
        let found;
        for (const [versionId, item] of nativeApi.geo.geometryModel) {
          if (nativeApi.db.lookupStableId(versionId) === reference.bodyId) { found = [versionId, item]; break; }
        }
        if (!found || !['Solid', 'Sheet'].includes(found[1].view?.constructor?.name)) {
          throw new Error('Unknown current draft-analysis body ID: ' + reference.bodyId);
        }
        const [versionId, item] = found;
        const faceViews = item.view.high.faces;
        const viewIndex = faceViews.versionIds.indexOf(reference.faceId);
        if (viewIndex < 0) throw new Error('Unknown current draft-analysis face: ' + reference.bodyId + ':' + reference.faceId);
        const entityId = Number(faceViews.get(viewIndex).entityId);
        const nativeFaces = item.model.GetFaces();
        let face;
        for (let index = 0; index < nativeFaces.Size(); index += 1) {
          const candidate = nativeFaces.Get(index);
          if (Number(candidate.Id()) === entityId) { face = candidate; break; }
        }
        if (!face) throw new Error('Native draft-analysis face is unavailable: ' + reference.bodyId + ':' + reference.faceId);
        const grid = Array.from(face.EvalGrid(args.samplesPerDirection, args.samplesPerDirection), Number);
        if (grid.length === 0 || grid.length % 3 !== 0 || !grid.every(Number.isFinite)) {
          throw new Error('Plasticity returned malformed native face samples');
        }
        const seed = face.FindUVMidpoint();
        const NativeVector = seed?.position?.constructor;
        if (typeof NativeVector !== 'function') throw new Error('Plasticity native Vector constructor is unavailable');
        const samples = [];
        for (let offset = 0; offset < grid.length; offset += 3) {
          const requested = new NativeVector(grid[offset], grid[offset + 1], grid[offset + 2]);
          const uv = face.FindPointNear(requested);
          const evaluated = face.EvalNormal(uv.u, uv.v);
          const positionMm = vectorMm(evaluated.position);
          const normal = direction(evaluated.normal);
          if (![...positionMm, ...normal].every(Number.isFinite)) {
            throw new Error('Plasticity returned non-finite native face-normal data');
          }
          samples.push({ positionMm, normal });
        }
        result.push({
          face: reference,
          bodyVersionId: Number(versionId),
          surfaceType: String(face.GetSurface()?.surface?.constructor?.name ?? 'Unknown'),
          samples,
        });
      }
      return result;
    }`, [], [{ faces, samplesPerDirection }]);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed during native face draft analysis");
    }
    if (native.length !== faces.length) throw new Error("Native face draft result count does not match the request");
    const analyses = native.map((entry, index) => {
      const reference = faces[index]!;
      if (entry.face.bodyId !== reference.bodyId || entry.face.faceId !== reference.faceId || entry.bodyVersionId !== bodyVersions.get(reference.bodyId)) {
        throw new Error(`Native face draft identity mismatch for ${reference.bodyId}:${reference.faceId}`);
      }
      return summarizeFaceDraftSamples(entry, unitPullDirection, minimumDraftDeg);
    });
    return {
      documentToken: after.documentToken,
      revision: after.revision,
      pullDirection: unitPullDirection,
      minimumDraftDeg,
      samplesPerDirection,
      analyses,
      limitation: "Native B-Rep normals are evaluated at a finite grid of interior face points; extrema between samples, mold parting, release paths, and print support requirements are not proven.",
    };
  }

  async analyzeSurfaceContinuity(
    edges: EdgeReference[],
    revision: string,
    positionToleranceMm = 0.01,
    normalAngleToleranceDeg = 0.1,
    relativeCurvatureTolerance = 0.05,
  ) {
    const state = await this.assertRevision(revision);
    if (edges.length === 0) throw new Error("At least one edge is required for surface continuity analysis");
    const keys = edges.map((edge) => `${edge.bodyId}:${edge.edgeId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Surface continuity edge references must be unique");
    requirePositiveFinite(positionToleranceMm, "Position tolerance");
    requirePositiveFinite(normalAngleToleranceDeg, "Normal angle tolerance");
    requirePositiveFinite(relativeCurvatureTolerance, "Relative curvature tolerance");
    const bodyVersions = new Map<number, number>();
    for (const reference of edges) {
      const body = state.bodies.find((candidate) => candidate.id === reference.bodyId);
      if (!body || (body.type !== "Solid" && body.type !== "Sheet")) {
        throw new Error(`Unknown current Solid or Sheet body ID: ${reference.bodyId}`);
      }
      const edge = body.edges.find((candidate) => candidate.id === reference.edgeId);
      if (!edge) throw new Error(`Unknown current edge ID ${reference.edgeId} on body ${reference.bodyId}`);
      if (edge.faceIds.length !== 2) {
        throw new Error(`Surface continuity edge ${reference.edgeId} on body ${reference.bodyId} must have exactly two adjacent faces`);
      }
      bodyVersions.set(body.id, body.versionId);
    }
    const tolerances = {
      positionMm: positionToleranceMm,
      normalAngleDeg: normalAngleToleranceDeg,
      relativeCurvature: relativeCurvatureTolerance,
    };
    const analyses = await this.runtime.readNative(nativeFunction`async function (Factory, ContinuityType, evalSurfaceContinuityMeasurements, Refresh, args) {
      const selected = args.edges.map(reference => {
        let item;
        for (const [versionId, candidate] of nativeApi.geo.geometryModel) {
          if (nativeApi.db.lookupStableId(versionId) === reference.bodyId) { item = candidate; break; }
        }
        if (!item || !['Solid', 'Sheet'].includes(item.view?.constructor?.name)) {
          throw new Error('Unknown current Solid or Sheet body ID: ' + reference.bodyId);
        }
        const edgeIndex = item.view.high.edges.versionIds.indexOf(reference.edgeId);
        if (edgeIndex < 0) throw new Error('Stale or unknown edge: ' + reference.edgeId);
        const edge = item.view.high.edges.get(edgeIndex);
        const faceId = topologyId => {
          for (let index = 0; index < item.view.high.faces.versionIds.length; index += 1) {
            const face = item.view.high.faces.get(index);
            if (Number(face.entityId) === Number(topologyId)) return item.view.high.faces.versionIds[index];
          }
          return null;
        };
        return {
          reference,
          item,
          bodyVersionId: args.bodyVersions.find(candidate => candidate.bodyId === reference.bodyId)?.versionId,
          modelBodyId: Number(item.model.Id()),
          entityId: Number(edge.entityId),
          edge,
          faceId,
        };
      });
      const factory = new Factory(this);
      factory.g0Tolerance = args.tolerances.positionMm / 1000;
      factory.g1ToleranceDegrees = args.tolerances.normalAngleDeg;
      factory.g2Tolerance = args.tolerances.relativeCurvature;
      factory.continuity = ContinuityType.G2;
      factory.edges = selected.map(candidate => candidate.edge);
      const measurements = await factory.calculate();
      const evaluated = await evalSurfaceContinuityMeasurements(measurements, [], this.analyzer, undefined, undefined);
      if (evaluated.measurements.length !== evaluated.views.length) {
        throw new Error('Plasticity continuity measurements and views are inconsistent');
      }
      const vectorMm = value => [Number(value.x) * 1000, Number(value.y) * 1000, Number(value.z) * 1000];
      const kernelEdges = new Map();
      return evaluated.measurements.map((measurement, index) => {
        const view = evaluated.views[index];
        const selectedEdge = selected.find(candidate =>
          candidate.modelBodyId === Number(measurement.referenceEdge?.bodyId)
          && candidate.entityId === Number(measurement.referenceEdge?.topologyId));
        if (!selectedEdge) throw new Error('Plasticity returned continuity data for an unexpected edge');
        const firstFaceId = selectedEdge.faceId(measurement.referenceFace?.topologyId);
        const secondFaceId = selectedEdge.faceId(measurement.targetFace?.topologyId);
        if (!firstFaceId || !secondFaceId) throw new Error('Plasticity returned an unknown adjacent face');
        const maximumPositionDeviationMm = Number(view.g0max) * 1000;
        const maximumNormalAngleDeviationDeg = Number(view.g1max) * 180 / Math.PI;
        const maximumRelativeCurvatureDeviation = Number(view.g2max);
        if (![maximumPositionDeviationMm, maximumNormalAngleDeviationDeg, maximumRelativeCurvatureDeviation].every(Number.isFinite)) {
          throw new Error('Plasticity returned a non-finite continuity deviation');
        }
        const G0 = maximumPositionDeviationMm <= args.tolerances.positionMm;
        const G1 = G0 && maximumNormalAngleDeviationDeg <= args.tolerances.normalAngleDeg;
        const G2 = G1 && maximumRelativeCurvatureDeviation <= args.tolerances.relativeCurvature;
        // Per-sample read-out (surfacing P5): g0spikes/g1spikes hold 100 x (point, deviation vector) and g2spikes 100 x
        // (point, spike vector, w); each sample's value is its vector length, and their maxima equal g0max/g1max/g2max
        // (live on 26.1.3: a crowned patch edge, plane-to-fillet edges, 90 degree box edges). interior is the
        // maximum over samples 5..94 (the 5 samples at each end are the corners). worstAt: where the first level that
        // fails its tolerance (G2 when all pass) has its maximum. Left out when the arrays are not 100 samples.
        const extra = (() => {
          const an = view.analysis;
          const g0s = an?.g0spikes, g1s = an?.g1spikes, g2s = an?.g2spikes;
          if (!g0s || !g1s || !g2s || g0s.length !== 600 || g1s.length !== 600 || g2s.length !== 700) return {};
          const len = (array, stride, i) => Math.hypot(array[stride * i + 3], array[stride * i + 4], array[stride * i + 5]);
          const series = [Array.from({ length: 100 }, (_, i) => len(g0s, 6, i)), Array.from({ length: 100 }, (_, i) => len(g1s, 6, i)), Array.from({ length: 100 }, (_, i) => len(g2s, 7, i))];
          if (!series.every(values => values.every(Number.isFinite))) return {};
          const interiorMax = values => Math.max(...values.slice(5, 95));
          const level = !G0 ? 0 : !G1 ? 1 : 2;
          const governing = series[level];
          const worstAt = Math.max(...governing) > interiorMax(governing) ? 'corner' : 'interior';
          const result = { interior: { g0Mm: interiorMax(series[0]) * 1000, g1Deg: interiorMax(series[1]) * 180 / Math.PI, g2Rel: interiorMax(series[2]) }, worstAt };
          // Absolute curvature across the edge at the worst G2 sample, from Face.EvalBasis (probe recipe), only where one
          // parameter direction runs along the edge and the other across it (within 1 degree), so the reported value is the
          // normal curvature across the edge on that face. Left out otherwise.
          try {
            const worst = series[2].indexOf(Math.max(...series[2]));
            // One kernel edge list per body (kernel wrappers are never freed, so they are not re-read per edge).
            const kernelEdge = selectedEdge.edge && (() => {
              kernelEdges.has(selectedEdge.item) || kernelEdges.set(selectedEdge.item, selectedEdge.item.model.GetEdges().GetEdges());
              return kernelEdges.get(selectedEdge.item).find(candidate => Number(candidate.Id()) === selectedEdge.entityId);
            })();
            if (!kernelEdge) return result;
            const sample = kernelEdge.GetPoint(0.5);
            const KernelVector = sample.constructor;
            const at = new KernelVector(Number(g2s[7 * worst]), Number(g2s[7 * worst + 1]), Number(g2s[7 * worst + 2]));
            const onEdge = kernelEdge.FindPointNear(at);
            const tangent = kernelEdge.GetPointAndTangent(onEdge.t).tangent;
            const t = [Number(tangent.x), Number(tangent.y), Number(tangent.z)];
            const tl = Math.hypot(...t);
            const faces = kernelEdge.GetFaces().GetFaces();
            const across = topologyId => {
              const face = faces.find(candidate => Number(candidate.Id()) === Number(topologyId));
              if (!face) return null;
              const near = face.FindPointNear(onEdge.exact);
              const basis = face.EvalBasis(near.u, near.v);
              const unit = v => { const a = [Number(v.x), Number(v.y), Number(v.z)]; const l = Math.hypot(...a); return l > 0 ? a.map(x => x / l) : null; };
              const u = unit(basis.uDirection), w = unit(basis.vDirection);
              if (!u || !w || !(tl > 0)) return null;
              const cosU = Math.abs(u[0] * t[0] + u[1] * t[1] + u[2] * t[2]) / tl, cosV = Math.abs(w[0] * t[0] + w[1] * t[1] + w[2] * t[2]) / tl;
              const along = Math.cos(Math.PI / 180), perpendicular = Math.sin(Math.PI / 180);
              // Magnitudes: the kernel's sign follows each surface's parametrisation, so signs are not comparable across faces.
              if (cosU >= along && cosV <= perpendicular) return Math.abs(Number(basis.vCurvature)) / 1000;
              if (cosV >= along && cosU <= perpendicular) return Math.abs(Number(basis.uCurvature)) / 1000;
              return null;
            };
            const side1 = across(measurement.referenceFace?.topologyId), side2 = across(measurement.targetFace?.topologyId);
            if (Number.isFinite(side1) && Number.isFinite(side2) && side1 !== null && side2 !== null) result.absoluteCurvature = { side1PerMm: side1, side2PerMm: side2 };
          } catch (error) { /* provable or omitted */ }
          return result;
        })();
        return {
          edge: selectedEdge.reference,
          adjacentFaces: [
            { bodyId: selectedEdge.reference.bodyId, faceId: firstFaceId },
            { bodyId: selectedEdge.reference.bodyId, faceId: secondFaceId },
          ],
          bodyVersionId: selectedEdge.bodyVersionId,
          measurementSource: 'native-brep-100-samples',
          sampleCount: Number(Refresh.Samples),
          maximumPositionDeviationMm,
          maximumPositionDeviationAtMm: vectorMm(view.g0maxBase),
          maximumNormalAngleDeviationDeg,
          maximumNormalAngleDeviationAtMm: vectorMm(view.g1maxBase),
          maximumRelativeCurvatureDeviation,
          maximumRelativeCurvatureDeviationAtMm: vectorMm(view.g2maxBase),
          tolerances: args.tolerances,
          passes: { G0, G1, G2 },
          achievedContinuity: G2 ? 'G2' : G1 ? 'G1' : G0 ? 'G0' : 'discontinuous',
          ...extra,
        };
      });
    }`, ["MeasureContinuityFactory", "ContinuityType", "evalSurfaceContinuityMeasurements", "EvalSurfaceContinuityMeasurements_refresh"], [{
      edges,
      tolerances,
      bodyVersions: [...bodyVersions].map(([bodyId, versionId]) => ({ bodyId, versionId })),
    }]);
    return { documentToken: state.documentToken, revision: state.revision, analyses };
  }

  // Surfacing reads (src/plasticity/surfacing.ts): exact ray hits on curved faces and exact NURBS extents. Read-only.
  async probeSurface(request: ProbeSurfaceRequest, revision: string): Promise<ProbeSurfaceEvidence> {
    const state = await this.assertRevision(revision);
    return await probeSurface(this.runtime, state, request);
  }

  async exactBounds(ids: number[], revision?: string): Promise<ExactBoundsEvidence> {
    const state = revision === undefined ? await this.state() : await this.assertRevision(revision);
    return await exactBounds(this.runtime, state, ids);
  }

  // describe_body's boundsExact per body. Bodies whose support evaluation fails are left out (the field is omitted).
  async describeBoundsExactness(bodies: RuntimeState["bodies"]): Promise<Map<number, { boundsExact: boolean; boundsNote?: string }>> {
    const result = new Map<number, { boundsExact: boolean; boundsNote?: string }>();
    const pending: RuntimeState["bodies"] = [];
    for (const body of bodies) {
      const known = boundsExactness(body);
      if (known) result.set(body.id, known);
      else if ((body.type === "Solid" || body.type === "Sheet") && body.boundsMm) pending.push(body);
    }
    if (pending.length === 0) return result;
    try {
      const native = await readSupportBounds(this.runtime, pending.map((body) => body.id));
      pending.forEach((body, index) => {
        try {
          const verdict = boundsExactness(body, supportBounds(native[index]!));
          if (verdict) result.set(body.id, verdict);
        } catch { /* provable or omitted */ }
      });
    } catch { /* provable or omitted */ }
    return result;
  }

  async listMeasurements(): Promise<{
    documentToken: string;
    revision: string;
    measurements: NonNullable<RuntimeState["measurements"]>;
  }> {
    const state = await this.state();
    return { documentToken: state.documentToken, revision: state.revision, measurements: state.measurements ?? [] };
  }

  async listSectionAnalyses(): Promise<{
    documentToken: string;
    revision: string;
    sectionAnalyses: NonNullable<RuntimeState["sectionAnalyses"]>;
  }> {
    const state = await this.state();
    return { documentToken: state.documentToken, revision: state.revision, sectionAnalyses: state.sectionAnalyses ?? [] };
  }

  async createSectionAnalysis(
    originMm: Vector3,
    normal: Vector3,
    xDirection: Vector3 | undefined,
    name: string | undefined,
    revision: string,
  ): Promise<RuntimeState> {
    const current = await this.assertRevision(revision);
    const unitNormal = normalize(normal, "Section analysis normal");
    const preferredX = xDirection ?? leastParallelWorldAxis(unitNormal);
    const frame = frameFromOriginNormalX(originMm, unitNormal, preferredX);
    if ((current.sectionAnalyses ?? []).length > 0) {
      throw new Error("Plasticity already has an active section analysis; delete it before creating another");
    }
    await this.runtime.mutate(`function (SectionAnalysisFactory, Vector3, Matrix4, args) {
      const viewports = Array.from(this.viewports ?? []);
      if (viewports.length === 0 || !this.shading) throw new Error('Plasticity does not expose a usable section-analysis viewport');
      if (this.shading.isSectioned) throw new Error('Plasticity already has an active section analysis; delete it before creating another');
      const section = new SectionAnalysisFactory(this).section;
      const point = new Vector3(...args.point);
      const normal = new Vector3(...args.normal).negate().normalize();
      section.position.copy(point);
      section.originalPosition.copy(point);
      section.plane.setFromNormalAndCoplanarPoint(normal, point);
      section.originalPlane.copy(section.plane);
      section.name = args.name ?? '';
      section.visible = true;
      section.helper.worldPosition.copy(point);
      if (args.xDirection) {
        const x = new Vector3(...args.xDirection).addScaledVector(normal, -new Vector3(...args.xDirection).dot(normal)).normalize();
        const y = new Vector3().crossVectors(normal, x).normalize();
        section.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(normal, x, y));
      }
      section.updateMatrixWorld(true);
      this.shading.section = section;
      for (const viewport of viewports) viewport.setNeedsRender();
      return section.versionId;
    }`, ["SectionAnalysisFactory", "Vector3", "Matrix4"], [{
      point: frame.originMm.map(millimetersToMeters),
      normal: frame.normal,
      xDirection: frame.xDirection,
      name: name ?? null,
    }]);
    return await this.state();
  }

  async deleteSectionAnalysis(id: number, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (!(state.sectionAnalyses ?? []).some((section) => section.id === id)) {
      throw new Error(`Unknown current section analysis ID: ${id}`);
    }
    await this.runtime.mutate(`function (args) {
      const active = this.shading?.section;
      if (!active || Number(active.versionId) !== args.id) throw new Error('Unknown active section analysis ID: ' + args.id);
      this.shading.section = null;
      for (const viewport of this.viewports ?? []) viewport.setNeedsRender();
    }`, [], [{ id }]);
    return await this.state();
  }

  // Clears the active section plane without needing its ID. Plasticity keeps one section plane, but the list
  // read is the authority: with nothing listed nothing runs and no revision changes.
  async deleteAllSectionAnalyses(revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if ((state.sectionAnalyses ?? []).length === 0) return state;
    await this.runtime.mutate(`function () {
      this.shading.section = null;
      for (const viewport of this.viewports ?? []) viewport.setNeedsRender();
    }`, [], []);
    return await this.state();
  }

  async createVertexDistanceMeasurement(
    first: VertexReference,
    second: VertexReference,
    name: string | undefined,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireVertexReference(state, first, "first");
    requireVertexReference(state, second, "second");
    if (first.bodyId === second.bodyId && first.vertexId === second.vertexId) {
      throw new Error("Distance measurement vertices must be different");
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      const editor = this;
      const wanted = new Map(args.vertices.map(reference => [reference.bodyId + ':' + reference.vertexId, reference]));
      const matches = new Map();
      for (const entry of nativeApi.pointSnapEntries()) {
        for (let index = 0; index < (entry.positions?.length ?? 0) / 3; index += 1) {
          const snap = entry.lookup(index);
          if (!['Snaps_ShellVertexSnap', 'ShellVertexSnap'].includes(snap?.constructor?.name)) continue;
          const bodyId = nativeApi.db.lookupStableId(snap.item?.versionId);
          const vertexId = snap.model?.Id?.();
          const key = bodyId + ':' + vertexId;
          if (wanted.has(key) && !matches.has(key)) matches.set(key, snap);
        }
      }
      const snaps = args.vertices.map(reference => matches.get(reference.bodyId + ':' + reference.vertexId));
      if (snaps.some(snap => !snap)) throw new Error('Plasticity vertex snaps are unavailable for the requested measurement');
      let failure;
      const command = new this.commands.MeasureDistanceCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor);
          factory.p1(snaps[0].position, snaps[0]);
          factory.p2(snaps[1].position, snaps[1]);
          const measurement = await factory.calculate();
          if (args.name) measurement.userData.name = args.name;
          await editor.measurements.update([measurement], [], []);
          for (const viewport of editor.viewports ?? []) viewport.setNeedsRender();
          return measurement;
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["PointToPointMeasurementFactory"], [{ vertices: [first, second], name: name ?? null }]);
    return await this.state();
  }

  async createTopologyDistanceMeasurement(
    first: TopologyMeasurementPointReference,
    second: TopologyMeasurementPointReference,
    name: string | undefined,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    for (const [index, reference] of [first, second].entries()) {
      const body = state.bodies.find((candidate) => candidate.id === reference.bodyId);
      if (!body || !["Solid", "Sheet"].includes(body.type)) {
        throw new Error(`Topology distance point ${index + 1} requires a current Solid or Sheet body: ${reference.bodyId}`);
      }
    }
    const measured = measurePointDistance(state, first, second, revision);
    if (measured.distanceMm <= 1e-9) throw new Error("Distance measurement topology points must be different");
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      const editor = this;
      const findItem = bodyId => {
        for (const [versionId, item] of nativeApi.geo.geometryModel) {
          if (nativeApi.db.lookupStableId(versionId) === bodyId) return item;
        }
        throw new Error('Unknown current body ID: ' + bodyId);
      };
      const entityId = (reference, item) => {
        if (reference.type === 'vertex') return reference.vertexId;
        const collection = reference.type === 'edge-midpoint' ? item.view?.high?.edges : item.view?.high?.faces;
        const stableId = reference.type === 'edge-midpoint' ? reference.edgeId : reference.faceId;
        const index = collection?.versionIds?.indexOf(stableId) ?? -1;
        if (index < 0) throw new Error('Stale or unknown topology reference: ' + stableId);
        return Number(collection.get(index).entityId);
      };
      const wanted = args.points.map(reference => {
        const item = findItem(reference.bodyId);
        return { reference, entityId: entityId(reference, item) };
      });
      const snaps = wanted.map(({ reference, entityId }) => {
        for (const entry of nativeApi.pointSnapEntries()) {
          for (let index = 0; index < (entry.positions?.length ?? 0) / 3; index += 1) {
            const candidate = entry.lookup(index);
            if (nativeApi.db.lookupStableId(candidate?.item?.versionId) !== reference.bodyId) continue;
            if (reference.type === 'vertex'
              && ['Snaps_ShellVertexSnap', 'ShellVertexSnap'].includes(candidate?.constructor?.name)
              && Number(candidate.model?.Id?.()) === entityId) return candidate;
            if (reference.type === 'edge-midpoint'
              && candidate?.constructor?.name === 'EdgePointSnap'
              && Number(candidate.model?.Id?.()) === entityId) return candidate;
            if (reference.type === 'face-center'
              && ['Snaps_FaceCenterPointSnap', 'FaceCenterPointSnap'].includes(candidate?.constructor?.name)
              && Number(candidate.faceSnap?.model?.Id?.()) === entityId) return candidate;
          }
        }
        throw new Error('Plasticity topology snap is unavailable for ' + reference.type + ' on body ' + reference.bodyId);
      });
      let failure;
      const command = new this.commands.MeasureDistanceCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor);
          factory.p1(snaps[0].position, snaps[0]);
          factory.p2(snaps[1].position, snaps[1]);
          const measurement = await factory.calculate();
          if (args.name) measurement.userData.name = args.name;
          await editor.measurements.update([measurement], [], []);
          for (const viewport of editor.viewports ?? []) viewport.setNeedsRender();
          return measurement;
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["PointToPointMeasurementFactory"], [{ points: [first, second], name: name ?? null }]);
    return await this.state();
  }

  async createRadiusMeasurement(
    edge: CurvatureEdgeReference,
    name: string | undefined,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    const body = state.bodies.find((candidate) => candidate.id === edge.bodyId);
    if (!body || !["Wire", "Solid", "Sheet"].includes(body.type)) {
      throw new Error(`Unknown current Wire, Solid, or Sheet body ID: ${edge.bodyId}`);
    }
    if (body.type === "Wire") {
      if (!("segmentEntityId" in edge)) {
        throw new Error(`Wire radius measurement ${edge.bodyId} requires a native segmentEntityId`);
      }
    } else {
      if (!("edgeId" in edge)) throw new Error(`Solid or Sheet radius measurement ${edge.bodyId} requires an edgeId`);
      const currentEdge = body.edges.find((candidate) => candidate.id === edge.edgeId);
      if (!currentEdge) throw new Error(`Unknown current edge ID ${edge.edgeId} on body ${edge.bodyId}`);
      if (!currentEdge.circle) throw new Error(`Radius measurement requires a circular edge: ${edge.bodyId}:${edge.edgeId}`);
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      const editor = this;
      let item;
      for (const [versionId, candidate] of nativeApi.geo.geometryModel) {
        if (nativeApi.db.lookupStableId(versionId) === args.edge.bodyId) { item = candidate; break; }
      }
      if (!item || !['Wire', 'Solid', 'Sheet'].includes(item.view?.constructor?.name)) {
        throw new Error('Unknown current Wire, Solid, or Sheet body ID: ' + args.edge.bodyId);
      }
      let entityId;
      let modelEdge;
      const modelEdges = item.model?.GetEdges?.();
      if (item.view.constructor.name === 'Wire') {
        if (!Number.isInteger(args.edge.segmentEntityId)) throw new Error('Wire radius measurement requires a native segmentEntityId');
        entityId = args.edge.segmentEntityId;
      } else {
        const edgeIndex = item.view.high.edges.versionIds.indexOf(args.edge.edgeId);
        if (edgeIndex < 0) throw new Error('Stale or unknown shell edge: ' + args.edge.edgeId);
        entityId = Number(item.view.high.edges.get(edgeIndex).entityId);
      }
      for (let index = 0; index < (modelEdges?.Size?.() ?? 0); index += 1) {
        const candidate = modelEdges.Get(index);
        if (Number(candidate.Id()) === entityId) { modelEdge = candidate; break; }
      }
      if (!modelEdge) throw new Error('Stale or unknown native edge: ' + args.edge.bodyId + ':' + entityId);
      if (!modelEdge.IsCircle()) throw new Error('Radius measurement requires a circular edge');
      const snap = nativeApi.findRadiusSnap(item, args.edge.bodyId, entityId);
      if (!snap) throw new Error('Plasticity circular-edge snap is unavailable for the requested radius measurement');
      let failure;
      const command = new this.commands.MeasureRadiusCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor);
          factory.snap = snap;
          const measurement = await factory.calculate();
          if (args.name) measurement.userData.name = args.name;
          await editor.measurements.update([measurement], [], []);
          for (const viewport of editor.viewports ?? []) viewport.setNeedsRender();
          return measurement;
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["RadialMeasurementFactory"], [{ edge, name: name ?? null }]);
    return await this.state();
  }

  async deleteMeasurement(id: number, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (!(state.measurements ?? []).some((measurement) => measurement.id === id)) {
      throw new Error(`Unknown current measurement ID: ${id}`);
    }
    await this.runtime.mutate(nativeFunction`async function (RemoveMeasurementCommand, args) {
      const measurement = this.measurements.lookupByStableId(args.id);
      if (!measurement) throw new Error('Unknown measurement ID: ' + args.id);
      this.selection.selected.removeAll();
      nativeApi.selection.addMeasurement(measurement);
      let failure;
      const command = new RemoveMeasurementCommand(this);
      command.remember = false;
      const execute = command.execute.bind(command);
      command.execute = async function () {
        try { return await execute(); }
        catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
      for (const viewport of this.viewports ?? []) viewport.setNeedsRender();
    }`, ["RemoveMeasurementCommand"], [{ id }]);
    return await this.state();
  }

  // Moves the dimension line and label of one distance measurement (FINDINGS gap 4). The offset is in the
  // measurement's local frame as listMeasurements reports it: x along `direction`, y along `normal x direction`,
  // both measured from the first point. MoveMeasurementFactory takes the same offset as a world point.
  async moveMeasurementLabel(id: number, offsetMm: [number, number], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    const measurement = (state.measurements ?? []).find((candidate) => candidate.id === id);
    if (!measurement) throw new Error(`Unknown current measurement ID: ${id}`);
    if (offsetMm.length !== 2 || offsetMm.some((value) => !Number.isFinite(value))) throw new Error("Measurement label offset must be two finite millimeter values");
    const start = measurement.first?.positionMm;
    const end = measurement.second?.positionMm;
    if (measurement.type !== "DistanceMeasurement" || !start || !end || !measurement.direction || !measurement.normal) {
      throw new Error(`Label move requires a distance measurement with resolved endpoints: ${id}`);
    }
    const direction = normalize(measurement.direction, "Measurement direction");
    const across = normalize(cross(measurement.normal, direction), "Measurement label axis");
    const startMeters = toMeters(start);
    const offsetWorld = [0, 1, 2].map((axis) =>
      startMeters[axis]! + millimetersToMeters(offsetMm[0]) * direction[axis]! + millimetersToMeters(offsetMm[1]) * across[axis]!) as Vector3;
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const measurement = this.measurements.lookupByStableId(args.id);
      if (!measurement) throw new Error('Unknown measurement ID: ' + args.id);
      this.selection.selected.removeAll();
      nativeApi.selection.addMeasurement(measurement);
      let failure;
      try {
        const command = new Command(editor);
        command.remember = false;
        command.execute = async function () {
          try {
            const factory = new Factory(editor).resource(this);
            factory.measurement = measurement;
            factory.start.fromArray(args.start);
            factory.end.fromArray(args.end);
            factory.direction.fromArray(args.direction);
            factory.offset.fromArray(args.offset);
            ${commandEndPreservingMeasurementNames}
      } finally {
        this.selection.selected.removeAll();
      }
    }`, ["MoveMeasurementFactory", "MoveMeasurementCommand"], [{
      id,
      start: startMeters,
      end: toMeters(end),
      direction,
      offset: offsetWorld,
    }]);
    return await this.state();
  }

  async listInstances(): Promise<{
    documentToken: string;
    revision: string;
    instances: NonNullable<RuntimeState["instances"]>;
  }> {
    const state = await this.state();
    return { documentToken: state.documentToken, revision: state.revision, instances: state.instances ?? [] };
  }

  async createInstance(bodyId: number, translationMm: Vector3, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (!state.bodies.some((body) => body.id === bodyId)) throw new Error(`Unknown current body ID: ${bodyId}`);
    await this.runtime.mutate(nativeFunction`async function (CreateFactory, MoveFactory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const create = new CreateFactory(editor).resource(this);
          create.items = [find(args.bodyId)];
          const result = await create.commit();
          const created = Array.isArray(result) ? result : [result].filter(Boolean);
          if (created.length !== 1 || created[0]?.constructor?.name !== 'InstanceEmpty') {
            throw new Error('Plasticity did not create exactly one native instance');
          }
          if (args.translation.some(value => value !== 0)) {
            const move = new MoveFactory(editor).resource(this);
            move.empties = created;
            move.move.fromArray(args.translation);
            await move.commit();
          }
          return created;
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["CreateInstanceFactory", "MoveItemAndEmptyFactory"], [{ bodyId, translation: toMeters(translationMm) }]);
    return await this.state();
  }

  // A linked instance mirrored across a world plane normal to one axis (scale -1 on that axis about the plane).
  // Source-body edits keep propagating; realize it before booleans or joins.
  async createMirroredInstance(bodyId: number, axis: "x" | "y" | "z", planeOffsetMm: number, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (!state.bodies.some((body) => body.id === bodyId)) throw new Error(`Unknown current body ID: ${bodyId}`);
    if (!Number.isFinite(planeOffsetMm)) throw new Error("Mirror plane offset must be finite");
    const index = { x: 0, y: 1, z: 2 }[axis];
    const pivot: Vector3 = [0, 0, 0];
    pivot[index] = planeOffsetMm / 1000;
    const factors: Vector3 = [1, 1, 1];
    factors[index] = -1;
    await this.runtime.mutate(nativeFunction`async function (CreateFactory, ScaleFactory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const create = new CreateFactory(editor).resource(this);
          create.items = [find(args.bodyId)];
          const result = await create.commit();
          const created = Array.isArray(result) ? result : [result].filter(Boolean);
          if (created.length !== 1 || created[0]?.constructor?.name !== 'InstanceEmpty') {
            throw new Error('Plasticity did not create exactly one native instance');
          }
          const scale = new ScaleFactory(editor).resource(this);
          scale.empties = created;
          scale.pivot.fromArray(args.pivot);
          scale.scale.fromArray(args.factors);
          await scale.commit();
          return created;
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["CreateInstanceFactory", "ProjectingScaleItemAndEmptyFactory"], [{ bodyId, pivot, factors }]);
    return await this.state();
  }

  async duplicateBodies(ids: number[], translationMm: Vector3, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0 || new Set(ids).size !== ids.length) {
      throw new Error("Body IDs must be a nonempty unique list");
    }
    const current = new Map(state.bodies.map((body) => [body.id, body]));
    const missing = ids.filter((id) => !current.has(id));
    if (missing.length > 0) throw new Error(`Unknown current body IDs: ${missing.join(", ")}`);
    const invalid = ids.filter((id) => !["Solid", "Sheet"].includes(current.get(id)!.type));
    if (invalid.length > 0) throw new Error(`Body duplication requires current Solid or Sheet bodies: ${invalid.join(", ")}`);
    const translation = toMeters(translationMm);
    await this.runtime.mutate(nativeFunction`async function (CreateFactory, MoveFactory, RealizeFactory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const create = new CreateFactory(editor).resource(this);
          create.items = args.ids.map(find);
          const result = await create.commit();
          const created = Array.isArray(result) ? result : [result].filter(Boolean);
          if (created.length === 0 || !created.every(item => item?.constructor?.name === 'InstanceEmpty')) {
            throw new Error('Plasticity did not create native instances for the complete body selection');
          }
          if (args.translation.some(value => value !== 0)) {
            const move = new MoveFactory(editor).resource(this);
            move.empties = created;
            move.move.fromArray(args.translation);
            await move.commit();
          }
          const realize = new RealizeFactory(editor).resource(this);
          realize.empties = created;
          return await realize.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["CreateInstanceFactory", "MoveItemAndEmptyFactory", "RealizeInstanceFactory"], [{ ids, translation }]);
    return await this.state();
  }

  async moveInstances(ids: number[], deltaMm: Vector3, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireInstanceIds(state, ids);
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findWritableInstanceEmpty}
      ${commandStart("MoveItemCommand")}
      factory.empties = args.ids.map(find);
      factory.move.fromArray(args.delta);
      ${commandEnd}
    }`, ["MoveItemAndEmptyFactory"], [{ ids, delta: toMeters(deltaMm) }]);
    return await this.state();
  }

  async rotateInstances(ids: number[], pivotMm: Vector3, axis: Vector3, degrees: number, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireInstanceIds(state, ids);
    await this.runtime.mutate(nativeFunction`async function (Factory, Vector, Quaternion, args) {
      ${findWritableInstanceEmpty}
      ${commandStart("RotateItemCommand")}
      factory.empties = args.ids.map(find);
      factory.pivot.fromArray(args.pivot);
      factory.rotation.copy(new Quaternion().setFromAxisAngle(new Vector(...args.axis).normalize(), args.radians));
      ${commandEnd}
    }`, ["RotateItemAndEmptyFactory", "Vector3", "Quaternion"], [{ ids, pivot: toMeters(pivotMm), axis, radians: degreesToRadians(degrees) }]);
    return await this.state();
  }

  async scaleInstances(ids: number[], pivotMm: Vector3, factors: Vector3, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireInstanceIds(state, ids);
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findWritableInstanceEmpty}
      ${commandStart("ScaleItemCommand")}
      factory.empties = args.ids.map(find);
      factory.pivot.fromArray(args.pivot);
      factory.scale.fromArray(args.factors);
      ${commandEnd}
    }`, ["ProjectingScaleItemAndEmptyFactory"], [{ ids, pivot: toMeters(pivotMm), factors }]);
    return await this.state();
  }

  async realizeInstances(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireInstanceIds(state, ids);
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      const find = id => {
        const empty = nativeApi.db.lookupEmptyById(id);
        if (empty?.constructor?.name !== 'InstanceEmpty') throw new Error('Unknown native instance ID: ' + id);
        return empty;
      };
      ${commandStart("GroupSelectedCommand")}
      factory.empties = args.ids.map(find);
      ${commandEnd}
    }`, ["RealizeInstanceFactory"], [{ ids }]);
    return await this.state();
  }

  async deleteInstances(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireInstanceIds(state, ids);
    await this.runtime.mutate(nativeFunction`async function (args) {
      const find = id => {
        const empty = nativeApi.db.lookupEmptyById(id);
        if (empty?.constructor?.name !== 'InstanceEmpty') throw new Error('Unknown native instance ID: ' + id);
        return empty;
      };
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      this.selection.selected.removeAll();
      for (const empty of args.ids.map(find)) nativeApi.selection.addEmpty(empty);
      const command = new this.commands.DeleteCommand(this);
      command.remember = false;
      let failure;
      const execute = command.execute.bind(command);
      command.execute = async function () {
        try { return await execute(); }
        catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, [], [{ ids }]);
    return await this.state();
  }

  async listReferenceMeshes(): Promise<{
    documentToken: string;
    revision: string;
    referenceMeshes: NonNullable<RuntimeState["referenceMeshes"]>;
  }> {
    const state = await this.state();
    return {
      documentToken: state.documentToken,
      revision: state.revision,
      referenceMeshes: state.referenceMeshes ?? [],
    };
  }

  async moveReferenceMeshes(ids: number[], deltaMm: Vector3, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireReferenceMeshIds(state, ids);
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      const find = id => {
        const empty = nativeApi.db.lookupEmptyById(id);
        if (!nativeApi.isReferenceMesh(empty)) throw new Error('Unknown native reference mesh ID: ' + id);
        return empty;
      };
      ${commandStart("MoveItemCommand")}
      factory.empties = args.ids.map(find);
      factory.move.fromArray(args.delta);
      ${commandEnd}
    }`, ["MoveItemAndEmptyFactory"], [{ ids, delta: toMeters(deltaMm) }]);
    return await this.state();
  }

  async rotateReferenceMeshes(ids: number[], pivotMm: Vector3, axis: Vector3, degrees: number, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireReferenceMeshIds(state, ids);
    const unitAxis = normalize(axis, "Reference mesh rotation axis");
    await this.runtime.mutate(nativeFunction`async function (Factory, Vector, Quaternion, args) {
      const find = id => {
        const empty = nativeApi.db.lookupEmptyById(id);
        if (!nativeApi.isReferenceMesh(empty)) throw new Error('Unknown native reference mesh ID: ' + id);
        return empty;
      };
      ${commandStart("RotateItemCommand")}
      factory.empties = args.ids.map(find);
      factory.pivot.fromArray(args.pivot);
      factory.rotation.copy(new Quaternion().setFromAxisAngle(new Vector(...args.axis), args.radians));
      ${commandEnd}
    }`, ["RotateItemAndEmptyFactory", "Vector3", "Quaternion"], [{ ids, pivot: toMeters(pivotMm), axis: unitAxis, radians: degreesToRadians(degrees) }]);
    return await this.state();
  }

  async scaleReferenceMeshes(ids: number[], pivotMm: Vector3, factors: Vector3, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireReferenceMeshIds(state, ids);
    if (factors.some((factor) => !Number.isFinite(factor) || factor <= 0)) {
      throw new Error("Reference mesh scale factors must be positive finite values");
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      const find = id => {
        const empty = nativeApi.db.lookupEmptyById(id);
        if (!nativeApi.isReferenceMesh(empty)) throw new Error('Unknown native reference mesh ID: ' + id);
        return empty;
      };
      ${commandStart("ScaleItemCommand")}
      factory.empties = args.ids.map(find);
      factory.pivot.fromArray(args.pivot);
      factory.scale.fromArray(args.factors);
      ${commandEnd}
    }`, ["ProjectingScaleItemAndEmptyFactory"], [{ ids, pivot: toMeters(pivotMm), factors }]);
    return await this.state();
  }

  async deleteReferenceMeshes(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireReferenceMeshIds(state, ids);
    await this.runtime.mutate(nativeFunction`async function (args) {
      const find = id => {
        const empty = nativeApi.db.lookupEmptyById(id);
        if (!nativeApi.isReferenceMesh(empty)) throw new Error('Unknown native reference mesh ID: ' + id);
        return empty;
      };
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      this.selection.selected.removeAll();
      for (const empty of args.ids.map(find)) nativeApi.selection.addEmpty(empty);
      const command = new this.commands.DeleteCommand(this);
      command.remember = false;
      let failure;
      const execute = command.execute.bind(command);
      command.execute = async function () {
        try { return await execute(); }
        catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, [], [{ ids }]);
    return await this.state();
  }

  async renameReferenceMesh(id: number, name: string, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireReferenceMeshIds(state, [id]);
    await this.runtime.mutate(nativeFunction`async function (args) {
      const empty = nativeApi.db.lookupEmptyById(args.id);
      if (!nativeApi.isReferenceMesh(empty)) throw new Error('Unknown native reference mesh ID: ' + args.id);
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      this.selection.selected.removeAll();
      const editor = this;
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try { nativeApi.db.nodes.setName(nativeApi.db.nodes.item2key(empty), args.name); }
        catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, [], [{ id, name }]);
    return await this.state();
  }

  async listGroups(): Promise<{
    documentToken: string;
    revision: string;
    activeGroupId: number;
    groups: NonNullable<RuntimeState["groups"]>;
  }> {
    const state = await this.state();
    return {
      documentToken: state.documentToken,
      revision: state.revision,
      activeGroupId: state.activeGroupId ?? 0,
      groups: state.groups ?? [],
    };
  }

  async createGroup(
    bodyIds: number[],
    instanceIds: number[],
    referenceMeshIds: number[],
    groupIds: number[],
    name: string | undefined,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireGroupSelection(state, bodyIds, instanceIds, referenceMeshIds, groupIds);
    await this.runtime.mutate(nativeFunction`async function (args) {
      ${findView}
      const findEmpty = id => {
        const empty = nativeApi.db.lookupEmptyById(id);
        if (empty?.constructor?.name !== 'InstanceEmpty') throw new Error('Unknown native instance ID: ' + id);
        return empty;
      };
      const findReferenceMesh = id => {
        const empty = nativeApi.db.lookupEmptyById(id);
        if (!nativeApi.isReferenceMesh(empty)) throw new Error('Unknown native reference mesh ID: ' + id);
        return empty;
      };
      const findGroup = id => {
        const group = nativeApi.db.groups.lookupById(id);
        if (!group || id === 0) throw new Error('Unknown or protected group ID: ' + id);
        return group;
      };
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      this.selection.selected.removeAll();
      for (const view of args.bodyIds.map(find)) this.selection.selected.add(view);
      for (const empty of args.instanceIds.map(findEmpty)) nativeApi.selection.addEmpty(empty);
      for (const empty of args.referenceMeshIds.map(findReferenceMesh)) nativeApi.selection.addEmpty(empty);
      for (const group of args.groupIds.map(findGroup)) nativeApi.selection.addGroup(group);
      const editor = this;
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      const execute = command.execute.bind(command);
      command.execute = async function () {
        try {
          const result = await execute();
          const selected = Array.from(editor.selection.selected.groups);
          if (selected.length !== 1) throw new Error('Plasticity did not create exactly one group');
          if (args.name) nativeApi.db.nodes.setName(nativeApi.db.nodes.item2key(selected[0]), args.name);
          return result;
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, [], [{ bodyIds, instanceIds, referenceMeshIds, groupIds, name: name ?? null }]);
    return await this.state();
  }

  async moveToGroup(
    bodyIds: number[],
    instanceIds: number[],
    referenceMeshIds: number[],
    groupIds: number[],
    destinationGroupId: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireGroupSelection(state, bodyIds, instanceIds, referenceMeshIds, groupIds);
    requireGroupIds(state, [destinationGroupId], true);
    for (const groupId of groupIds) {
      if (groupId === destinationGroupId || groupContains(state, groupId, destinationGroupId)) {
        throw new Error(`Moving group ${groupId} to ${destinationGroupId} would create a group cycle`);
      }
    }
    await this.runtime.mutate(nativeFunction`async function (Command, args) {
      ${findView}
      const findEmpty = id => {
        const empty = nativeApi.db.lookupEmptyById(id);
        if (empty?.constructor?.name !== 'InstanceEmpty') throw new Error('Unknown native instance ID: ' + id);
        return empty;
      };
      const findReferenceMesh = id => {
        const empty = nativeApi.db.lookupEmptyById(id);
        if (!nativeApi.isReferenceMesh(empty)) throw new Error('Unknown native reference mesh ID: ' + id);
        return empty;
      };
      const findGroup = id => {
        const group = nativeApi.db.groups.lookupById(id);
        if (!group) throw new Error('Unknown group ID: ' + id);
        return group;
      };
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this, findGroup(args.destinationGroupId));
      command.remember = false;
      const execute = command.execute.bind(command);
      command.execute = async function () {
        try {
          editor.selection.selected.removeAll();
          for (const view of args.bodyIds.map(find)) editor.selection.selected.add(view);
          for (const empty of args.instanceIds.map(findEmpty)) nativeApi.selection.addEmpty(empty);
          for (const empty of args.referenceMeshIds.map(findReferenceMesh)) nativeApi.selection.addEmpty(empty);
          for (const group of args.groupIds.map(findGroup)) nativeApi.selection.addGroup(group);
          const result = await execute();
          nativeApi.completeGroupMove(args.referenceMeshIds.length);
          return result;
        }
        catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["MoveSelectionToGroupCommand"], [{ bodyIds, instanceIds, referenceMeshIds, groupIds, destinationGroupId }]);
    return await this.state();
  }

  async renameGroup(id: number, name: string, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireGroupIds(state, [id], false);
    await this.runtime.mutate(nativeFunction`async function (args) {
      const group = nativeApi.db.groups.lookupById(args.id);
      if (!group || args.id === 0) throw new Error('Unknown or protected group ID: ' + args.id);
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      this.selection.selected.removeAll();
      const editor = this;
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try { nativeApi.db.nodes.setName(nativeApi.db.nodes.item2key(group), args.name); }
        catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, [], [{ id, name }]);
    return await this.state();
  }

  async activateGroup(id: number, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireGroupIds(state, [id], true);
    await this.runtime.mutate(nativeFunction`async function (Command, args) {
      const group = nativeApi.db.groups.lookupById(args.id);
      if (!group) throw new Error('Unknown group ID: ' + args.id);
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      let failure;
      const command = new Command(this, group);
      command.remember = false;
      const execute = command.execute.bind(command);
      command.execute = async function () {
        try { return await execute(); }
        catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["ActivateGroupCommand"], [{ id }]);
    return await this.state();
  }

  async dissolveGroups(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireGroupIds(state, ids, false);
    await this.runtime.mutate(nativeFunction`async function (Command, args) {
      const find = id => {
        const group = nativeApi.db.groups.lookupById(id);
        if (!group || id === 0) throw new Error('Unknown or protected group ID: ' + id);
        return group;
      };
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      this.selection.selected.removeAll();
      for (const group of args.ids.map(find)) nativeApi.selection.addGroup(group);
      let failure;
      const command = new Command(this);
      command.remember = false;
      const execute = command.execute.bind(command);
      command.execute = async function () {
        try { return await execute(); }
        catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["DissolveGroupCommand"], [{ ids }]);
    return await this.state();
  }

  async setNodeVisibility(
    bodyIds: number[],
    instanceIds: number[],
    referenceMeshIds: number[],
    groupIds: number[],
    visible: boolean,
    revision: string,
  ): Promise<RuntimeState> {
    return await this.setNodeFlag("visibility", bodyIds, instanceIds, referenceMeshIds, groupIds, visible, revision);
  }

  async setNodeLocked(
    bodyIds: number[],
    instanceIds: number[],
    referenceMeshIds: number[],
    groupIds: number[],
    locked: boolean,
    revision: string,
  ): Promise<RuntimeState> {
    return await this.setNodeFlag("locked", bodyIds, instanceIds, referenceMeshIds, groupIds, locked, revision);
  }

  private async setNodeFlag(
    flag: "visibility" | "locked",
    bodyIds: number[],
    instanceIds: number[],
    referenceMeshIds: number[],
    groupIds: number[],
    value: boolean,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireGroupSelection(state, bodyIds, instanceIds, referenceMeshIds, groupIds, true);
    await this.runtime.mutate(nativeFunction`async function (args) {
      ${findView}
      const findEmpty = id => {
        const empty = nativeApi.db.lookupEmptyById(id);
        if (empty?.constructor?.name !== 'InstanceEmpty') throw new Error('Unknown native instance ID: ' + id);
        return empty;
      };
      const findReferenceMesh = id => {
        const empty = nativeApi.db.lookupEmptyById(id);
        if (!nativeApi.isReferenceMesh(empty)) throw new Error('Unknown native reference mesh ID: ' + id);
        return empty;
      };
      const findGroup = id => {
        const group = nativeApi.db.groups.lookupById(id);
        if (!group) throw new Error('Unknown group ID: ' + id);
        return group;
      };
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const items = [
        ...args.bodyIds.map(find),
        ...args.instanceIds.map(findEmpty),
        ...args.referenceMeshIds.map(findReferenceMesh),
        ...args.groupIds.map(findGroup),
      ];
      this.selection.selected.removeAll();
      const editor = this;
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          // Like the outliner's ToggleVisibilityCommand, commit a database transaction: its pipeline
          // updates the node flags, the scene cache and the render list, and builds GPU meshes for
          // bodies that were hidden since load. Writing the node flags directly skips all of that.
          const transaction = nativeApi.db.makeTransaction();
          for (const item of items) {
            if (args.flag === 'visibility') {
              if (args.value) transaction.makeVisible(item);
              else transaction.makeInvisible(item);
            } else if (args.value) transaction.lock(item);
            else transaction.unlock(item);
          }
          await nativeApi.db.commit(transaction);
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, [], [{ flag, bodyIds, instanceIds, referenceMeshIds, groupIds, value }]);
    return await this.state();
  }

  async inspectRectangularMember(request: MemberRequest): Promise<MemberEvidence> {
    return await inspectRectangularMember(this.runtime, request, this.datumRegistry.sessionId);
  }

  async inspectPlanarSection(request: SectionRequest): Promise<SectionEvidence> {
    return await inspectPlanarSection(this.runtime, request, this.datumRegistry.sessionId);
  }

  async inspectArbitrarySection(request: ArbitrarySectionRequest): Promise<ArbitrarySectionEvidence> {
    return await inspectArbitrarySection(this.runtime, request, this.datumRegistry.sessionId);
  }

  async checkInterference(pairs: BodyInterferencePair[], revision: string): Promise<BodyInterferenceEvidence> {
    return await checkBodyInterference(this.runtime, pairs, revision, this.datumRegistry.sessionId);
  }

  async measureSolidProperties(ids: number[], revision: string): Promise<SolidPropertiesEvidence> {
    return await measureSolidProperties(this.runtime, ids, revision, this.datumRegistry.sessionId);
  }

  async measureFaceProperties(faces: FaceReference[], revision: string): Promise<FacePropertiesEvidence> {
    // In a batch, the probed state() replaces two full reads; direct calls read exactly as before.
    return await measureFaceProperties(this.runtime, faces, revision, this.datumRegistry.sessionId, this.stateReuse ? () => this.state() : undefined);
  }

  async inspectSingleFastenerPlate(request: FastenerPlateRequest): Promise<FastenerPlateEvidence> {
    return await inspectSingleFastenerPlate(this.runtime, request, this.datumRegistry.sessionId);
  }

  async inspectIntegralRectangularPlate(request: IntegralPlateRequest): Promise<IntegralPlateEvidence> {
    return await inspectIntegralRectangularPlate(this.runtime, request, this.datumRegistry.sessionId);
  }

  async inspectFastenerGroup(request: FastenerGroupGeometryRequest): Promise<FastenerGroupGeometryEvidence> {
    return await inspectFastenerGroupGeometry(this.runtime, request, this.datumRegistry.sessionId);
  }

  async inspectFastenerGroupLayout(request: FastenerGroupLayoutRequest): Promise<FastenerGroupLayoutEvidence> {
    return await inspectFastenerGroupLayout(this.runtime, request, this.datumRegistry.sessionId);
  }

  constructionCapabilities(): ReturnType<ConstructionGeometry["capabilities"]> {
    return this.constructionGeometry.capabilities();
  }

  async defineDatumPoint(definition: PointDefinition, revision: string): Promise<DatumPointRef> {
    const state = await this.syncConstructionState(revision);
    return this.datumRegistry.addPoint(definition, requireResolution(resolvePoint(state, definition)));
  }

  async defineDatumAxis(definition: AxisDefinition, revision: string): Promise<DatumAxisRef> {
    const state = await this.syncConstructionState(revision);
    return this.datumRegistry.addAxis(definition, requireResolution(resolveAxis(state, definition, this.datumRegistry)));
  }

  async createConstructionPlane(
    definition: PlaneDefinition,
    name: string | undefined,
    revision: string,
  ): Promise<ConstructionPlaneRef> {
    const state = await this.syncConstructionState(revision);
    const frame = requireResolution(resolvePlaneFrame(state, definition, this.datumRegistry));
    const created = await this.constructionGeometry.createPlane(frame, name, revision);
    this.syncRegistry(created.state);
    return this.datumRegistry.putPlane(created.plane, definition);
  }

  async listConstructionGeometry(): Promise<{
    points: DatumPointRef[];
    axes: DatumAxisRef[];
    planes: ConstructionPlaneRef[];
    activePlaneId: string | null;
    activePlane: ConstructionPlaneRef | null;
  }> {
    const state = await this.state();
    this.syncRegistry(state);
    const activePlane = state.construction.activePlaneId === null
      ? null
      : this.datumRegistry.listPlanes().find((plane) => plane.id === state.construction.activePlaneId) ?? null;
    return {
      points: this.datumRegistry.listPoints(),
      axes: this.datumRegistry.listAxes(),
      planes: this.datumRegistry.listPlanes(),
      activePlaneId: state.construction.activePlaneId,
      activePlane,
    };
  }

  async setConstructionWorkplane(identity: ReferenceIdentity): Promise<RuntimeState> {
    const state = await this.syncConstructionState(identity.revision);
    const plane = this.datumRegistry.requireCurrentPlane(identity, state.documentToken, state.revision);
    const after = await this.constructionGeometry.setWorkplane(plane);
    this.syncRegistry(after);
    return after;
  }

  async removeConstructionPlane(identity: ReferenceIdentity): Promise<RuntimeState> {
    const state = await this.syncConstructionState(identity.revision);
    const plane = this.datumRegistry.requireCurrentPlane(identity, state.documentToken, state.revision);
    if (plane.source === "standard") throw new Error("Standard construction planes cannot be removed");
    const after = await this.constructionGeometry.removePlane(plane.nativeId, state.revision);
    this.datumRegistry.deletePlane(plane.id);
    this.syncRegistry(after);
    return after;
  }

  async refreshDatum(identity: ReferenceIdentity): Promise<DatumPointRef | DatumAxisRef> {
    const state = await this.state();
    this.syncRegistry(state);
    const prior = this.datumRegistry.get(identity.id);
    assertRefreshIdentity(prior, identity, this.datumRegistry.sessionId, state.documentToken);
    if (prior.kind === "datum-point") {
      return this.datumRegistry.refreshPoint(prior.id, requireResolution(resolvePoint(state, prior.definition)));
    }
    if (prior.kind === "datum-axis") {
      return this.datumRegistry.refreshAxis(prior.id, requireResolution(resolveAxis(state, prior.definition, this.datumRegistry, true)));
    }
    throw new Error("Construction planes are synchronized from Plasticity and cannot be refreshed as datums");
  }

  private async syncConstructionState(expectedRevision?: string): Promise<RuntimeState> {
    const state = await this.state();
    if (expectedRevision !== undefined && state.revision !== expectedRevision) {
      throw new Error(`Stale reference: expected revision ${expectedRevision}, current revision is ${state.revision}`);
    }
    this.syncRegistry(state);
    return state;
  }

  private syncRegistry(state: RuntimeState): void {
    this.datumRegistry.sync(state);
    this.datumRegistry.syncPlanes(state.construction.planes);
  }

  private async resolveCurrentPlane(identity: ReferenceIdentity, revision?: string): Promise<ConstructionPlaneRef> {
    const state = await this.syncConstructionState(revision ?? identity.revision);
    return this.datumRegistry.requireCurrentPlane(identity, state.documentToken, state.revision);
  }

  async selection(): Promise<PlasticitySelection> {
    const state = await this.state();
    const selected = await this.runtime.read<Omit<PlasticitySelection, "documentToken" | "revision">>(nativeFunction`function () {
      const selection = this.selection.selected;
      const stableId = view => {
        const versionId = view?.parentItem?.versionId ?? view?.versionId;
        return versionId === undefined ? null : (nativeApi.db.lookupStableId(versionId) ?? null);
      };
      return {
        bodyIds: Array.from(selection.items ?? []).map(stableId).filter(Number.isInteger),
        curveIds: Array.from(selection.curveIds ?? []).map(Number).filter(Number.isInteger),
        instanceIds: Array.from(selection.empties ?? [])
          .filter(empty => empty?.constructor?.name === 'InstanceEmpty')
          .map(empty => Number(empty.versionId))
          .filter(Number.isInteger),
        referenceMeshIds: Array.from(selection.empties ?? [])
          .filter(empty => nativeApi.isReferenceMesh(empty))
          .map(empty => Number(empty.versionId))
          .filter(Number.isInteger),
        groupIds: Array.from(selection.groups ?? [])
          .map(group => Number(group.versionId))
          .filter(Number.isInteger),
        faces: Array.from(selection.faces ?? []).map(face => ({ bodyId: stableId(face), faceId: String(face.versionId) })),
        edges: Array.from(selection.edges ?? []).map(edge => ({ bodyId: stableId(edge), edgeId: String(edge.versionId) })),
        regionIds: Array.from(selection.regionIds ?? []).map(String),
        curveControlPoints: [
          ...Array.from(selection.curveVertices ?? []).map(vertex => ({ bodyId: stableId(vertex), kind: 'vertex', pointId: Number(vertex.id) })),
          ...Array.from(selection.curveCVs ?? []).map(controlPoint => ({ bodyId: stableId(controlPoint), kind: 'control-point', pointId: Number(controlPoint.id) })),
        ].filter(reference => Number.isInteger(reference.bodyId) && Number.isInteger(reference.pointId)),
      };
    }`);
    return { documentToken: state.documentToken, revision: state.revision, ...selected };
  }

  async listRegions(): Promise<{
    documentToken: string;
    revision: string;
    regions: RuntimeState["regions"];
  }> {
    const state = await this.state();
    return { documentToken: state.documentToken, revision: state.revision, regions: state.regions };
  }

  async listCurveFragments(): Promise<{
    documentToken: string;
    revision: string;
    fragments: CurveFragmentDescriptor[];
  }> {
    const before = await this.state();
    const fragments = await this.runtime.read<CurveFragmentDescriptor[]>(nativeFunction`function () {
      const mm = value => value * 1000;
      const vector = value => [mm(value.x), mm(value.y), mm(value.z)];
      const result = [];
      for (const info of this.fragments.read.modelId2info.values()) {
        const bodyId = nativeApi.db.lookupStableId(info.ancestorViewId);
        const fragmentItem = nativeApi.geo.geometryModel.get(info.fragmentViewId);
        if (!Number.isInteger(bodyId) || !fragmentItem) continue;
        for (const segment of Array.from(fragmentItem.view?.segments ?? [])) {
          const edge = nativeApi.db.lookupTopologyItem(segment);
          const start = edge.GetPointAndTangent(0);
          const midpoint = edge.GetPointAndTangent(0.5);
          const end = edge.GetPointAndTangent(1);
          result.push({
            id: String(segment.versionId),
            bodyId,
            ancestorVersionId: info.ancestorViewId,
            fragmentViewId: info.fragmentViewId,
            entityId: Number(segment.entityId),
            measurementSource: 'native-brep',
            startMm: vector(start.position),
            midpointMm: vector(midpoint.position),
            endMm: vector(end.position),
            lengthMm: mm(edge.FindLength().length),
          });
        }
      }
      return result.sort((left, right) => left.id.localeCompare(right.id));
    }`);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while curve fragments were being listed");
    }
    return { documentToken: after.documentToken, revision: after.revision, fragments };
  }

  async listCurveEndpoints(): Promise<{
    documentToken: string;
    revision: string;
    endpoints: CurveEndpointDescriptor[];
  }> {
    const before = await this.state();
    const endpoints = await this.runtime.read<CurveEndpointDescriptor[]>(nativeFunction`function () {
      const mm = value => value * 1000;
      const vector = value => [mm(value.x), mm(value.y), mm(value.z)];
      const result = [];
      for (const [versionId, item] of nativeApi.geo.geometryModel) {
        if (item.view?.constructor?.name !== 'Wire') continue;
        const bodyId = nativeApi.db.lookupStableId(versionId);
        if (!Number.isInteger(bodyId)) continue;
        for (const vertex of Array.from(item.view.vertices ?? [])) {
          const model = nativeApi.db.lookupTopologyItem(vertex);
          if (!model.IsSpur()) continue;
          result.push({
            id: String(vertex.versionId),
            bodyId,
            bodyVersionId: versionId,
            entityId: Number(vertex.entityId),
            measurementSource: 'native-brep',
            positionMm: vector(model.GetPoint()),
          });
        }
      }
      return result.sort((left, right) => left.id.localeCompare(right.id));
    }`);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while curve endpoints were being listed");
    }
    return { documentToken: after.documentToken, revision: after.revision, endpoints };
  }

  async listCurveVertices(): Promise<{
    documentToken: string;
    revision: string;
    vertices: CurveVertexDescriptor[];
  }> {
    const before = await this.state();
    const vertices = await this.runtime.readNative<CurveVertexDescriptor[]>(nativeFunction`function () {
      const mm = value => value * 1000;
      const vector = value => [mm(value.x), mm(value.y), mm(value.z)];
      const result = [];
      for (const [versionId, item] of nativeApi.geo.geometryModel) {
        if (item.view?.constructor?.name !== 'Wire') continue;
        const bodyId = nativeApi.db.lookupStableId(versionId);
        if (!Number.isInteger(bodyId)) continue;
        const bodyEdges = item.model?.GetEdges?.();
        for (const view of Array.from(item.view.vertices ?? [])) {
          const vertex = nativeApi.db.lookupTopologyItem(view);
          const vertexId = Number(vertex.Id());
          if (!Number.isInteger(vertexId)) continue;
          const adjacentEdgeEntityIds = [];
          for (let index = 0; index < (bodyEdges?.Size?.() ?? 0); index += 1) {
            const edge = bodyEdges.Get(index);
            const ends = edge.GetVertices();
            if (ends.left?.Id?.() !== vertexId && ends.right?.Id?.() !== vertexId) continue;
            const edgeId = Number(edge.Id());
            if (Number.isInteger(edgeId)) adjacentEdgeEntityIds.push(edgeId);
          }
          adjacentEdgeEntityIds.sort((left, right) => left - right);
          result.push({
            id: bodyId + ':' + vertexId,
            bodyId,
            bodyVersionId: Number(versionId),
            vertexId,
            viewVersionId: String(view.versionId),
            measurementSource: 'native-brep',
            positionMm: vector(vertex.GetPoint()),
            endpoint: Boolean(vertex.IsSpur()),
            adjacentEdgeEntityIds,
          });
        }
      }
      return result.sort((left, right) => left.bodyId - right.bodyId || left.vertexId - right.vertexId);
    }`, [], []);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while curve vertices were being listed");
    }
    return { documentToken: after.documentToken, revision: after.revision, vertices };
  }

  async listCurveDirections(): Promise<{
    documentToken: string;
    revision: string;
    curves: CurveDirectionDescriptor[];
  }> {
    const before = await this.state();
    const curves = await this.runtime.readNative<CurveDirectionDescriptor[]>(nativeFunction`function () {
      const mm = value => value * 1000;
      const vector = value => [mm(value.x), mm(value.y), mm(value.z)];
      const direction = value => {
        const length = Math.hypot(value.x, value.y, value.z);
        if (!(length > 0)) throw new Error('Native curve tangent is zero');
        return [value.x / length, value.y / length, value.z / length];
      };
      const result = [];
      for (const [versionId, item] of nativeApi.geo.geometryModel) {
        if (item.view?.constructor?.name !== 'Wire') continue;
        const id = nativeApi.db.lookupStableId(versionId);
        if (!Number.isInteger(id)) continue;
        const edges = item.model?.GetEdges?.();
        const segments = [];
        for (let index = 0; index < (edges?.Size?.() ?? 0); index += 1) {
          const edge = edges.Get(index);
          const start = edge.GetPointAndTangent(0);
          const end = edge.GetPointAndTangent(1);
          const midpoint = edge.GetPointAndTangent(0.5);
          const nativeCurve = edge.GetCurve();
          const curve = nativeCurve?.curve ?? nativeCurve;
          let circleGeometry = null;
          if (edge.IsCircle()) {
            const info = curve?.GetInfo?.();
            const basis = info?.basis;
            if (basis?.Location && basis?.Axis && basis?.Ref && Number.isFinite(info?.radius) && info.radius > 0) {
              circleGeometry = {
                centerMm: vector(basis.Location),
                radiusMm: mm(info.radius),
                normal: direction(basis.Axis),
                reference: direction(basis.Ref),
                startMm: vector(start.position),
                midpointMm: vector(midpoint.position),
                endMm: vector(end.position),
              };
            }
          }
          segments.push({
            entityId: Number(edge.Id()),
            curveType: curve?.constructor?.name ?? 'Unknown',
            startMm: vector(start.position),
            endMm: vector(end.position),
            startTangent: direction(start.tangent),
            endTangent: direction(end.tangent),
            lengthMm: mm(edge.FindLength().length),
            ...(circleGeometry === null ? {} : { circleGeometry }),
          });
        }
        let closed = true;
        for (const vertex of Array.from(item.view.vertices ?? [])) {
          if (nativeApi.db.lookupTopologyItem(vertex).IsSpur()) { closed = false; break; }
        }
        result.push({ id, versionId, measurementSource: 'native-brep', closed, segments });
      }
      return result.sort((left, right) => left.id - right.id);
    }`, [], []);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while curve directions were being listed");
    }
    return { documentToken: after.documentToken, revision: after.revision, curves };
  }

  async evaluateCurveSegments(samples: CurveSegmentSampleReference[], revision: string): Promise<{
    documentToken: string;
    revision: string;
    samples: CurveSegmentSampleDescriptor[];
  }> {
    const before = await this.assertRevision(revision);
    if (samples.length === 0) throw new Error("At least one curve segment sample is required");
    const keys = samples.map((sample) => `${sample.bodyId}:${sample.segmentEntityId}:${sample.normalizedParameter}`);
    if (new Set(keys).size !== keys.length) throw new Error("Curve segment samples must be unique");
    for (const sample of samples) {
      if (before.bodies.find((body) => body.id === sample.bodyId)?.type !== "Wire") {
        throw new Error(`Curve segment evaluation requires a current Wire body: ${sample.bodyId}`);
      }
      if (!Number.isInteger(sample.segmentEntityId) || sample.segmentEntityId <= 0) {
        throw new Error("Curve segment entity ID must be a positive integer");
      }
      if (!Number.isFinite(sample.normalizedParameter) || sample.normalizedParameter < 0 || sample.normalizedParameter > 1) {
        throw new Error("Curve segment normalized parameter must be from 0 to 1");
      }
    }
    const evaluated = await this.runtime.readNative<CurveSegmentSampleDescriptor[]>(nativeFunction`function (args) {
      const mm = value => value * 1000;
      const vector = value => [mm(value.x), mm(value.y), mm(value.z)];
      const direction = value => {
        const length = Math.hypot(value.x, value.y, value.z);
        if (!(length > 0)) throw new Error('Native curve tangent is zero');
        return [value.x / length, value.y / length, value.z / length];
      };
      const result = [];
      for (const reference of args.samples) {
        let found;
        for (const [versionId, item] of nativeApi.geo.geometryModel) {
          if (nativeApi.db.lookupStableId(versionId) === reference.bodyId) { found = [versionId, item]; break; }
        }
        if (!found || found[1].view?.constructor?.name !== 'Wire') throw new Error('Curve segment source is no longer a Wire: ' + reference.bodyId);
        const [versionId, item] = found;
        let edge;
        for (const candidate of Array.from(item.view.segments ?? [])) {
          const model = nativeApi.db.lookupTopologyItem(candidate);
          if (Number(model?.Id?.()) === reference.segmentEntityId) { edge = model; break; }
        }
        if (!edge) throw new Error('Stale or unknown curve segment: ' + reference.bodyId + ':' + reference.segmentEntityId);
        const evaluated = edge.GetPointAndTangent(reference.normalizedParameter);
        const wrapped = edge.GetCurve();
        const curve = wrapped?.curve ?? wrapped;
        result.push({
          reference,
          bodyVersionId: Number(versionId),
          curveType: String(curve?.constructor?.name ?? 'Unknown'),
          measurementSource: 'native-brep',
          positionMm: vector(evaluated.position),
          tangent: direction(evaluated.tangent),
        });
      }
      return result;
    }`, [], [{ samples }]);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while curve segments were being evaluated");
    }
    return { documentToken: after.documentToken, revision: after.revision, samples: evaluated };
  }

  async inspectCurveStructure(ids: number[], revision: string): Promise<{
    documentToken: string;
    revision: string;
    curves: CurveStructureDescriptor[];
  }> {
    const before = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one Wire ID is required");
    if (new Set(ids).size !== ids.length) throw new Error("Wire IDs must be unique");
    const selected = ids.map((id) => before.bodies.find((body) => body.id === id));
    const invalid = ids.filter((_id, index) => selected[index]?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve structure requires current Wire bodies: ${invalid.join(", ")}`);
    const curves = await this.runtime.readNative<CurveStructureDescriptor[]>(nativeFunction`function (args) {
      const countActiveCurveSpans = (${countActiveCurveSpans.toString()});
      const mm = value => value * 1000;
      const result = [];
      for (const wantedId of args.ids) {
        let found;
        for (const [versionId, item] of nativeApi.geo.geometryModel) {
          if (nativeApi.db.lookupStableId(versionId) === wantedId) { found = [versionId, item]; break; }
        }
        if (!found) throw new Error('Unknown current Wire ID: ' + wantedId);
        const [versionId, item] = found;
        if (item.view?.constructor?.name !== 'Wire') throw new Error('Curve structure requires a Wire: ' + wantedId);
        const edges = item.model?.GetEdges?.();
        const segments = [];
        for (let index = 0; index < (edges?.Size?.() ?? 0); index += 1) {
          const edge = edges.Get(index);
          const wrapped = edge.GetCurve();
          const nativeCurve = wrapped?.curve ?? wrapped;
          let info;
          try { info = nativeCurve?.GetInfo?.(); } catch {}
          const curveType = String(nativeCurve?.constructor?.name ?? 'Unknown');
          let circle = null;
          if (curveType === 'Circle' && info?.basis && Number.isFinite(info.radius) && info.radius > 0) {
            const axis = info.basis.Axis;
            const location = info.basis.Location;
            if ([axis?.x, axis?.y, axis?.z, location?.x, location?.y, location?.z].every(Number.isFinite)) {
              const axisLength = Math.hypot(axis.x, axis.y, axis.z);
              if (axisLength > 0) circle = {
                centerMm: [mm(location.x), mm(location.y), mm(location.z)],
                radiusMm: mm(info.radius),
                normal: [axis.x / axisLength, axis.y / axisLength, axis.z / axisLength],
              };
            }
          }
          let knots = null;
          let activeSpanCount = null;
          if (Number.isInteger(info?.numDistinctKnots) && info.numDistinctKnots > 0 && info?.knotVals && info?.knotMults) {
            const values = [];
            for (let knotIndex = 0; knotIndex < info.numDistinctKnots; knotIndex += 1) {
              const nativeParameter = Number(info.knotVals[knotIndex]);
              const multiplicity = Number(info.knotMults[knotIndex]);
              const normalizedParameter = Number(edge.Normalize(nativeParameter));
              if (!Number.isFinite(normalizedParameter) || !Number.isInteger(multiplicity)) { values.length = 0; break; }
              values.push({
                normalizedParameter,
                multiplicity,
                withinSegment: normalizedParameter >= -1e-12 && normalizedParameter <= 1 + 1e-12,
              });
            }
            if (values.length === info.numDistinctKnots) {
              knots = values;
              activeSpanCount = countActiveCurveSpans(values.filter(value => value.withinSegment).map(value => value.normalizedParameter));
            }
          }
          segments.push({
            entityId: Number(edge.Id()),
            curveType,
            lengthMm: mm(edge.FindLength().length),
            degree: Number.isInteger(info?.degree) ? Number(info.degree) : null,
            controlPointCount: Number.isInteger(info?.numVerts) ? Number(info.numVerts) : null,
            spanCount: Number.isInteger(info?.numSpans) ? Number(info.numSpans) : null,
            activeSpanCount,
            distinctKnotCount: Number.isInteger(info?.numDistinctKnots) ? Number(info.numDistinctKnots) : null,
            knots,
            rational: typeof info?.isRational === 'boolean' ? info.isRational : null,
            periodic: typeof info?.isPeriodic === 'boolean' ? info.isPeriodic : null,
            circle,
          });
        }
        result.push({ id: wantedId, versionId: Number(versionId), measurementSource: 'native-brep', segments });
      }
      return result;
    }`, [], [{ ids }]);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while curve structure was being inspected");
    }
    return { documentToken: after.documentToken, revision: after.revision, curves };
  }

  async inspectSurfaceStructure(faces: FaceReference[], revision: string): Promise<{
    documentToken: string;
    revision: string;
    surfaces: SurfaceStructureDescriptor[];
  }> {
    const before = await this.assertRevision(revision);
    requireTopologySelection(before, faces, "face");
    const invalidBodies = [...new Set(faces.map((reference) => reference.bodyId))].filter((bodyId) => {
      const type = before.bodies.find((body) => body.id === bodyId)?.type;
      return type !== "Solid" && type !== "Sheet";
    });
    if (invalidBodies.length > 0) throw new Error(`Surface structure requires current Solid or Sheet bodies: ${invalidBodies.join(", ")}`);
    const surfaces = await this.runtime.readNative<SurfaceStructureDescriptor[]>(nativeFunction`function (args) {
      const finiteBounds = value => value && ['uMin', 'uMax', 'vMin', 'vMax'].every(key => Number.isFinite(value[key]))
        ? { uMin: Number(value.uMin), uMax: Number(value.uMax), vMin: Number(value.vMin), vMax: Number(value.vMax) }
        : null;
      const result = [];
      for (const reference of args.faces) {
        let found;
        for (const [versionId, item] of nativeApi.geo.geometryModel) {
          if (nativeApi.db.lookupStableId(versionId) === reference.bodyId) { found = [versionId, item]; break; }
        }
        if (!found) throw new Error('Unknown current surface body ID: ' + reference.bodyId);
        const [versionId, item] = found;
        const faceViews = item.view?.high?.faces;
        const viewIndex = faceViews?.versionIds?.indexOf(reference.faceId) ?? -1;
        if (viewIndex < 0) throw new Error('Unknown current surface face: ' + reference.bodyId + ':' + reference.faceId);
        const faceView = faceViews.get(viewIndex);
        const nativeFaces = item.model?.GetFaces?.();
        let face;
        for (let index = 0; index < (nativeFaces?.Size?.() ?? 0); index += 1) {
          const candidate = nativeFaces.Get(index);
          if (candidate.Id() === faceView.entityId) { face = candidate; break; }
        }
        if (!face) throw new Error('Native surface face is unavailable: ' + reference.bodyId + ':' + reference.faceId);
        const carrier = face.GetSurface();
        const surface = carrier?.surface;
        if (!surface) throw new Error('Native carrier surface is unavailable: ' + reference.bodyId + ':' + reference.faceId);
        const faceBounds = finiteBounds(carrier);
        if (!faceBounds) throw new Error('Native face parameter bounds are unavailable: ' + reference.bodyId + ':' + reference.faceId);
        let info;
        try { info = surface.GetInfo(); } catch {}
        let naturalBounds;
        let naturalParameterBoundsSource = null;
        if (typeof surface.GetUVBox === 'function') {
          try { naturalBounds = finiteBounds(surface.GetUVBox()); } catch { naturalBounds = null; }
          if (naturalBounds) naturalParameterBoundsSource = 'surface';
        } else if (face.IsUntrimmed()) {
          // 26.2 removed GetUVBox. An untrimmed face covers the carrier's full
          // native parameter domain; trimmed faces must still report unknown.
          naturalBounds = { ...faceBounds };
          naturalParameterBoundsSource = 'untrimmed-face';
        } else naturalBounds = null;
        const bSpline = surface.constructor?.name === 'BSurf' &&
          ['uDegree', 'vDegree', 'uSpans', 'vSpans', 'uVertices', 'vVertices'].every(key => Number.isInteger(info?.[key]))
          ? {
              uDegree: Number(info.uDegree), vDegree: Number(info.vDegree),
              uSpanCount: Number(info.uSpans), vSpanCount: Number(info.vSpans),
              uControlPointCount: Number(info.uVertices), vControlPointCount: Number(info.vVertices),
              rational: Boolean(info.isRational),
            }
          : null;
        result.push({
          bodyId: reference.bodyId,
          faceId: reference.faceId,
          bodyVersionId: Number(versionId),
          measurementSource: 'native-brep',
          surfaceType: String(surface.constructor?.name ?? 'Unknown'),
          trimmed: !face.IsUntrimmed(),
          faceParameterBounds: faceBounds,
          naturalParameterBounds: naturalBounds,
          naturalParameterBoundsSource,
          bSpline,
        });
      }
      return result;
    }`, [], [{ faces }]);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while surface structure was being inspected");
    }
    return { documentToken: after.documentToken, revision: after.revision, surfaces };
  }

  async inspectCurvePlanarity(ids: number[], revision: string): Promise<{
    documentToken: string;
    revision: string;
    curves: CurvePlanarityDescriptor[];
  }> {
    const before = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one Wire ID is required");
    if (new Set(ids).size !== ids.length) throw new Error("Wire IDs must be unique");
    const invalid = ids.filter((id) => before.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve planarity requires current Wire bodies: ${invalid.join(", ")}`);
    const curves = await this.runtime.readNative<CurvePlanarityDescriptor[]>(nativeFunction`function (args) {
      const mm = value => value * 1000;
      const vector = value => [mm(value.x), mm(value.y), mm(value.z)];
      const direction = value => [value.x, value.y, value.z];
      const result = [];
      for (const wantedId of args.ids) {
        let found;
        for (const [versionId, item] of nativeApi.geo.geometryModel) {
          if (nativeApi.db.lookupStableId(versionId) === wantedId) { found = [versionId, item]; break; }
        }
        if (!found) throw new Error('Unknown current Wire ID: ' + wantedId);
        const [versionId, item] = found;
        if (item.view?.constructor?.name !== 'Wire') throw new Error('Curve planarity requires a Wire: ' + wantedId);
        const basis = item.model?.FindPlanarBasis?.();
        result.push({
          id: wantedId,
          versionId: Number(versionId),
          measurementSource: 'native-brep',
          planar: Boolean(basis),
          plane: basis ? { originMm: vector(basis.Location), normal: direction(basis.Axis) } : null,
        });
      }
      return result;
    }`, [], [{ ids }]);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while curve planarity was being inspected");
    }
    return { documentToken: after.documentToken, revision: after.revision, curves };
  }

  async listCurveControlPoints(ids: number[], revision: string): Promise<{
    documentToken: string;
    revision: string;
    curves: CurveControlPointDescriptor[];
  }> {
    const before = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one Wire ID is required");
    if (new Set(ids).size !== ids.length) throw new Error("Wire IDs must be unique");
    const invalid = ids.filter((id) => before.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve control points require current Wire bodies: ${invalid.join(", ")}`);
    const curves = await this.runtime.readNative<CurveControlPointDescriptor[]>(nativeFunction`function (SlideFactory, args) {
      const mm = value => value * 1000;
      const position = value => [mm(value.x), mm(value.y), mm(value.z)];
      const direction = value => [value.x, value.y, value.z];
      const slideDirections = (view, kind) => {
        try {
          const factory = new SlideFactory(this);
          nativeApi.setCurveControlPoints(factory, kind === 'vertex' ? [view] : [], kind === 'vertex' ? [] : [view]);
          const orientation = nativeApi.slideDirections(factory);
          const positiveU = direction(orientation.posU);
          const negativeU = direction(orientation.negU);
          if (![...positiveU, ...negativeU].every(Number.isFinite)) return null;
          if (Math.hypot(...positiveU) < 1e-12 || Math.hypot(...negativeU) < 1e-12) return null;
          return { positiveU, negativeU };
        } catch { return null; }
      };
      const result = [];
      let totalApproximationPoints = 0;
      for (const wantedId of args.ids) {
        let found;
        for (const [versionId, item] of nativeApi.geo.geometryModel) {
          if (nativeApi.db.lookupStableId(versionId) === wantedId) { found = [versionId, item]; break; }
        }
        if (!found) throw new Error('Unknown current Wire ID: ' + wantedId);
        const [versionId, item] = found;
        if (item.view?.constructor?.name !== 'Wire') throw new Error('Curve control points require a Wire: ' + wantedId);
        const boundaryVertices = Array.from(item.view.vertices ?? []).map(vertex => ({
          reference: { bodyId: wantedId, kind: 'vertex', pointId: Number(vertex.id) },
          versionId: String(vertex.versionId),
          positionMm: position(vertex.position),
          slideDirections: slideDirections(vertex, 'vertex'),
        }));
        const interiorControlPoints = Array.from(item.view.cvs ?? []).map(controlPoint => ({
          reference: { bodyId: wantedId, kind: 'control-point', pointId: Number(controlPoint.id) },
          versionId: String(controlPoint.versionId),
          positionMm: position(controlPoint.position),
          slideDirections: slideDirections(controlPoint, 'control-point'),
        }));
        result.push({
          id: wantedId,
          versionId: Number(versionId),
          positionSource: 'native-control-handle',
          boundaryVertices,
          interiorControlPoints,
        });
      }
      return result;
    }`, ["MultiSlideControlPointFactory"], [{ ids }]);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while curve control points were being listed");
    }
    return { documentToken: after.documentToken, revision: after.revision, curves };
  }

  async listCurveIntersections(): Promise<{
    documentToken: string;
    revision: string;
    intersections: CurveIntersectionDescriptor[];
  }> {
    const before = await this.state();
    const intersections = await this.runtime.read<CurveIntersectionDescriptor[]>(nativeFunction`function () {
      const mm = value => value * 1000;
      const result = new Map();
      for (const cross of this.crosses.crosses) {
        const sides = [cross.on1, cross.on2].map(on => {
          const versionId = Number(on.versionId);
          const item = nativeApi.geo.geometryModel.get(versionId);
          const bodyId = nativeApi.db.lookupStableId(versionId);
          if (!item || item.view?.constructor?.name !== 'Wire' || !Number.isInteger(bodyId)) return null;
          return { bodyId, versionId, edgeEntityId: Number(on.edgeId), parameter: Number(on.t) };
        });
        if (sides.some(side => side === null)) continue;
        sides.sort((left, right) => left.versionId - right.versionId || left.edgeEntityId - right.edgeEntityId || left.parameter - right.parameter);
        const [first, second] = sides;
        const id = first.versionId + ':' + first.edgeEntityId + '@' + first.parameter + '|' + second.versionId + ':' + second.edgeEntityId + '@' + second.parameter;
        result.set(id, {
          id,
          bodyIds: [first.bodyId, second.bodyId],
          bodyVersionIds: [first.versionId, second.versionId],
          edgeEntityIds: [first.edgeEntityId, second.edgeEntityId],
          measurementSource: 'native-brep',
          positionMm: [mm(cross.position.x), mm(cross.position.y), mm(cross.position.z)],
        });
      }
      return Array.from(result.values()).sort((left, right) => left.id.localeCompare(right.id));
    }`);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while curve intersections were being listed");
    }
    return { documentToken: after.documentToken, revision: after.revision, intersections };
  }

  async selectBodies(ids: number[], revision: string): Promise<PlasticitySelection> {
    return await this.selectNodes(ids, [], [], [], revision);
  }

  async clearSelection(revision: string): Promise<PlasticitySelection> {
    await this.assertRevision(revision);
    await this.runtime.read(nativeFunction`function () {
      this.selection.selected.removeAll();
    }`);
    return await this.selection();
  }

  async selectCurves(ids: number[], revision: string): Promise<PlasticitySelection> {
    const state = await this.assertRevision(revision);
    requireWireBodyIds(state, ids);
    await this.runtime.read(nativeFunction`function (args) {
      ${findView}
      this.selection.selected.removeAll();
      for (const id of args.ids) nativeApi.selection.addCurve(find(id));
    }`, [{ ids }]);
    return await this.selection();
  }

  async selectReferenceMeshes(ids: number[], revision: string): Promise<PlasticitySelection> {
    const state = await this.assertRevision(revision);
    requireReferenceMeshIds(state, ids);
    await this.runtime.read(nativeFunction`function (args) {
      const find = id => {
        const empty = nativeApi.db.lookupEmptyById(id);
        if (!nativeApi.isReferenceMesh(empty)) throw new Error('Unknown native reference mesh ID: ' + id);
        return empty;
      };
      this.selection.selected.removeAll();
      for (const empty of args.ids.map(find)) nativeApi.selection.addEmpty(empty);
    }`, [{ ids }]);
    return await this.selection();
  }

  async selectNodes(bodyIds: number[], instanceIds: number[], referenceMeshIds: number[], groupIds: number[], revision: string): Promise<PlasticitySelection> {
    const state = await this.assertRevision(revision);
    requireGroupSelection(state, bodyIds, instanceIds, referenceMeshIds, groupIds, true);
    await this.runtime.read(nativeFunction`function (args) {
      ${findView}
      const findEmpty = id => {
        const empty = nativeApi.db.lookupEmptyById(id);
        if (empty?.constructor?.name !== 'InstanceEmpty') throw new Error('Unknown native instance ID: ' + id);
        return empty;
      };
      const findReferenceMesh = id => {
        const empty = nativeApi.db.lookupEmptyById(id);
        if (!nativeApi.isReferenceMesh(empty)) throw new Error('Unknown native reference mesh ID: ' + id);
        return empty;
      };
      const findGroup = id => {
        const group = nativeApi.db.groups.lookupById(id);
        if (!group) throw new Error('Unknown group ID: ' + id);
        return group;
      };
      this.selection.selected.removeAll();
      for (const view of args.bodyIds.map(find)) this.selection.selected.add(view);
      for (const empty of args.instanceIds.map(findEmpty)) nativeApi.selection.addEmpty(empty);
      for (const empty of args.referenceMeshIds.map(findReferenceMesh)) nativeApi.selection.addEmpty(empty);
      for (const group of args.groupIds.map(findGroup)) nativeApi.selection.addGroup(group);
    }`, [{ bodyIds, instanceIds, referenceMeshIds, groupIds }]);
    return await this.selection();
  }

  async selectFaces(references: FaceReference[], revision: string): Promise<PlasticitySelection> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "face");
    await this.runtime.read(nativeFunction`function (args) {
      ${findView}
      this.selection.selected.removeAll();
      for (const reference of args.references) {
        const view = find(reference.bodyId);
        const index = view.high.faces.versionIds.indexOf(reference.faceId);
        if (index < 0) throw new Error('Unknown current face ID: ' + reference.faceId);
        nativeApi.selection.addFace(view.high.faces.get(index));
      }
    }`, [{ references }]);
    return await this.selection();
  }

  async selectEdges(references: EdgeReference[], revision: string): Promise<PlasticitySelection> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "edge");
    await this.runtime.read(nativeFunction`function (args) {
      ${findView}
      this.selection.selected.removeAll();
      for (const reference of args.references) {
        const view = find(reference.bodyId);
        const index = view.high.edges.versionIds.indexOf(reference.edgeId);
        if (index < 0) throw new Error('Unknown current edge ID: ' + reference.edgeId);
        nativeApi.selection.addEdge(view.high.edges.get(index));
      }
    }`, [{ references }]);
    return await this.selection();
  }

  async selectCurveControlPoints(references: CurveControlPointReference[], revision: string): Promise<PlasticitySelection> {
    await this.assertCurveControlPointReferences(references, revision);
    await this.runtime.read(nativeFunction`function (args) {
      ${findCurveControlPoints}
      this.selection.selected.removeAll();
      for (const vertex of vertices) nativeApi.selection.addVertex(vertex);
      for (const controlPoint of cvs) nativeApi.selection.addCurveCV(controlPoint);
    }`, [{ points: references }]);
    return await this.selection();
  }

  async alignPlanarFaces(
    ids: number[],
    sourceReference: FaceReference,
    targetReference: FaceReference,
    relation: "opposed" | "same",
    gapMm: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one moving body ID is required");
    if (new Set(ids).size !== ids.length) throw new Error("Moving body IDs must be unique");
    const currentBodyIds = new Set(state.bodies.map((body) => body.id));
    const missingIds = ids.filter((id) => !currentBodyIds.has(id));
    if (missingIds.length > 0) throw new Error(`Unknown current moving body IDs: ${missingIds.join(", ")}`);
    if (!ids.includes(sourceReference.bodyId)) throw new Error("The source face must belong to a moving body");
    if (ids.includes(targetReference.bodyId)) throw new Error("The target face must remain fixed during alignment");
    if (relation !== "opposed" && relation !== "same") throw new Error(`Unsupported planar-face relation: ${String(relation)}`);
    if (!Number.isFinite(gapMm)) throw new Error("Planar-face alignment gap must be finite");

    const sourceBody = state.bodies.find((body) => body.id === sourceReference.bodyId)!;
    const targetBody = state.bodies.find((body) => body.id === targetReference.bodyId);
    const sourceFace = sourceBody.faces.find((face) => face.id === sourceReference.faceId);
    const targetFace = targetBody?.faces.find((face) => face.id === targetReference.faceId);
    if (!sourceFace) throw new Error(`Unknown current source face: ${sourceReference.bodyId}:${sourceReference.faceId}`);
    if (!targetFace) throw new Error(`Unknown current target face: ${targetReference.bodyId}:${targetReference.faceId}`);
    if (!sourceFace.planar) throw new Error("The source face must be planar");
    if (!targetFace.planar) throw new Error("The target face must be planar");

    const sourceNormal = normalize(sourceFace.normal, "Source face normal");
    const fixedNormal = normalize(targetFace.normal, "Target face normal");
    const targetNormal = relation === "opposed" ? scale(fixedNormal, -1) : fixedNormal;
    const destinationMm = add(targetFace.centerMm, scale(fixedNormal, gapMm));
    const deltaMm = subtract(destinationMm, sourceFace.centerMm);
    await this.runtime.mutate(nativeFunction`async function (RotateFactory, MoveFactory, Vector, Quaternion, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const items = args.ids.map(find);
      this.selection.selected.removeAll();
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const sourceNormal = new Vector(...args.sourceNormal).normalize();
          const targetNormal = new Vector(...args.targetNormal).normalize();
          if (sourceNormal.dot(targetNormal) < 1 - 1e-12) {
            const rotate = new RotateFactory(editor).resource(this);
            rotate.items = items;
            rotate.pivot.fromArray(args.pivot);
            rotate.rotation.copy(new Quaternion().setFromUnitVectors(sourceNormal, targetNormal));
            await rotate.commit();
          }
          if (args.delta.some(value => Math.abs(value) > 1e-12)) {
            const move = new MoveFactory(editor).resource(this);
            move.items = args.ids.map(find);
            move.move.fromArray(args.delta);
            await move.commit();
          }
          return args.ids.map(find);
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["RotateItemAndEmptyFactory", "MoveItemAndEmptyFactory", "Vector3", "Quaternion"], [{
      ids,
      pivot: toMeters(sourceFace.centerMm),
      sourceNormal,
      targetNormal,
      delta: toMeters(deltaMm),
    }]);
    return await this.state();
  }

  async alignCylindricalFaces(
    ids: number[],
    sourceReference: FaceReference,
    targetReference: FaceReference,
    relation: "opposed" | "same",
    axialMode: "preserve" | "anchor",
    axialOffsetMm: number,
    rotationAroundAxisDeg: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one moving body ID is required");
    if (new Set(ids).size !== ids.length) throw new Error("Moving body IDs must be unique");
    const currentBodyIds = new Set(state.bodies.map((body) => body.id));
    const missingIds = ids.filter((id) => !currentBodyIds.has(id));
    if (missingIds.length > 0) throw new Error(`Unknown current moving body IDs: ${missingIds.join(", ")}`);
    if (!ids.includes(sourceReference.bodyId)) throw new Error("The source face must belong to a moving body");
    if (ids.includes(targetReference.bodyId)) throw new Error("The target face must remain fixed during alignment");
    if (relation !== "opposed" && relation !== "same") throw new Error(`Unsupported cylindrical-axis relation: ${String(relation)}`);
    if (axialMode !== "preserve" && axialMode !== "anchor") throw new Error(`Unsupported cylindrical axial mode: ${String(axialMode)}`);
    if (!Number.isFinite(axialOffsetMm)) throw new Error("Cylindrical axial offset must be finite");
    if (axialMode === "preserve" && axialOffsetMm !== 0) throw new Error("Cylindrical axial offset is available only in anchor mode");
    if (!Number.isFinite(rotationAroundAxisDeg)) throw new Error("Cylindrical rotation around axis must be finite");

    const sourceBody = state.bodies.find((body) => body.id === sourceReference.bodyId)!;
    const targetBody = state.bodies.find((body) => body.id === targetReference.bodyId);
    const sourceFace = sourceBody.faces.find((face) => face.id === sourceReference.faceId);
    const targetFace = targetBody?.faces.find((face) => face.id === targetReference.faceId);
    if (!sourceFace) throw new Error(`Unknown current source face: ${sourceReference.bodyId}:${sourceReference.faceId}`);
    if (!targetFace) throw new Error(`Unknown current target face: ${targetReference.bodyId}:${targetReference.faceId}`);
    if (sourceFace.surfaceType !== "Cylinder" || !sourceFace.axisOriginMm || !sourceFace.axisDirection) {
      throw new Error("The source face must be cylindrical with an exact native axis");
    }
    if (targetFace.surfaceType !== "Cylinder" || !targetFace.axisOriginMm || !targetFace.axisDirection) {
      throw new Error("The target face must be cylindrical with an exact native axis");
    }

    const sourceAxis = normalize(sourceFace.axisDirection, "Source cylinder axis");
    const fixedAxis = normalize(targetFace.axisDirection, "Target cylinder axis");
    const targetAxis = relation === "opposed" ? scale(fixedAxis, -1) : fixedAxis;
    const betweenOrigins = subtract(targetFace.axisOriginMm, sourceFace.axisOriginMm);
    const deltaMm = axialMode === "anchor"
      ? subtract(add(targetFace.axisOriginMm, scale(fixedAxis, axialOffsetMm)), sourceFace.axisOriginMm)
      : subtract(betweenOrigins, scale(fixedAxis, betweenOrigins.reduce((sum, value, index) => sum + value * fixedAxis[index]!, 0)));
    await this.runtime.mutate(nativeFunction`async function (RotateFactory, MoveFactory, Vector, Quaternion, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const items = args.ids.map(find);
      this.selection.selected.removeAll();
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const sourceAxis = new Vector(...args.sourceAxis).normalize();
          const targetAxis = new Vector(...args.targetAxis).normalize();
          if (sourceAxis.dot(targetAxis) < 1 - 1e-12) {
            const rotate = new RotateFactory(editor).resource(this);
            rotate.items = items;
            rotate.pivot.fromArray(args.pivot);
            rotate.rotation.copy(new Quaternion().setFromUnitVectors(sourceAxis, targetAxis));
            await rotate.commit();
          }
          if (args.delta.some(value => Math.abs(value) > 1e-12)) {
            const move = new MoveFactory(editor).resource(this);
            move.items = args.ids.map(find);
            move.move.fromArray(args.delta);
            await move.commit();
          }
          if (Math.abs(args.rollRadians) > 1e-12) {
            const roll = new RotateFactory(editor).resource(this);
            roll.items = args.ids.map(find);
            roll.pivot.fromArray(args.targetOrigin);
            roll.rotation.copy(new Quaternion().setFromAxisAngle(new Vector(...args.fixedAxis).normalize(), args.rollRadians));
            await roll.commit();
          }
          return args.ids.map(find);
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["RotateItemAndEmptyFactory", "MoveItemAndEmptyFactory", "Vector3", "Quaternion"], [{
      ids,
      pivot: toMeters(sourceFace.axisOriginMm),
      sourceAxis,
      targetAxis,
      fixedAxis,
      delta: toMeters(deltaMm),
      targetOrigin: toMeters(targetFace.axisOriginMm),
      rollRadians: degreesToRadians(rotationAroundAxisDeg),
    }]);
    return await this.state();
  }

  async alignVertices(
    ids: number[],
    sourceReference: VertexReference,
    targetReference: VertexReference,
    offsetMm: Vector3,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one moving body ID is required");
    if (new Set(ids).size !== ids.length) throw new Error("Moving body IDs must be unique");
    const currentBodyIds = new Set(state.bodies.map((body) => body.id));
    const missingIds = ids.filter((id) => !currentBodyIds.has(id));
    if (missingIds.length > 0) throw new Error(`Unknown current moving body IDs: ${missingIds.join(", ")}`);
    if (!ids.includes(sourceReference.bodyId)) throw new Error("The source vertex must belong to a moving body");
    if (ids.includes(targetReference.bodyId)) throw new Error("The target vertex must remain fixed during alignment");
    if (offsetMm.some((value) => !Number.isFinite(value))) throw new Error("Vertex alignment offset must be finite");
    requireVertexReference(state, sourceReference, "Source vertex");
    requireVertexReference(state, targetReference, "Target vertex");
    const sourceVertex = state.bodies.find((body) => body.id === sourceReference.bodyId)!.vertices!
      .find((vertex) => vertex.id === sourceReference.vertexId)!;
    const targetVertex = state.bodies.find((body) => body.id === targetReference.bodyId)!.vertices!
      .find((vertex) => vertex.id === targetReference.vertexId)!;
    const destinationMm = add(targetVertex.positionMm, offsetMm);
    const deltaMm = subtract(destinationMm, sourceVertex.positionMm);
    if (!deltaMm.some((value) => Math.abs(value) > 1e-12)) {
      throw new Error("Vertex alignment would not move the selected bodies");
    }

    await this.runtime.mutate(nativeFunction`async function (MoveFactory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const items = args.ids.map(find);
      this.selection.selected.removeAll();
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const move = new MoveFactory(editor).resource(this);
          move.items = items;
          move.move.fromArray(args.delta);
          await move.commit();
          return args.ids.map(find);
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["MoveItemAndEmptyFactory"], [{ ids, delta: toMeters(deltaMm) }]);
    return await this.state();
  }

  async alignLinearEdges(
    ids: number[],
    sourceReference: EdgeReference,
    targetReference: EdgeReference,
    relation: "opposed" | "same",
    axialOffsetMm: number,
    rotationAroundAxisDeg: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one moving body ID is required");
    if (new Set(ids).size !== ids.length) throw new Error("Moving body IDs must be unique");
    const currentBodyIds = new Set(state.bodies.map((body) => body.id));
    const missingIds = ids.filter((id) => !currentBodyIds.has(id));
    if (missingIds.length > 0) throw new Error(`Unknown current moving body IDs: ${missingIds.join(", ")}`);
    if (!ids.includes(sourceReference.bodyId)) throw new Error("The source edge must belong to a moving body");
    if (ids.includes(targetReference.bodyId)) throw new Error("The target edge must remain fixed during alignment");
    if (relation !== "opposed" && relation !== "same") throw new Error(`Unsupported linear-edge relation: ${String(relation)}`);
    if (!Number.isFinite(axialOffsetMm)) throw new Error("Linear-edge axial offset must be finite");
    if (!Number.isFinite(rotationAroundAxisDeg)) throw new Error("Linear-edge rotation around axis must be finite");

    const sourceBody = state.bodies.find((body) => body.id === sourceReference.bodyId)!;
    const targetBody = state.bodies.find((body) => body.id === targetReference.bodyId);
    const sourceEdge = sourceBody.edges.find((edge) => edge.id === sourceReference.edgeId);
    const targetEdge = targetBody?.edges.find((edge) => edge.id === targetReference.edgeId);
    if (!sourceEdge) throw new Error(`Unknown current source edge: ${sourceReference.bodyId}:${sourceReference.edgeId}`);
    if (!targetEdge) throw new Error(`Unknown current target edge: ${targetReference.bodyId}:${targetReference.edgeId}`);
    if (!sourceEdge.line) throw new Error("The source edge must be an exact native Line");
    if (!targetEdge.line) throw new Error("The target edge must be an exact native Line");

    const sourceDirection = normalize(sourceEdge.tangent, "Source edge tangent");
    const fixedDirection = normalize(targetEdge.tangent, "Target edge tangent");
    const targetDirection = relation === "opposed" ? scale(fixedDirection, -1) : fixedDirection;
    const destinationMm = add(targetEdge.centerMm, scale(fixedDirection, axialOffsetMm));
    const deltaMm = subtract(destinationMm, sourceEdge.centerMm);
    const directionAlreadyAligned = dot(sourceDirection, targetDirection) >= 1 - 1e-12;
    const translationRequired = deltaMm.some((value) => Math.abs(value) > 1e-12);
    if (directionAlreadyAligned && !translationRequired && Math.abs(rotationAroundAxisDeg) <= 1e-12) {
      throw new Error("Linear-edge alignment would not transform the selected bodies");
    }

    await this.runtime.mutate(nativeFunction`async function (RotateFactory, MoveFactory, Vector, Quaternion, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const items = args.ids.map(find);
      this.selection.selected.removeAll();
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const sourceDirection = new Vector(...args.sourceDirection).normalize();
          const targetDirection = new Vector(...args.targetDirection).normalize();
          if (sourceDirection.dot(targetDirection) < 1 - 1e-12) {
            const rotate = new RotateFactory(editor).resource(this);
            rotate.items = items;
            rotate.pivot.fromArray(args.sourcePivot);
            rotate.rotation.copy(new Quaternion().setFromUnitVectors(sourceDirection, targetDirection));
            await rotate.commit();
          }
          if (args.delta.some(value => Math.abs(value) > 1e-12)) {
            const move = new MoveFactory(editor).resource(this);
            move.items = args.ids.map(find);
            move.move.fromArray(args.delta);
            await move.commit();
          }
          if (Math.abs(args.rollRadians) > 1e-12) {
            const roll = new RotateFactory(editor).resource(this);
            roll.items = args.ids.map(find);
            roll.pivot.fromArray(args.targetPivot);
            roll.rotation.copy(new Quaternion().setFromAxisAngle(new Vector(...args.fixedDirection).normalize(), args.rollRadians));
            await roll.commit();
          }
          return args.ids.map(find);
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["RotateItemAndEmptyFactory", "MoveItemAndEmptyFactory", "Vector3", "Quaternion"], [{
      ids,
      sourcePivot: toMeters(sourceEdge.centerMm),
      targetPivot: toMeters(destinationMm),
      sourceDirection,
      targetDirection,
      fixedDirection,
      delta: toMeters(deltaMm),
      rollRadians: degreesToRadians(rotationAroundAxisDeg),
    }]);
    return await this.state();
  }

  async createBox(originMm: Vector3, sizeMm: Vector3, name?: string, revision?: string): Promise<RuntimeState> {
    if (revision) await this.assertRevision(revision);
    const origin = toMeters(originMm);
    const size = toMeters(sizeMm);
    await this.runtime.mutate(nativeFunction`async function (Factory, Vector, args) {
      ${commandStart("ThreePointBoxCommand")}
      const [x, y, z] = args.origin;
      const [width, depth, height] = args.size;
      factory.p1 = new Vector(x, y, z);
      factory.p2 = new Vector(x + width, y, z);
      factory.p3 = new Vector(x + width, y + depth, z);
      factory.p4 = new Vector(x + width, y + depth, z + height);
      const created = await factory.commit();
      if (args.name && created) for (const view of (Array.isArray(created) ? created : [created])) nativeApi.db.nodes.setName(nativeApi.db.nodes.item2key(view), args.name);
      return created;
      } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["ThreePointBoxFactory", "Vector3"], [{ origin, size, name: name ?? null }]);
    return await this.state();
  }

  async createSphere(centerMm: Vector3, radiusMm: number, name?: string, revision?: string): Promise<RuntimeState> {
    if (revision) await this.assertRevision(revision);
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${commandStart("SphereCommand")}
      factory.center.fromArray(args.center);
      factory.radius = args.radius;
      const created = await factory.commit();
      if (args.name && created) for (const view of (Array.isArray(created) ? created : [created])) nativeApi.db.nodes.setName(nativeApi.db.nodes.item2key(view), args.name);
      return created;
      } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["PossiblyBooleanSphereFactory"], [{ center: toMeters(centerMm), radius: millimetersToMeters(radiusMm), name: name ?? null }]);
    return await this.state();
  }

  async createCylinder(centerMm: Vector3, radiusMm: number, heightMm: number, name?: string, revision?: string, axis: Vector3 = [0, 0, 1]): Promise<RuntimeState> {
    if (revision) await this.assertRevision(revision);
    await this.runtime.mutate(nativeFunction`async function (Factory, Vector, Quaternion, args) {
      ${commandStart("CylinderCommand")}
      factory.center.fromArray(args.center);
      factory.orientation.copy(new Quaternion().setFromUnitVectors(new Vector(0, 0, 1), new Vector(...args.axis).normalize()));
      factory.radius = args.radius;
      factory.height = args.height;
      const created = await factory.commit();
      if (args.name && created) for (const view of (Array.isArray(created) ? created : [created])) nativeApi.db.nodes.setName(nativeApi.db.nodes.item2key(view), args.name);
      return created;
      } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["PossiblyBooleanCylinderFactory", "Vector3", "Quaternion"], [{ center: toMeters(centerMm), radius: millimetersToMeters(radiusMm), height: millimetersToMeters(heightMm), name: name ?? null, axis }]);
    return await this.state();
  }

  async createCone(
    bottomCenterMm: Vector3,
    bottomRadiusMm: number,
    topRadiusMm: number,
    heightMm: number,
    axis: Vector3,
    radialDirection: Vector3,
    name: string | undefined,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (!Number.isFinite(bottomRadiusMm) || bottomRadiusMm <= 0) throw new Error("Cone bottom radius must be positive");
    if (!Number.isFinite(topRadiusMm) || topRadiusMm < 0) throw new Error("Cone top radius must be nonnegative");
    if (!Number.isFinite(heightMm) || heightMm <= 0) throw new Error("Cone height must be positive");
    if (Math.abs(bottomRadiusMm - topRadiusMm) <= 1e-9) {
      throw new Error("Cone and frustum require unequal radii; use a cylinder for equal radii");
    }
    const frame = frameFromOriginNormalX(bottomCenterMm, axis, radialDirection);
    const bottomOuterMm = add(frame.originMm, scale(frame.xDirection, bottomRadiusMm));
    const topCenterMm = add(frame.originMm, scale(frame.normal, heightMm));
    const profilePointsMm = topRadiusMm === 0
      ? [frame.originMm, bottomOuterMm, topCenterMm]
      : [frame.originMm, bottomOuterMm, add(topCenterMm, scale(frame.xDirection, topRadiusMm)), topCenterMm];
    await this.runtime.mutate(nativeFunction`async function (CurveFactory, RevolveFactory, Vector, CurveType, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.RevolveCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const existingRegionIds = new Set();
          for (const [versionId, item] of nativeApi.geo.geometryModel) {
            if (!nativeApi.geo.automatics.has(versionId) || item.view?.constructor?.name !== 'SketchIsland') continue;
            for (let index = 0; index < (item.view.regions?.length ?? 0); index += 1) {
              const region = item.view.regions.get(index);
              if (region) existingRegionIds.add(String(region.versionId));
            }
          }
          const profile = new CurveFactory(editor).resource(this);
          profile.points = args.points.map(point => new Vector(...point));
          profile.type = CurveType.Polyline;
          profile.closed = true;
          let profiles = await profile.commit();
          profiles = Array.isArray(profiles) ? profiles : [profiles];
          const regions = [];
          for (const [versionId, item] of nativeApi.geo.geometryModel) {
            if (!nativeApi.geo.automatics.has(versionId) || item.view?.constructor?.name !== 'SketchIsland') continue;
            for (let index = 0; index < (item.view.regions?.length ?? 0); index += 1) {
              const region = item.view.regions.get(index);
              if (region && !existingRegionIds.has(String(region.versionId))) regions.push(region);
            }
          }
          if (regions.length !== 1) throw new Error('Cone profile did not create exactly one native Region');
          const revolve = new RevolveFactory(editor).resource(this);
          revolve.regions = regions;
          revolve.origin.fromArray(args.center);
          revolve.axis.fromArray(args.axis).normalize();
          revolve.degrees = 360;
          let created = await revolve.commit();
          created = Array.isArray(created) ? created : [created];
          if (args.name) {
            for (const view of profiles) nativeApi.db.nodes.setName(nativeApi.db.nodes.item2key(view), args.name + ' profile');
            for (const view of created) nativeApi.db.nodes.setName(nativeApi.db.nodes.item2key(view), args.name);
          }
          return created;
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["CurveFactory", "RevolveFactory", "Vector3", "CurveType"], [{
      points: profilePointsMm.map(toMeters),
      center: toMeters(frame.originMm),
      axis: frame.normal,
      name: name ?? null,
    }]);
    return await this.state();
  }

  async createTorus(
    centerMm: Vector3,
    majorRadiusMm: number,
    minorRadiusMm: number,
    axis: Vector3,
    radialDirection: Vector3,
    name: string | undefined,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (!Number.isFinite(minorRadiusMm) || minorRadiusMm <= 0) throw new Error("Torus minor radius must be positive");
    if (!Number.isFinite(majorRadiusMm) || majorRadiusMm <= minorRadiusMm) {
      throw new Error("Ring-torus major radius must be greater than its minor radius");
    }
    const frame = frameFromOriginNormalX(centerMm, axis, radialDirection);
    const profileCenterMm = add(frame.originMm, scale(frame.xDirection, majorRadiusMm));
    await this.runtime.mutate(nativeFunction`async function (CircleFactory, RevolveFactory, Vector, Quaternion, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.RevolveCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const profile = new CircleFactory(editor).resource(this);
          profile.center.fromArray(args.profileCenter);
          profile.orientation.copy(new Quaternion().setFromUnitVectors(
            new Vector(0, 0, 1),
            new Vector(...args.profileNormal).normalize(),
          ));
          profile.point.copy(profile.center).add(new Vector(args.minorRadius, 0, 0).applyQuaternion(profile.orientation));
          let profiles = await profile.commit();
          profiles = Array.isArray(profiles) ? profiles : [profiles];
          const revolve = new RevolveFactory(editor).resource(this);
          revolve.curves = profiles;
          revolve.origin.fromArray(args.center);
          revolve.axis.fromArray(args.axis).normalize();
          revolve.degrees = 360;
          let created = await revolve.commit();
          created = Array.isArray(created) ? created : [created];
          if (args.name) {
            for (const view of profiles) nativeApi.db.nodes.setName(nativeApi.db.nodes.item2key(view), args.name + ' profile');
            for (const view of created) nativeApi.db.nodes.setName(nativeApi.db.nodes.item2key(view), args.name);
          }
          return created;
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["CenterCircleFactory", "RevolveFactory", "Vector3", "Quaternion"], [{
      center: toMeters(frame.originMm),
      profileCenter: toMeters(profileCenterMm),
      profileNormal: frame.yDirection,
      axis: frame.normal,
      minorRadius: millimetersToMeters(minorRadiusMm),
      name: name ?? null,
    }]);
    return await this.state();
  }

  async createPolyline(
    pointsMm: Vector3[] | Vector2[],
    closed: boolean,
    revision?: string,
    plane?: ReferenceIdentity,
  ): Promise<RuntimeState> {
    let worldPoints: Vector3[];
    if (plane) {
      const resolvedPlane = await this.resolveCurrentPlane(plane, revision);
      worldPoints = pointsMm.map((point) => {
        if (point.length !== 2) throw new Error("Plane-local polyline points must contain two coordinates");
        return localPointToWorld(resolvedPlane, point);
      });
    } else {
      if (pointsMm.some((point) => point.length !== 3)) throw new Error("World-space polyline points must contain three coordinates");
      if (revision) await this.assertRevision(revision);
      worldPoints = pointsMm as Vector3[];
    }
    await this.runtime.mutate(`async function (Factory, Vector, CurveType, args) {
      ${commandStart("CurveCommand")}
      factory.points = args.points.map(point => new Vector(...point));
      factory.type = CurveType.Polyline;
      factory.closed = args.closed;
      ${commandEnd}
    }`, ["CurveFactory", "Vector3", "CurveType"], [{ points: worldPoints.map(toMeters), closed }]);
    return await this.state();
  }

  async createNurbsCurve(pointsMm: Vector3[], closed: boolean, revision?: string): Promise<RuntimeState> {
    if (pointsMm.length < 3) throw new Error("NURBS curve requires at least three interpolation points");
    if (revision) await this.assertRevision(revision);
    await this.runtime.mutate(`async function (Factory, Vector, CurveType, args) {
      ${commandStart("CurveCommand")}
      factory.points = args.points.map(point => new Vector(...point));
      factory.type = CurveType.NURBS;
      factory.closed = args.closed;
      ${commandEnd}
    }`, ["CurveFactory", "Vector3", "CurveType"], [{ points: pointsMm.map(toMeters), closed }]);
    return await this.state();
  }

  // Same native curve tool with "spline through points" off: the points are the control polygon.
  async createControlPointCurve(pointsMm: Vector3[], closed: boolean, revision?: string): Promise<RuntimeState> {
    if (pointsMm.length < 3) throw new Error("Control-point curve requires at least three control points");
    if (revision) await this.assertRevision(revision);
    await this.runtime.mutate(`async function (Factory, Vector, CurveType, args) {
      ${commandStart("CurveCommand")}
      factory.type = CurveType.NURBS;
      factory.splineThrough = false;
      factory.closed = args.closed;
      factory.points = args.points.map(point => new Vector(...point));
      ${commandEnd}
    }`, ["CurveFactory", "Vector3", "CurveType"], [{ points: pointsMm.map(toMeters), closed }]);
    return await this.state();
  }

  async createHelix(
    axisStartMm: Vector3,
    axisEndMm: Vector3,
    radiusMm: number,
    turns: number,
    radialDirection: Vector3,
    handedness: "right" | "left",
    revision?: string,
  ): Promise<RuntimeState> {
    if (revision) await this.assertRevision(revision);
    if (!Number.isFinite(radiusMm) || radiusMm <= 0) throw new Error("Helix radius must be positive");
    if (!Number.isFinite(turns) || turns <= 0) throw new Error("Helix turns must be positive");
    turns = requireWholeHelixTurns(turns);
    const axis = axisEndMm.map((value, index) => value - axisStartMm[index]!) as Vector3;
    const axisLength = Math.hypot(...axis);
    if (!(axisLength > 1e-9)) throw new Error("Helix axis must have nonzero length");
    const axisUnit = axis.map((value) => value / axisLength) as Vector3;
    const projection = radialDirection.reduce((sum, value, index) => sum + value * axisUnit[index]!, 0);
    const radial = radialDirection.map((value, index) => value - projection * axisUnit[index]!) as Vector3;
    const radialLength = Math.hypot(...radial);
    if (!(radialLength > 1e-9)) throw new Error("Helix radial direction must not be parallel to its axis");
    const radiusPointMm = axisEndMm.map((value, index) => value + radial[index]! / radialLength * radiusMm) as Vector3;
    await this.runtime.mutate(`async function (Factory, Vector, args) {
      ${commandStart("SpiralCommand")}
      factory.p1 = new Vector(...args.axisStart);
      factory.p2 = new Vector(...args.axisEnd);
      factory.p3 = new Vector(...args.radiusPoint);
      factory.radius = args.radius;
      factory.turns = args.turns;
      factory.spiralPitch = 0;
      factory.handedness = args.handedness;
      ${commandEnd}
    }`, ["SpiralFactory", "Vector3"], [{
      axisStart: toMeters(axisStartMm),
      axisEnd: toMeters(axisEndMm),
      radiusPoint: toMeters(radiusPointMm),
      radius: millimetersToMeters(radiusMm),
      turns,
      handedness: handedness === "right",
    }]);
    return await this.state();
  }

  async createCircle(
    centerMm: Vector3 | Vector2,
    radiusMm: number,
    revision?: string,
    normal: Vector3 = [0, 0, 1],
    plane?: ReferenceIdentity,
  ): Promise<RuntimeState> {
    let worldCenter: Vector3;
    let worldNormal = normal;
    if (plane) {
      if (centerMm.length !== 2) throw new Error("Plane-local circle centers must contain two coordinates");
      const resolvedPlane = await this.resolveCurrentPlane(plane, revision);
      worldCenter = localPointToWorld(resolvedPlane, centerMm);
      worldNormal = resolvedPlane.normal;
    } else {
      if (centerMm.length !== 3) throw new Error("World-space circle centers must contain three coordinates");
      if (revision) await this.assertRevision(revision);
      worldCenter = centerMm;
    }
    await this.runtime.mutate(`async function (Factory, Vector, Quaternion, args) {
      ${commandStart("CenterCircleCommand")}
      factory.center.fromArray(args.center);
      factory.orientation.copy(new Quaternion().setFromUnitVectors(new Vector(0, 0, 1), new Vector(...args.normal).normalize()));
      factory.point.copy(factory.center).add(new Vector(args.radius, 0, 0).applyQuaternion(factory.orientation));
      ${commandEnd}
    }`, ["CenterCircleFactory", "Vector3", "Quaternion"], [{ center: toMeters(worldCenter), radius: millimetersToMeters(radiusMm), normal: worldNormal }]);
    return await this.state();
  }

  async createTwoPointCircle(
    diameterStartMm: Vector3 | Vector2,
    diameterEndMm: Vector3 | Vector2,
    revision?: string,
    normal: Vector3 = [0, 0, 1],
    plane?: ReferenceIdentity,
  ): Promise<RuntimeState> {
    let diameterStart: Vector3;
    let diameterEnd: Vector3;
    let worldNormal: Vector3;
    if (plane) {
      if (diameterStartMm.length !== 2 || diameterEndMm.length !== 2) {
        throw new Error("Plane-local two-point circle endpoints must contain two coordinates");
      }
      const resolvedPlane = await this.resolveCurrentPlane(plane, revision);
      diameterStart = localPointToWorld(resolvedPlane, diameterStartMm);
      diameterEnd = localPointToWorld(resolvedPlane, diameterEndMm);
      worldNormal = normalize(resolvedPlane.normal, "Two-point circle plane normal");
    } else {
      if (diameterStartMm.length !== 3 || diameterEndMm.length !== 3) {
        throw new Error("World-space two-point circle endpoints must contain three coordinates");
      }
      if (revision) await this.assertRevision(revision);
      diameterStart = diameterStartMm;
      diameterEnd = diameterEndMm;
      worldNormal = normalize(normal, "Two-point circle plane normal");
    }
    const diameter = subtract(diameterEnd, diameterStart);
    const diameterLength = Math.hypot(...diameter);
    if (diameterLength <= 1e-9) throw new Error("Two-point circle diameter endpoints must be distinct");
    if (Math.abs(dot(diameter, worldNormal)) > diameterLength * 1e-9) {
      throw new Error("Two-point circle plane normal must be perpendicular to its diameter");
    }
    await this.runtime.mutate(`async function (Factory, Vector, Quaternion, args) {
      ${commandStart("TwoPointCircleCommand")}
      factory.isKnife = false;
      factory.orientation.copy(new Quaternion().setFromUnitVectors(new Vector(0, 0, 1), new Vector(...args.normal).normalize()));
      factory.p1.fromArray(args.diameterStart);
      factory.p2.fromArray(args.diameterEnd);
      ${commandEnd}
    }`, ["KnifeTwoPointCircleFactory", "Vector3", "Quaternion"], [{
      diameterStart: toMeters(diameterStart),
      diameterEnd: toMeters(diameterEnd),
      normal: worldNormal,
    }]);
    return await this.state();
  }

  async createThreePointCircle(
    firstMm: Vector3 | Vector2,
    secondMm: Vector3 | Vector2,
    thirdMm: Vector3 | Vector2,
    revision?: string,
    plane?: ReferenceIdentity,
  ): Promise<RuntimeState> {
    let first: Vector3;
    let second: Vector3;
    let third: Vector3;
    if (plane) {
      if (firstMm.length !== 2 || secondMm.length !== 2 || thirdMm.length !== 2) {
        throw new Error("Plane-local three-point circle points must contain two coordinates");
      }
      const resolvedPlane = await this.resolveCurrentPlane(plane, revision);
      first = localPointToWorld(resolvedPlane, firstMm);
      second = localPointToWorld(resolvedPlane, secondMm);
      third = localPointToWorld(resolvedPlane, thirdMm);
    } else {
      if (firstMm.length !== 3 || secondMm.length !== 3 || thirdMm.length !== 3) {
        throw new Error("World-space three-point circle points must contain three coordinates");
      }
      if (revision) await this.assertRevision(revision);
      first = firstMm;
      second = secondMm;
      third = thirdMm;
    }
    threePointCircleGeometry(first, second, third, "Three-point circle");
    await this.runtime.mutate(`async function (Factory, args) {
      ${commandStart("ThreePointCircleCommand")}
      factory.isKnife = false;
      factory.p1.fromArray(args.first);
      factory.p2.fromArray(args.second);
      factory.p3.fromArray(args.third);
      ${commandEnd}
    }`, ["KnifeThreePointCircleFactory"], [{
      first: toMeters(first),
      second: toMeters(second),
      third: toMeters(third),
    }]);
    return await this.state();
  }

  async createCenterArc(
    centerMm: Vector3 | Vector2,
    radiusMm: number,
    startAngleDegrees: number,
    sweepAngleDegrees: number,
    revision?: string,
    normal: Vector3 = [0, 0, 1],
    xDirection: Vector3 = [1, 0, 0],
    plane?: ReferenceIdentity,
  ): Promise<RuntimeState> {
    if (!Number.isFinite(radiusMm) || radiusMm <= 0) throw new Error("Arc radius must be positive");
    if (!Number.isFinite(startAngleDegrees)) throw new Error("Arc start angle must be finite");
    if (!Number.isFinite(sweepAngleDegrees) || sweepAngleDegrees === 0 || Math.abs(sweepAngleDegrees) >= 360) {
      throw new Error("Arc sweep angle must be nonzero and have magnitude less than 360 degrees");
    }
    let worldCenter: Vector3;
    let baseX: Vector3;
    let baseY: Vector3;
    let worldNormal: Vector3;
    if (plane) {
      if (centerMm.length !== 2) throw new Error("Plane-local arc centers must contain two coordinates");
      const resolvedPlane = await this.resolveCurrentPlane(plane, revision);
      worldCenter = localPointToWorld(resolvedPlane, centerMm);
      baseX = resolvedPlane.xDirection;
      baseY = resolvedPlane.yDirection;
      worldNormal = resolvedPlane.normal;
    } else {
      if (centerMm.length !== 3) throw new Error("World-space arc centers must contain three coordinates");
      if (revision) await this.assertRevision(revision);
      const frame = frameFromOriginNormalX(centerMm, normal, xDirection);
      worldCenter = frame.originMm;
      baseX = frame.xDirection;
      baseY = frame.yDirection;
      worldNormal = frame.normal;
    }
    const pointAt = (degrees: number): Vector3 => {
      const radians = degreesToRadians(degrees);
      return add(worldCenter, scale(add(scale(baseX, Math.cos(radians)), scale(baseY, Math.sin(radians))), radiusMm));
    };
    const start = pointAt(startAngleDegrees);
    const end = pointAt(startAngleDegrees + sweepAngleDegrees);
    await this.runtime.mutate(`async function (Factory, Vector, Quaternion, args) {
      ${commandStart("CenterPointArcCommand")}
      factory.isKnife = false;
      factory.center.fromArray(args.center);
      factory.orientation.copy(new Quaternion().setFromUnitVectors(new Vector(0, 0, 1), new Vector(...args.normal).normalize()));
      factory.p2.fromArray(args.start);
      factory.p3.fromArray(args.end);
      factory.lastSense = true;
      ${commandEnd}
    }`, ["KnifeCenterPointArcFactory", "Vector3", "Quaternion"], [{
      center: toMeters(worldCenter),
      start: toMeters(start),
      end: toMeters(end),
      normal: sweepAngleDegrees > 0 ? worldNormal : scale(worldNormal, -1),
    }]);
    return await this.state();
  }

  async createThreePointArc(
    startMm: Vector3 | Vector2,
    throughMm: Vector3 | Vector2,
    endMm: Vector3 | Vector2,
    revision?: string,
    plane?: ReferenceIdentity,
  ): Promise<RuntimeState> {
    let start: Vector3;
    let through: Vector3;
    let end: Vector3;
    if (plane) {
      if (startMm.length !== 2 || throughMm.length !== 2 || endMm.length !== 2) {
        throw new Error("Plane-local three-point arc points must contain two coordinates");
      }
      const resolvedPlane = await this.resolveCurrentPlane(plane, revision);
      start = localPointToWorld(resolvedPlane, startMm);
      through = localPointToWorld(resolvedPlane, throughMm);
      end = localPointToWorld(resolvedPlane, endMm);
    } else {
      if (startMm.length !== 3 || throughMm.length !== 3 || endMm.length !== 3) {
        throw new Error("World-space three-point arc points must contain three coordinates");
      }
      if (revision) await this.assertRevision(revision);
      start = startMm;
      through = throughMm;
      end = endMm;
    }
    const { center, normal } = threePointCircleGeometry(start, through, end, "Three-point arc");
    await this.runtime.mutate(`async function (Factory, Vector, Quaternion, args) {
      ${commandStart("ThreePointArcCommand")}
      factory.isKnife = false;
      factory.center.fromArray(args.center);
      factory.orientation.copy(new Quaternion().setFromUnitVectors(new Vector(0, 0, 1), new Vector(...args.normal).normalize()));
      factory.p2.fromArray(args.start);
      factory.p3.fromArray(args.end);
      factory.lastSense = true;
      ${commandEnd}
    }`, ["KnifeCenterPointArcFactory", "Vector3", "Quaternion"], [{
      center: toMeters(center),
      start: toMeters(start),
      end: toMeters(end),
      normal,
    }]);
    return await this.state();
  }

  async createTangentArc(
    bodyId: number,
    segmentEntityId: number,
    startAt: "start" | "end",
    endMm: Vector3 | Vector2,
    flipTangent: boolean,
    revision: string,
    plane?: ReferenceIdentity,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (state.bodies.find((body) => body.id === bodyId)?.type !== "Wire") {
      throw new Error(`Tangent arc requires a current Wire body: ${bodyId}`);
    }
    if (!Number.isInteger(segmentEntityId) || segmentEntityId <= 0) {
      throw new Error("Tangent arc segment entity ID must be a positive integer");
    }
    let worldEnd: Vector3;
    if (plane) {
      if (endMm.length !== 2) throw new Error("Plane-local tangent arc end must contain two coordinates");
      const resolvedPlane = await this.resolveCurrentPlane(plane, revision);
      worldEnd = localPointToWorld(resolvedPlane, endMm);
    } else {
      if (endMm.length !== 3) throw new Error("World-space tangent arc end must contain three coordinates");
      worldEnd = endMm;
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, Vector, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const wire = find(args.bodyId);
      if (wire?.constructor?.name !== 'Wire') throw new Error('Tangent arc source is no longer a Wire');
      let segment;
      let edge;
      for (const candidate of Array.from(wire.segments ?? [])) {
        const model = nativeApi.db.lookupTopologyItem(candidate);
        if (Number(model?.Id?.()) !== args.segmentEntityId) continue;
        segment = candidate;
        edge = model;
        break;
      }
      if (!segment || !edge) throw new Error('Stale or unknown tangent arc segment: ' + args.segmentEntityId);
      const parameter = args.startAt === 'start' ? 0 : 1;
      const anchor = edge.GetPointAndTangent(parameter);
      const endpoint = new Vector(...args.end);
      const dx = endpoint.x - anchor.position.x;
      const dy = endpoint.y - anchor.position.y;
      const dz = endpoint.z - anchor.position.z;
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      if (distanceSquared <= 1e-24) throw new Error('Tangent arc end must differ from its source endpoint');
      const tangent = anchor.tangent;
      const cx = tangent.y * dz - tangent.z * dy;
      const cy = tangent.z * dx - tangent.x * dz;
      const cz = tangent.x * dy - tangent.y * dx;
      if (cx * cx + cy * cy + cz * cz <= 1e-24 * distanceSquared) {
        throw new Error('Tangent arc end must not lie on the source tangent line');
      }
      let failure;
      const command = new editor.commands.TangentArcCommand(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.segment = segment;
          factory.point1.copy(anchor.position);
          factory.point2.copy(endpoint);
          factory.flipTangent = args.flipTangent;
          return await factory.commit();
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["TangentArcFactory", "Vector3"], [{
      bodyId,
      segmentEntityId,
      startAt,
      end: toMeters(worldEnd),
      flipTangent,
    }]);
    return await this.state();
  }

  async createTangentCircle(
    first: CurveSegmentReference,
    second: CurveSegmentReference,
    solutionPointMm: Vector3 | Vector2,
    radiusMm: number,
    revision: string,
    normal: Vector3 = [0, 0, 1],
    plane?: ReferenceIdentity,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (first.bodyId === second.bodyId && first.segmentEntityId === second.segmentEntityId) {
      throw new Error("Tangent-circle segment references must be different");
    }
    if (!Number.isFinite(radiusMm) || radiusMm <= 0) throw new Error("Tangent-circle radius must be positive");
    const invalidBodies = [first, second].filter((reference) =>
      state.bodies.find((body) => body.id === reference.bodyId)?.type !== "Wire");
    if (invalidBodies.length > 0) {
      throw new Error(`Tangent circle requires current Wire bodies: ${invalidBodies.map((reference) => reference.bodyId).join(", ")}`);
    }

    let worldSolutionPoint: Vector3;
    let worldNormal: Vector3;
    if (plane) {
      if (solutionPointMm.length !== 2) throw new Error("Plane-local tangent-circle solution points must contain two coordinates");
      const resolvedPlane = await this.resolveCurrentPlane(plane, revision);
      worldSolutionPoint = localPointToWorld(resolvedPlane, solutionPointMm);
      worldNormal = resolvedPlane.normal;
    } else {
      if (solutionPointMm.length !== 3) throw new Error("World-space tangent-circle solution points must contain three coordinates");
      worldSolutionPoint = solutionPointMm;
      worldNormal = normalize(normal, "Tangent-circle plane normal");
    }

    const report = await this.listCurveDirections();
    if (report.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${report.revision}`);
    }
    for (const reference of [first, second]) {
      const curve = report.curves.find((candidate) => candidate.id === reference.bodyId);
      if (!curve?.segments.some((segment) => segment.entityId === reference.segmentEntityId)) {
        throw new Error(`Stale or unknown tangent-circle segment: ${reference.bodyId}:${reference.segmentEntityId}`);
      }
    }

    await this.runtime.mutate(nativeFunction`async function (Factory, Command, Vector, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const segment = reference => {
        const wire = find(reference.bodyId);
        if (wire?.constructor?.name !== 'Wire') throw new Error('Tangent-circle source is no longer a Wire');
        for (const candidate of Array.from(wire.segments ?? [])) {
          const edge = nativeApi.db.lookupTopologyItem(candidate);
          if (Number(edge?.Id?.()) === reference.segmentEntityId) return candidate;
        }
        throw new Error('Stale or unknown tangent-circle segment: ' + reference.bodyId + ':' + reference.segmentEntityId);
      };
      editor.selection.selected.removeAll();
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.segment1 = segment(args.first);
          factory.segment2 = segment(args.second);
          factory.point.copy(new Vector(...args.solutionPoint));
          factory.normal.copy(new Vector(...args.normal));
          factory.radius = args.radius;
          return await factory.commit();
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["TangentCircleFactory", "TangentCircleCommand", "Vector3"], [{
      first,
      second,
      solutionPoint: toMeters(worldSolutionPoint),
      normal: worldNormal,
      radius: millimetersToMeters(radiusMm),
    }]);
    return await this.state();
  }

  async bridgeCurves(
    first: CurveSegmentEndpointReference,
    second: CurveSegmentEndpointReference,
    startContinuity: "G0" | "G1" | "G2" | "G3",
    endContinuity: "G0" | "G1" | "G2" | "G3",
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    const references = [first, second];
    const invalidBodies = references.filter((reference) =>
      state.bodies.find((body) => body.id === reference.bodyId)?.type !== "Wire");
    if (invalidBodies.length > 0) {
      throw new Error(`Curve Bridge requires current Wire bodies: ${invalidBodies.map((reference) => reference.bodyId).join(", ")}`);
    }
    if (first.bodyId === second.bodyId && first.segmentEntityId === second.segmentEntityId && first.at === second.at) {
      throw new Error("Curve Bridge endpoint references must be different");
    }
    const report = await this.listCurveDirections();
    if (report.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${report.revision}`);
    }
    const resolve = (reference: CurveSegmentEndpointReference): Vector3 => {
      const curve = report.curves.find((candidate) => candidate.id === reference.bodyId);
      const segment = curve?.segments.find((candidate) => candidate.entityId === reference.segmentEntityId);
      if (!segment) throw new Error(`Stale or unknown Curve Bridge segment: ${reference.bodyId}:${reference.segmentEntityId}`);
      return reference.at === "start" ? segment.startMm : segment.endMm;
    };
    const firstPoint = resolve(first);
    const secondPoint = resolve(second);
    if (dot(subtract(secondPoint, firstPoint), subtract(secondPoint, firstPoint)) <= 1e-18) {
      throw new Error("Curve Bridge endpoints must be distinct");
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, Continuity, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const segment = reference => {
        const wire = find(reference.bodyId);
        if (wire?.constructor?.name !== 'Wire') throw new Error('Curve Bridge source is no longer a Wire');
        for (const candidate of Array.from(wire.segments ?? [])) {
          const edge = nativeApi.db.lookupTopologyItem(candidate);
          if (Number(edge?.Id?.()) === reference.segmentEntityId) return candidate;
        }
        throw new Error('Stale or unknown Curve Bridge segment: ' + reference.bodyId + ':' + reference.segmentEntityId);
      };
      let failure;
      const command = new editor.commands.BridgeCurveCommand(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.start = segment(args.first);
          factory.t1 = args.first.at === 'start' ? 0 : 1;
          factory.end = segment(args.second);
          factory.t2 = args.second.at === 'start' ? 0 : 1;
          factory.startCurvature = Continuity[args.startContinuity];
          factory.endCurvature = Continuity[args.endContinuity];
          factory.trim = false;
          factory.pickClosestSenses();
          return await factory.commit();
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["BridgeCurveFactory", "ContinuityType"], [{
      first,
      second,
      startContinuity,
      endContinuity,
    }]);
    return await this.state();
  }

  async bridgeShellEdges(
    first: ShellEdgeEndpointReference,
    second: ShellEdgeEndpointReference,
    startContinuity: "G0" | "G1" | "G2" | "G3",
    endContinuity: "G0" | "G1" | "G2" | "G3",
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    const references = [first, second];
    if (first.bodyId === second.bodyId && first.edgeId === second.edgeId) {
      throw new Error("Shell Edge Bridge requires two different source edges");
    }
    requireTopologySelection(state, references, "edge");
    const resolved = references.map((reference, index) => {
      const body = state.bodies.find((candidate) => candidate.id === reference.bodyId)!;
      if (body.type !== "Solid" && body.type !== "Sheet") {
        throw new Error(`Shell Edge Bridge source ${index + 1} must belong to a Solid or Sheet`);
      }
      const edge = body.edges.find((candidate) => candidate.id === reference.edgeId)!;
      if (!edge.vertexIds.includes(reference.vertexId)) {
        throw new Error(`Shell Edge Bridge vertex ${reference.vertexId} is not an endpoint of ${reference.bodyId}:${reference.edgeId}`);
      }
      const vertex = body.vertices?.find((candidate) => candidate.id === reference.vertexId);
      if (!vertex) throw new Error(`Shell Edge Bridge requires current native B-Rep vertex ${reference.bodyId}:${reference.vertexId}`);
      return { body, edge, vertex };
    });
    const delta = subtract(resolved[1]!.vertex.positionMm, resolved[0]!.vertex.positionMm);
    if (dot(delta, delta) <= 1e-18) throw new Error("Shell Edge Bridge endpoints must be distinct");

    await this.runtime.mutate(nativeFunction`async function (Factory, Command, Continuity, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const edge = reference => {
        const view = find(reference.bodyId);
        if (view?.constructor?.name !== 'Solid' && view?.constructor?.name !== 'Sheet') {
          throw new Error('Shell Edge Bridge source is no longer a Solid or Sheet');
        }
        const index = view.high.edges.versionIds.indexOf(reference.edgeId);
        if (index < 0) throw new Error('Stale or unknown Shell Edge Bridge edge: ' + reference.bodyId + ':' + reference.edgeId);
        return view.high.edges.get(index);
      };
      const matches = (position, expected) => position &&
        (position.x - expected[0]) ** 2 +
        (position.y - expected[1]) ** 2 +
        (position.z - expected[2]) ** 2 <= 1e-18;
      editor.selection.selected.removeAll();
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          nativeApi.initializeBridge(factory, edge(args.first), edge(args.second), 'edge');
          if (!matches(factory.startPosition, args.firstPosition)) nativeApi.flipBridgeEnd(factory, 1);
          if (!matches(factory.endPosition, args.secondPosition)) nativeApi.flipBridgeEnd(factory, 2);
          if (!matches(factory.startPosition, args.firstPosition) || !matches(factory.endPosition, args.secondPosition)) {
            throw new Error('Requested Shell Edge Bridge endpoints are unavailable');
          }
          factory.startCurvature = Continuity[args.startContinuity];
          factory.endCurvature = Continuity[args.endContinuity];
          factory.lockDistances = true;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["BridgeEdgeFactory", "BridgeEdgeCommand", "ContinuityType"], [{
      first,
      second,
      firstPosition: toMeters(resolved[0]!.vertex.positionMm),
      secondPosition: toMeters(resolved[1]!.vertex.positionMm),
      startContinuity,
      endContinuity,
    }]);
    return await this.state();
  }

  async bridgeCurveVertices(
    first: VertexReference,
    second: VertexReference,
    startContinuity: "G0" | "G1" | "G2" | "G3",
    endContinuity: "G0" | "G1" | "G2" | "G3",
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (first.bodyId === second.bodyId && first.vertexId === second.vertexId) {
      throw new Error("Curve Vertex Bridge endpoint references must be different");
    }
    const bodies = new Map(state.bodies.map((body) => [body.id, body]));
    const references = [first, second];
    const missingBodies = references.filter((reference) => !bodies.has(reference.bodyId));
    if (missingBodies.length > 0) {
      throw new Error(`Unknown current Curve Vertex Bridge body IDs: ${missingBodies.map((reference) => reference.bodyId).join(", ")}`);
    }
    const invalidBodies = references.filter((reference) => bodies.get(reference.bodyId)!.type !== "Wire");
    if (invalidBodies.length > 0) {
      throw new Error(`Curve Vertex Bridge requires current Wire bodies: ${invalidBodies.map((reference) => reference.bodyId).join(", ")}`);
    }
    const inventory = await this.listCurveVertices();
    if (inventory.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${inventory.revision}`);
    }
    const resolved = references.map((reference) => {
      const vertex = inventory.vertices.find((candidate) =>
        candidate.bodyId === reference.bodyId && candidate.vertexId === reference.vertexId);
      if (!vertex) {
        throw new Error(`Stale or unknown Curve Vertex Bridge vertex: ${reference.bodyId}:${reference.vertexId}`);
      }
      if (!vertex.endpoint) {
        throw new Error(`Curve Vertex Bridge requires an open Wire endpoint: ${reference.bodyId}:${reference.vertexId}`);
      }
      return vertex;
    });
    const delta = subtract(resolved[1]!.positionMm, resolved[0]!.positionMm);
    if (dot(delta, delta) <= 1e-18) throw new Error("Curve Vertex Bridge endpoints must be distinct");

    await this.runtime.mutate(nativeFunction`async function (Factory, Command, Continuity, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const vertex = reference => {
        const wire = find(reference.bodyId);
        if (wire?.constructor?.name !== 'Wire') throw new Error('Curve Vertex Bridge source is no longer a Wire');
        for (const candidate of Array.from(wire.vertices ?? [])) {
          const model = nativeApi.db.lookupTopologyItem(candidate);
          if (Number(model?.Id?.()) === reference.vertexId) return nativeApi.bridgeVertex(wire, candidate);
        }
        throw new Error('Stale or unknown Curve Vertex Bridge vertex: ' + reference.bodyId + ':' + reference.vertexId);
      };
      const matches = (position, expected) => position &&
        (position.x - expected[0]) ** 2 +
        (position.y - expected[1]) ** 2 +
        (position.z - expected[2]) ** 2 <= 1e-18;
      editor.selection.selected.removeAll();
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          nativeApi.initializeBridge(factory, vertex(args.first), vertex(args.second), 'vertex');
          if (!matches(factory.startPosition, args.firstPosition) || !matches(factory.endPosition, args.secondPosition)) {
            throw new Error('Requested Curve Vertex Bridge endpoints are unavailable');
          }
          factory.startCurvature = Continuity[args.startContinuity];
          factory.endCurvature = Continuity[args.endContinuity];
          factory.lockDistances = true;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["BridgeVertexFactory", "BridgeVertexCommand", "ContinuityType"], [{
      first,
      second,
      firstPosition: toMeters(resolved[0]!.positionMm),
      secondPosition: toMeters(resolved[1]!.positionMm),
      startContinuity,
      endContinuity,
    }]);
    return await this.state();
  }

  async createEllipse(
    centerMm: Vector3 | Vector2,
    majorRadiusMm: number,
    minorRadiusMm: number,
    revision?: string,
    normal: Vector3 = [0, 0, 1],
    xDirection: Vector3 = [1, 0, 0],
    plane?: ReferenceIdentity,
    angleDegrees = 0,
  ): Promise<RuntimeState> {
    if (!Number.isFinite(majorRadiusMm) || majorRadiusMm <= 0) throw new Error("Ellipse major radius must be positive");
    if (!Number.isFinite(minorRadiusMm) || minorRadiusMm <= 0) throw new Error("Ellipse minor radius must be positive");
    if (minorRadiusMm > majorRadiusMm) throw new Error("Ellipse minor radius must not exceed its major radius");
    if (!Number.isFinite(angleDegrees)) throw new Error("Ellipse angle must be finite");
    let worldCenter: Vector3;
    let baseX: Vector3;
    let baseY: Vector3;
    let worldNormal: Vector3;
    if (plane) {
      if (centerMm.length !== 2) throw new Error("Plane-local ellipse centers must contain two coordinates");
      const resolvedPlane = await this.resolveCurrentPlane(plane, revision);
      worldCenter = localPointToWorld(resolvedPlane, centerMm);
      baseX = resolvedPlane.xDirection;
      baseY = resolvedPlane.yDirection;
      worldNormal = resolvedPlane.normal;
    } else {
      if (centerMm.length !== 3) throw new Error("World-space ellipse centers must contain three coordinates");
      if (revision) await this.assertRevision(revision);
      const frame = frameFromOriginNormalX(centerMm, normal, xDirection);
      worldCenter = frame.originMm;
      baseX = frame.xDirection;
      baseY = frame.yDirection;
      worldNormal = frame.normal;
    }
    const radians = degreesToRadians(angleDegrees);
    const majorDirection = add(scale(baseX, Math.cos(radians)), scale(baseY, Math.sin(radians)));
    const minorDirection = add(scale(baseY, Math.cos(radians)), scale(baseX, -Math.sin(radians)));
    const majorPoint = add(worldCenter, scale(majorDirection, majorRadiusMm));
    const minorPoint = add(worldCenter, scale(minorDirection, minorRadiusMm));
    await this.runtime.mutate(`async function (Factory, Vector, Quaternion, args) {
      ${commandStart("EllipseCommand")}
      factory.isKnife = false;
      factory.center.fromArray(args.center);
      factory.orientation.copy(new Quaternion().setFromUnitVectors(new Vector(0, 0, 1), new Vector(...args.normal).normalize()));
      factory.point1.fromArray(args.majorPoint);
      factory.point2.fromArray(args.minorPoint);
      ${commandEnd}
    }`, ["KnifeEllipseFactory", "Vector3", "Quaternion"], [{
      center: toMeters(worldCenter),
      majorPoint: toMeters(majorPoint),
      minorPoint: toMeters(minorPoint),
      normal: worldNormal,
    }]);
    return await this.state();
  }

  async createRegularPolygon(
    centerMm: Vector3 | Vector2,
    radiusMm: number,
    radiusMode: "circumradius" | "inradius",
    vertexCount: number,
    revision?: string,
    normal: Vector3 = [0, 0, 1],
    xDirection: Vector3 = [1, 0, 0],
    plane?: ReferenceIdentity,
    angleDegrees = 0,
  ): Promise<RuntimeState> {
    if (!Number.isFinite(radiusMm) || radiusMm <= 0) throw new Error("Polygon radius must be positive");
    if (!Number.isInteger(vertexCount) || vertexCount < 3 || vertexCount > 256) throw new Error("Polygon vertex count must be an integer from 3 to 256");
    if (radiusMode !== "circumradius" && radiusMode !== "inradius") throw new Error(`Unsupported polygon radius mode: ${String(radiusMode)}`);
    if (!Number.isFinite(angleDegrees)) throw new Error("Polygon angle must be finite");
    let worldCenter: Vector3;
    let baseX: Vector3;
    let baseY: Vector3;
    let worldNormal: Vector3;
    if (plane) {
      if (centerMm.length !== 2) throw new Error("Plane-local polygon centers must contain two coordinates");
      const resolvedPlane = await this.resolveCurrentPlane(plane, revision);
      worldCenter = localPointToWorld(resolvedPlane, centerMm);
      baseX = resolvedPlane.xDirection;
      baseY = resolvedPlane.yDirection;
      worldNormal = resolvedPlane.normal;
    } else {
      if (centerMm.length !== 3) throw new Error("World-space polygon centers must contain three coordinates");
      if (revision) await this.assertRevision(revision);
      const frame = frameFromOriginNormalX(centerMm, normal, xDirection);
      worldCenter = frame.originMm;
      baseX = frame.xDirection;
      baseY = frame.yDirection;
      worldNormal = frame.normal;
    }
    const radians = degreesToRadians(angleDegrees);
    const radialDirection = add(scale(baseX, Math.cos(radians)), scale(baseY, Math.sin(radians)));
    const point = add(worldCenter, scale(radialDirection, radiusMm));
    await this.runtime.mutate(`async function (Factory, Vector, Quaternion, args) {
      ${commandStart("PolygonCommand")}
      factory.isKnife = false;
      factory.center.fromArray(args.center);
      factory.orientation.copy(new Quaternion().setFromUnitVectors(new Vector(0, 0, 1), new Vector(...args.normal).normalize()));
      factory.circumscribedOrInscribed = args.radiusMode === 'circumradius' ? 'inscribed' : 'circumscribed';
      factory.point.fromArray(args.point);
      factory.vertexCount = args.vertexCount;
      ${commandEnd}
    }`, ["KnifePolygonFactory", "Vector3", "Quaternion"], [{
      center: toMeters(worldCenter),
      point: toMeters(point),
      normal: worldNormal,
      radiusMode,
      vertexCount,
    }]);
    return await this.state();
  }

  async createRectangle(
    centerMm: Vector3 | Vector2,
    widthMm: number,
    heightMm: number,
    revision?: string,
    normal: Vector3 = [0, 0, 1],
    xDirection: Vector3 = [1, 0, 0],
    plane?: ReferenceIdentity,
    angleDegrees = 0,
  ): Promise<RuntimeState> {
    if (!Number.isFinite(widthMm) || widthMm <= 0) throw new Error("Rectangle width must be positive");
    if (!Number.isFinite(heightMm) || heightMm <= 0) throw new Error("Rectangle height must be positive");
    const radians = degreesToRadians(angleDegrees);
    let worldCenter: Vector3;
    let baseX: Vector3;
    let baseY: Vector3;
    if (plane) {
      if (centerMm.length !== 2) throw new Error("Plane-local rectangle centers must contain two coordinates");
      const resolvedPlane = await this.resolveCurrentPlane(plane, revision);
      worldCenter = localPointToWorld(resolvedPlane, centerMm);
      baseX = resolvedPlane.xDirection;
      baseY = resolvedPlane.yDirection;
    } else {
      if (centerMm.length !== 3) throw new Error("World-space rectangle centers must contain three coordinates");
      if (revision) await this.assertRevision(revision);
      const frame = frameFromOriginNormalX(centerMm, normal, xDirection);
      worldCenter = frame.originMm;
      baseX = frame.xDirection;
      baseY = frame.yDirection;
    }
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const rectangleX = add(scale(baseX, cosine), scale(baseY, sine));
    const rectangleY = add(scale(baseY, cosine), scale(baseX, -sine));
    const halfWidth = scale(rectangleX, widthMm / 2);
    const halfHeight = scale(rectangleY, heightMm / 2);
    const p1 = subtract(subtract(worldCenter, halfWidth), halfHeight);
    const p2 = add(subtract(worldCenter, halfHeight), halfWidth);
    const p3 = add(add(worldCenter, halfWidth), halfHeight);
    await this.runtime.mutate(`async function (Factory, Vector, args) {
      ${commandStart("ThreePointRectangleCommand")}
      factory.p1 = new Vector(...args.p1);
      factory.p2 = new Vector(...args.p2);
      factory.p3 = new Vector(...args.p3);
      ${commandEnd}
    }`, ["ThreePointRectangleFactory", "Vector3"], [{ p1: toMeters(p1), p2: toMeters(p2), p3: toMeters(p3) }]);
    return await this.state();
  }

  async createText(input: CreateTextInput): Promise<RuntimeState> {
    if (input.text.trim().length === 0) throw new Error("Text must be nonempty");
    if (!Number.isFinite(input.fontSizeMm) || input.fontSizeMm <= 0) throw new Error("Text font size must be positive");
    const font = input.font ?? "inter";
    if (font !== "inter") throw new Error(`Unsupported Plasticity text font: ${font}`);
    const radians = degreesToRadians(input.angleDegrees ?? 0);
    let worldOrigin: Vector3;
    let baseX: Vector3;
    let baseY: Vector3;
    let planeNormal: Vector3;
    if (input.plane) {
      if (input.originMm.length !== 2) throw new Error("Plane-local text origins must contain two coordinates");
      const resolvedPlane = await this.resolveCurrentPlane(input.plane, input.revision);
      worldOrigin = localPointToWorld(resolvedPlane, input.originMm);
      baseX = resolvedPlane.xDirection;
      baseY = resolvedPlane.yDirection;
      planeNormal = resolvedPlane.normal;
    } else {
      if (input.originMm.length !== 3) throw new Error("World-space text origins must contain three coordinates");
      if (input.revision) await this.assertRevision(input.revision);
      const frame = frameFromOriginNormalX(input.originMm, input.normal ?? [0, 0, 1], input.xDirection ?? [1, 0, 0]);
      worldOrigin = frame.originMm;
      baseX = frame.xDirection;
      baseY = frame.yDirection;
      planeNormal = frame.normal;
    }
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const textX = add(scale(baseX, cosine), scale(baseY, sine));
    const textY = add(scale(baseY, cosine), scale(baseX, -sine));
    const rotate = !vectorsNear(textX, [1, 0, 0]) || !vectorsNear(textY, [0, 1, 0]) || !vectorsNear(planeNormal, [0, 0, 1]);
    const move = Math.hypot(...worldOrigin) > 1e-12;
    await this.runtime.mutate(nativeFunction`async function (TextFactory, RotateFactory, MoveFactory, Vector, Matrix, Quaternion, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.CurveCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const text = new TextFactory(editor).resource(this);
          text.text = args.text;
          text.font = args.font;
          text.size = args.size;
          let views = await text.commit();
          views = Array.isArray(views) ? views : [views];
          if (args.rotate) {
            const rotate = new RotateFactory(editor).resource(this);
            rotate.items = views;
            rotate.pivot.fromArray([0, 0, 0]);
            rotate.rotation.copy(new Quaternion().setFromRotationMatrix(
              new Matrix().makeBasis(new Vector(...args.x), new Vector(...args.y), new Vector(...args.z)),
            ));
            const rotated = await rotate.commit();
            views = Array.isArray(rotated) ? rotated : [rotated];
          }
          if (args.move) {
            const move = new MoveFactory(editor).resource(this);
            move.items = views;
            move.move.fromArray(args.origin);
            const moved = await move.commit();
            views = Array.isArray(moved) ? moved : [moved];
          }
          if (args.name) views.forEach((view, index) => nativeApi.db.nodes.setName(
            nativeApi.db.nodes.item2key(view),
            views.length === 1 ? args.name : args.name + ' ' + (index + 1),
          ));
          return views;
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["TextFactory", "RotateItemAndEmptyFactory", "MoveItemAndEmptyFactory", "Vector3", "Matrix4", "Quaternion"], [{
      text: input.text,
      font,
      size: millimetersToMeters(input.fontSizeMm),
      origin: toMeters(worldOrigin),
      x: textX,
      y: textY,
      z: planeNormal,
      rotate,
      move,
      name: input.name ?? null,
    }]);
    return await this.state();
  }

  async move(ids: number[], deltaMm: Vector3, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("MoveItemCommand")}
      factory.items = args.ids.map(find);
      factory.move.fromArray(args.delta);
      ${commandEndPreservingMeasurementNames}
    }`, ["MoveItemAndEmptyFactory"], [{ ids, delta: toMeters(deltaMm) }]);
    return await this.state();
  }

  async rotate(ids: number[], pivotMm: Vector3, axis: Vector3, degrees: number, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(nativeFunction`async function (Factory, Vector, Quaternion, args) {
      ${findView}
      ${commandStart("RotateItemCommand")}
      factory.items = args.ids.map(find);
      factory.pivot.fromArray(args.pivot);
      factory.rotation.copy(new Quaternion().setFromAxisAngle(new Vector(...args.axis).normalize(), args.radians));
      ${commandEndPreservingMeasurementNames}
    }`, ["RotateItemAndEmptyFactory", "Vector3", "Quaternion"], [{ ids, pivot: toMeters(pivotMm), axis, radians: degreesToRadians(degrees) }]);
    return await this.state();
  }

  async rotateBodiesByXyz(ids: number[], pivotMm: Vector3, rotationDeg: Vector3, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error("At least one unique body ID is required for print orientation");
    for (const id of ids) {
      const body = state.bodies.find((candidate) => candidate.id === id);
      if (!body || body.type !== "Solid" || !body.boundsMm) throw new Error(`Print orientation requires a current bounded native Solid: ${id}`);
    }
    const quaternion: QuaternionXyzw = quaternionFromXyzDegrees(rotationDeg);
    if (Math.hypot(quaternion[0], quaternion[1], quaternion[2]) < 1e-12) throw new Error("Print orientation is zero; no CAD mutation is required");
    await this.runtime.mutate(nativeFunction`async function (Factory, Vector, Quaternion, args) {
      ${findView}
      ${commandStart("RotateItemCommand")}
      factory.items = args.ids.map(find);
      factory.pivot.fromArray(args.pivot);
      factory.rotation.set(args.quaternion[0], args.quaternion[1], args.quaternion[2], args.quaternion[3]);
      ${commandEndPreservingMeasurementNames}
    }`, ["RotateItemAndEmptyFactory", "Vector3", "Quaternion"], [{ ids, pivot: toMeters(pivotMm), quaternion }]);
    return await this.state();
  }

  async scale(ids: number[], pivotMm: Vector3, factors: Vector3, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("ScaleItemCommand")}
      factory.items = args.ids.map(find);
      factory.pivot.fromArray(args.pivot);
      factory.scale.fromArray(args.factors);
      ${commandEndPreservingMeasurementNames}
    }`, ["ProjectingScaleItemAndEmptyFactory"], [{ ids, pivot: toMeters(pivotMm), factors }]);
    return await this.state();
  }

  async setBlockDimensions(
    id: number,
    widthMm: number,
    lengthMm: number,
    heightMm: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    const body = state.bodies.find((candidate) => candidate.id === id);
    if (body?.type !== "Solid") throw new Error(`Block dimension target must be one current Solid: ${id}`);
    for (const [name, value] of [["widthMm", widthMm], ["lengthMm", lengthMm], ["heightMm", heightMm]] as const) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
    }
    await this.runtime.mutate(nativeFunction`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const view = find(args.id);
      this.selection.selected.removeAll();
      this.selection.selected.add(view);

      let collection = null;
      const base = Object.getPrototypeOf(Factory.prototype);
      const descriptor = Object.getOwnPropertyDescriptor(base, 'collection');
      if (!descriptor?.set) throw new Error('Plasticity block dimension collection is unavailable');
      const marker = '__PLASTICITY_MCP_DIMENSION_COLLECTION__';
      Object.defineProperty(base, 'collection', {
        ...descriptor,
        set(value) { collection = value; throw new Error(marker); },
      });
      const probe = new Command(editor);
      try {
        await probe.execute();
      } catch (error) {
        if (String(error?.message ?? error) !== marker) throw error;
      } finally {
        Object.defineProperty(base, 'collection', descriptor);
        try { probe.cancel(); } catch {}
      }
      if (!collection?.HasBlock?.()) throw new Error('Selected Solid is not recognized by Plasticity as a dimensionable block');

      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.collection = collection;
          factory.width = args.width;
          factory.length = args.length;
          factory.height = args.height;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["DimensionBlockCommand", "DimensionBlockFactory"], [{
      id,
      width: millimetersToMeters(widthMm),
      length: millimetersToMeters(lengthMm),
      height: millimetersToMeters(heightMm),
    }]);
    return await this.state();
  }

  async setRadiusDimension(
    face: { bodyId: number; faceId: string },
    radiusMm: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    const currentFace = state.bodies.find((body) => body.id === face.bodyId)?.faces.find((candidate) => candidate.id === face.faceId);
    if (currentFace?.surfaceType !== "Cylinder" || currentFace.radiusMm === null) {
      throw new Error(`Radius dimension target must be one current cylindrical face: ${face.bodyId}:${face.faceId}`);
    }
    if (!Number.isFinite(radiusMm) || radiusMm <= 0) throw new Error("radiusMm must be a positive finite number");
    await this.runtime.mutate(nativeFunction`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const view = find(args.face.bodyId);
      const index = view.high.faces.versionIds.indexOf(args.face.faceId);
      if (index < 0) throw new Error('Stale or unknown face: ' + args.face.faceId);
      this.selection.selected.removeAll();
      nativeApi.selection.addFace(view.high.faces.get(index));

      let collection = null;
      const base = Object.getPrototypeOf(Factory.prototype);
      const descriptor = Object.getOwnPropertyDescriptor(base, 'collection');
      if (!descriptor?.set) throw new Error('Plasticity radius dimension collection is unavailable');
      const marker = '__PLASTICITY_MCP_DIMENSION_COLLECTION__';
      Object.defineProperty(base, 'collection', {
        ...descriptor,
        set(value) { collection = value; throw new Error(marker); },
      });
      const probe = new Command(editor);
      try {
        await probe.execute();
      } catch (error) {
        if (String(error?.message ?? error) !== marker) throw error;
      } finally {
        Object.defineProperty(base, 'collection', descriptor);
        try { probe.cancel(); } catch {}
      }
      if (!collection?.HasRadius?.()) throw new Error('Selected face is not recognized by Plasticity as radius-dimensionable');

      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.collection = collection;
          factory.radius = args.radius;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["DimensionRadiusCommand", "DimensionRadiusFactory"], [{
      face,
      radius: millimetersToMeters(radiusMm),
    }]);
    return await this.state();
  }

  async setRectangleDimensions(
    id: number,
    widthMm: number,
    lengthMm: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    const body = state.bodies.find((candidate) => candidate.id === id);
    if (body?.type !== "Wire" || !state.regions.some((region) => region.sketchWireIds.includes(id))) {
      throw new Error(`Rectangle dimension target must be one current closed planar Wire: ${id}`);
    }
    for (const [name, value] of [["widthMm", widthMm], ["lengthMm", lengthMm]] as const) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
    }
    await this.runtime.mutate(nativeFunction`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const view = find(args.id);
      this.selection.selected.removeAll();
      this.selection.selected.add(view);

      let collection = null;
      const base = Object.getPrototypeOf(Factory.prototype);
      const descriptor = Object.getOwnPropertyDescriptor(base, 'collection');
      if (!descriptor?.set) throw new Error('Plasticity rectangle dimension collection is unavailable');
      const marker = '__PLASTICITY_MCP_DIMENSION_COLLECTION__';
      Object.defineProperty(base, 'collection', {
        ...descriptor,
        set(value) { collection = value; throw new Error(marker); },
      });
      const probe = new Command(editor);
      try {
        await probe.execute();
      } catch (error) {
        if (String(error?.message ?? error) !== marker) throw error;
      } finally {
        Object.defineProperty(base, 'collection', descriptor);
        try { probe.cancel(); } catch {}
      }
      if (!collection?.HasRectangle?.()) throw new Error('Selected Wire is not recognized by Plasticity as a dimensionable rectangle');

      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.collection = collection;
          factory.width = args.width;
          factory.length = args.length;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["DimensionRectangleCommand", "DimensionRectangleFactory"], [{
      id,
      width: millimetersToMeters(widthMm),
      length: millimetersToMeters(lengthMm),
    }]);
    return await this.state();
  }

  async boolean(targetIds: number[], toolIds: number[], operation: "union" | "difference" | "intersection", keepTools: boolean, revision: string): Promise<RuntimeState> {
    const before = await this.assertRevision(revision);
    if (targetIds.some((id) => toolIds.includes(id))) throw new Error("Target and tool IDs must not overlap");
    if (operation === "intersection" && new Set(toolIds).size > 1) {
      // The kernel's intersection takes target AND (tool 1 OR tool 2 ...) when given several tools, so each tool is
      // intersected in turn inside one native command: the result is target AND tool 1 AND tool 2 ... A native
      // intersection with several targets does not keep the target IDs, so each target gets its own one-target
      // passes. Every tool is kept until the last target's pass with it, then keepTools decides.
      try {
        await this.runtime.mutate(nativeFunction`async function (Factory, args) {
          ${findView}
          if (this.executor.isBusy) throw new Error('Plasticity is busy');
          const editor = this;
          let failure;
          const command = new this.commands.BooleanCommand(this);
          command.remember = false;
          command.execute = async function () {
            for (const [targetIndex, targetId] of args.targetIds.entries()) {
              for (const toolId of args.toolIds) {
                try {
                  const factory = new Factory(editor).resource(this);
                  factory.targets = [find(targetId)];
                  factory.tools = [find(toolId)];
                  factory.operationType = 15901;
                  factory.keepTools = args.keepTools || targetIndex < args.targetIds.length - 1;
                  await factory.commit();
                } catch (error) {
                  failure = new Error('Intersection of target ' + targetId + ' with tool ' + toolId + ' failed: ' + String(error?.message ?? error));
                  throw failure;
                }
              }
            }
          };
          await this.exec(command);
          if (failure) throw failure;
        }`, ["BooleanFactory"], [{ targetIds: [...new Set(targetIds)], toolIds: [...new Set(toolIds)], keepTools }]);
      } catch (error) {
        if (this.runtime.isUncertain?.() === true) throw error;
        let now: RuntimeState;
        try {
          now = await this.state();
        } catch {
          throw error;
        }
        const message = (error instanceof Error ? error.message : String(error)).replace(/\.\s*$/u, "");
        const back = now.undoDepth === before.undoDepth && sameBodies(before, now);
        throw new Error(`${message}. ${back
          ? `Plasticity rolled the command back: the document reads back as before this call (Undo depth ${now.undoDepth}, every body at its earlier version)`
          : `The document does not read back as before this call (Undo depth ${now.undoDepth}, was ${before.undoDepth}); read the bodies before you continue`}; the current revision is ${now.revision}.`);
      }
      return await this.state();
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("BooleanCommand")}
      factory.targets = args.targetIds.map(find);
      factory.tools = args.toolIds.map(find);
      factory.operationType = ({ union: 15903, difference: 15902, intersection: 15901 })[args.operation];
      factory.keepTools = args.keepTools;
      ${commandEnd}
    }`, ["BooleanFactory"], [{ targetIds, toolIds, operation, keepTools }]);
    return await this.state();
  }

  // MultiCutFactory with Wire cutters: each curve is swept along direction (Plasticity's own choice
  // when omitted) and splits the targets; extend lengthens the swept cutter past the curve ends.
  async cutWithCurves(targetIds: number[], curveIds: number[], directionVector: Vector3 | undefined, extend: boolean, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    const uniqueTargetIds = [...new Set(targetIds)];
    const uniqueCurveIds = [...new Set(curveIds)];
    if (uniqueTargetIds.length === 0) throw new Error("At least one cut target is required");
    if (uniqueCurveIds.length === 0) throw new Error("At least one cutter Wire is required");
    if (uniqueTargetIds.some((id) => uniqueCurveIds.includes(id))) throw new Error("Cut targets and cutter Wires must not overlap");
    const typeOf = (id: number) => state.bodies.find((body) => body.id === id)?.type;
    const badTargets = uniqueTargetIds.filter((id) => typeOf(id) !== "Solid" && typeOf(id) !== "Sheet");
    if (badTargets.length > 0) throw new Error(`Cut targets must be current Solid or Sheet bodies: ${badTargets.join(", ")}`);
    const badCurves = uniqueCurveIds.filter((id) => typeOf(id) !== "Wire");
    if (badCurves.length > 0) throw new Error(`Cutters must be current Wire bodies: ${badCurves.join(", ")}`);
    if (directionVector && !(Math.hypot(...directionVector) > 0)) throw new Error("Cut direction must be nonzero");
    await this.runtime.mutate(nativeFunction`async function (Factory, Vector, args) {
      ${findView}
      ${commandStart("CutCommand")}
      factory.shells = args.targetIds.map(find);
      factory.curves = args.curveIds.map(find);
      if (args.direction) factory.direction = new Vector(...args.direction).normalize();
      factory.shouldExtend = args.extend;
      ${commandEnd}
    }`, ["MultiCutFactory", "Vector3"], [{ targetIds: uniqueTargetIds, curveIds: uniqueCurveIds, direction: directionVector ?? null, extend }]);
    return await this.state();
  }

  // Knife mode of the native curve tool: the curve is drawn onto the target body and splits its faces.
  async knifeCurve(targetId: number, pointsMm: Vector3[], closed: boolean, controlPoints: boolean, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    const type = state.bodies.find((body) => body.id === targetId)?.type;
    if (type !== "Solid" && type !== "Sheet") throw new Error(`Knife target must be a current Solid or Sheet body: ${targetId}`);
    if (pointsMm.length < 2) throw new Error("Knife curve requires at least two points");
    await this.runtime.mutate(nativeFunction`async function (Factory, Vector, CurveType, args) {
      ${findView}
      ${commandStart("CurveCommand")}
      factory.target = find(args.targetId);
      factory.isKnife = true;
      factory.points = args.points.map(point => new Vector(...point));
      factory.type = args.points.length === 2 ? CurveType.Polyline : CurveType.NURBS;
      factory.splineThrough = !args.controlPoints;
      factory.closed = args.closed;
      ${commandEnd}
    }`, ["KnifeCurveFactory", "Vector3", "CurveType"], [{ targetId, points: pointsMm.map(toMeters), closed, controlPoints }]);
    return await this.state();
  }

  async cutWithFaces(
    targetIds: number[],
    cutterFaces: Array<{ bodyId: number; faceId: string }>,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (targetIds.length === 0) throw new Error("At least one cut target is required");
    const uniqueTargetIds = [...new Set(targetIds)];
    if (uniqueTargetIds.length !== targetIds.length) throw new Error("Cut target IDs must be unique");
    if (cutterFaces.length === 0) throw new Error("At least one cutter face is required");
    const cutterKeys = cutterFaces.map((face) => `${face.bodyId}:${face.faceId}`);
    if (new Set(cutterKeys).size !== cutterKeys.length) throw new Error("Cutter face references must be unique");
    const cutterBodyIds = new Set(cutterFaces.map((face) => face.bodyId));
    if (uniqueTargetIds.some((id) => cutterBodyIds.has(id))) {
      throw new Error("Cut targets and cutter-face bodies must not overlap");
    }
    const invalidTargets = uniqueTargetIds.filter((id) => {
      const type = state.bodies.find((body) => body.id === id)?.type;
      return type !== "Solid" && type !== "Sheet";
    });
    if (invalidTargets.length > 0) {
      throw new Error(`Cut targets must be current Solid or Sheet bodies: ${invalidTargets.join(", ")}`);
    }
    const invalidCutters = cutterFaces.filter((reference) => {
      const body = state.bodies.find((candidate) => candidate.id === reference.bodyId);
      if (body?.type !== "Solid" && body?.type !== "Sheet") return true;
      return body.faces.find((face) => face.id === reference.faceId)?.planar !== true;
    });
    if (invalidCutters.length > 0) {
      throw new Error(`Cut requires current planar cutter faces: ${invalidCutters.map((face) => `${face.bodyId}:${face.faceId}`).join(", ")}`);
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("CutCommand")}
      factory.shells = args.targetIds.map(find);
      factory.faces = args.cutterFaces.map(ref => {
        const view = find(ref.bodyId);
        const index = view.high.faces.versionIds.indexOf(ref.faceId);
        if (index < 0) throw new Error('Stale or unknown cutter face: ' + ref.faceId);
        return view.high.faces.get(index);
      });
      ${commandEnd}
    }`, ["MultiCutFactory"], [{ targetIds: uniqueTargetIds, cutterFaces }]);
    return await this.state();
  }

  async listAppearanceMaterials(): Promise<{
    documentToken: string;
    revision: string;
    materials: NonNullable<RuntimeState["materials"]>;
    assignments: Array<{ bodyId: number; materialId: number }>;
  }> {
    const state = await this.state();
    return {
      documentToken: state.documentToken,
      revision: state.revision,
      materials: state.materials ?? [],
      assignments: state.bodies.map((body) => ({ bodyId: body.id, materialId: body.materialId ?? 0 })),
    };
  }

  async setAppearanceMaterial(
    ids: number[],
    material: AppearanceMaterialInput,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (ids.length === 0) throw new Error("At least one body ID is required");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Appearance body IDs must be unique");
    const missing = uniqueIds.filter((id) => !state.bodies.some((body) => body.id === id));
    if (missing.length > 0) throw new Error(`Appearance requires current body IDs: ${missing.join(", ")}`);
    if ("materialId" in material) {
      if (!Number.isInteger(material.materialId) || material.materialId < 0) {
        throw new Error("Appearance material ID must be a nonnegative integer");
      }
      if (material.materialId !== 0 && !(state.materials ?? []).some((item) => item.id === material.materialId)) {
        throw new Error(`Unknown current appearance material: ${material.materialId}`);
      }
    } else {
      if (!material.name.trim()) throw new Error("Appearance material name is required");
      if (!/^#[0-9a-fA-F]{6}$/.test(material.colorHex)) throw new Error("Appearance color must be #RRGGBB");
      for (const [name, value] of [["roughness", material.roughness], ["metalness", material.metalness], ["opacity", material.opacity]] as const) {
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Appearance ${name} must be between 0 and 1`);
      }
    }
    await this.runtime.mutate(nativeFunction`async function (args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const views = args.ids.map(find);
      this.selection.selected.removeAll();
      let failure;
      let ran = false;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        ran = true;
        try {
          let materialId = args.material.materialId;
          if (materialId === undefined) {
            const appearance = nativeApi.db.materials.default.clone();
            appearance.color.set(args.material.colorHex);
            appearance.roughness = args.material.roughness;
            appearance.metalness = args.material.metalness;
            appearance.opacity = args.material.opacity;
            appearance.transparent = args.material.opacity < 1;
            materialId = nativeApi.db.materials.add(args.material.name, appearance);
          } else if (materialId !== 0 && !nativeApi.db.materials.has(materialId)) {
            throw new Error('Appearance material ID is no longer current: ' + materialId);
          }
          // Public ID 0 means no assignment; native node state uses undefined.
          for (const view of views) nativeApi.db.nodes.setMaterial(nativeApi.db.nodes.item2key(view), materialId === 0 ? undefined : materialId);
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
      if (!ran) throw new Error('Appearance command did not execute');
    }`, [], [{ ids: uniqueIds, material }]);
    return await this.state();
  }

  // shape: native Parasolid blend cross-section. "round" (22201) is circular; "g2" (22202) is curvature continuous
  // (measured live: relative G2 deviation 0 at both tangent edges, versus 1 for round).
  async fillet(id: number, edgeIds: string[], radiusMm: number, revision: string, shape: "round" | "g2" = "round"): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("FilletShellCommand")}
      const view = find(args.id);
      const edges = view.high.edges;
      factory.shell = view;
      factory.edges = args.edgeIds.map(id => {
        const index = edges.versionIds.indexOf(id);
        if (index < 0) throw new Error('Stale or unknown edge: ' + id);
        return edges.get(index);
      });
      if (args.shape !== undefined) factory.shape = args.shape;
      factory.distance = args.radius;
      ${commandEnd}
    }`, ["FilletShellFactory"], [{ id, edgeIds, radius: millimetersToMeters(radiusMm), ...(shape === "g2" ? { shape: FILLET_SHAPE_G2 } : {}) }]);
    return await this.state();
  }

  // Plasticity can answer OK for a chamfer it made only in part: 7.41 mm on the end loop of a box whose long edges are
  // R7 left the four arcs without a chamfer face (14 faces, 33,639.98 mm3; the equal-distance chamfer is 18 faces and
  // 33,568.38 mm3). The factory also chamfers the tangent chain of every selected edge, so selecting one line of that
  // loop gives the same body. The native call returns the chain the factory chamfered (FilletShellFactory.extendedEdges)
  // and the topology identity (entityId) of every face before and after; chamferFaceCheck then needs one new face for
  // every chained edge. When it finds edges without one, the tool undoes its own step and reports that.
  async chamfer(id: number, edgeIds: string[], distanceMm: number, revision: string): Promise<RuntimeState> {
    const before = await this.assertRevision(revision);
    const evidence = await this.runtime.mutate<ChamferNativeEvidence | undefined>(CHAMFER_SOURCE, ["FilletShellFactory"], [{ id, edgeIds, distance: -millimetersToMeters(distanceMm) }]);
    const after = await this.state();
    const beforeBody = before.bodies.find((body) => body.id === id);
    const afterBody = after.bodies.find((body) => body.id === id);
    // No evidence (an older fake or renderer) or no body to compare: nothing is claimed either way.
    if (!evidence || !beforeBody || !afterBody) return after;
    const check = chamferFaceCheck(beforeBody, afterBody, evidence, edgeIds);
    if (check.missing.length === 0) return after;
    throw new Error(await this.rollBackChamfer(id, distanceMm, before, after, check));
  }

  // Undoes the chamfer step this call made and says whether the document is back where it was.
  private async rollBackChamfer(id: number, distanceMm: number, before: RuntimeState, after: RuntimeState, check: ChamferFaceCheck): Promise<string> {
    const beforeBody = before.bodies.find((body) => body.id === id)!;
    const describe = (edgeId: string) => {
      const edge = beforeBody.edges.find((candidate) => candidate.id === edgeId);
      const radius = edge?.circleGeometry?.radiusMm;
      return `${edgeId} (${edge?.curveType ?? "edge"}${radius === undefined ? "" : ` R${Number(radius.toFixed(6))} mm`})`;
    };
    const chained = check.chained.length - check.selected.length;
    const smallArcs = check.chained.flatMap((edgeId) => {
      const radius = beforeBody.edges.find((edge) => edge.id === edgeId)?.circleGeometry?.radiusMm;
      return radius !== undefined && radius < distanceMm ? [radius] : [];
    });
    const finding = `Chamfer ${distanceMm} mm on body ${id} was not made on every edge: Plasticity reported OK, but ${check.missing.length} of the ${check.chained.length} edge${check.chained.length === 1 ? "" : "s"} it chamfered (${check.selected.length} selected${chained > 0 ? `, ${chained} more along their tangent chain` : ""}) got no chamfer face: ${check.missing.map(describe).join(", ")}.${smallArcs.length > 0 ? ` A chained arc has radius ${Number(Math.min(...smallArcs).toFixed(6))} mm, below the distance; a distance of at most that radius may succeed.` : ""}`;
    if (after.undoDepth !== before.undoDepth + 1) {
      return `${finding} The call left the Undo depth at ${after.undoDepth} (was ${before.undoDepth}), so the tool did not undo anything: revision ${after.revision} holds this result; inspect it before you undo.`;
    }
    let restored: RuntimeState;
    try {
      await this.stepHistory("undo");
      restored = await this.state();
    } catch (error) {
      return `${finding} The tool's own undo of this step failed (${error instanceof Error ? error.message : String(error)}): the chamfer may remain at revision ${after.revision}; call plasticity_reconcile and read the body before you undo.`;
    }
    const unchanged = restored.undoDepth === before.undoDepth && sameBodies(before, restored);
    if (unchanged) return `${finding} The tool undid its own step: the document is as it was before this call (Undo depth ${restored.undoDepth}, every body at its earlier version, body ${id} with its ${beforeBody.faceIds.length} faces); the revision is now ${restored.revision}. No undo is needed for this call. Redo would bring the partial chamfer back, and Redo entries from before this call are gone.`;
    return `${finding} The tool undid one step, but the document does not read back as before (Undo depth ${restored.undoDepth}, was ${before.undoDepth}; bodies ${sameBodies(before, restored) ? "as before" : "differ"}); revision ${restored.revision}. Read the body before you continue.`;
  }

  async removeFillets(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (ids.length === 0) throw new Error("At least one Solid or Sheet ID is required");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Shell body IDs must be unique");
    const invalid = uniqueIds.filter((id) => {
      const type = state.bodies.find((body) => body.id === id)?.type;
      return type !== "Solid" && type !== "Sheet";
    });
    if (invalid.length > 0) throw new Error(`Fillet removal requires current Solid or Sheet bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("RemoveFilletsFromShellCommand")}
      factory.shells = args.ids.map(find);
      factory.radius = 0;
      ${commandEnd}
    }`, ["RemoveFilletsFromShellFactory"], [{ ids: uniqueIds }]);
    return await this.state();
  }

  async refilletFaces(faces: Array<{ bodyId: number; faceId: string }>, deltaMm: number, revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (faces.length === 0) throw new Error("At least one recognized fillet face is required");
    const keys = faces.map((face) => `${face.bodyId}:${face.faceId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Fillet face references must be unique");
    if (!Number.isFinite(deltaMm) || deltaMm === 0) throw new Error("Refillet delta must be finite and nonzero");
    const selected = faces.map((reference) =>
      state.bodies.find((body) => body.id === reference.bodyId)?.faces.find((face) => face.id === reference.faceId));
    const missing = faces.filter((_reference, index) => !selected[index]);
    if (missing.length > 0) {
      throw new Error(`Stale or unknown faces: ${missing.map((face) => `${face.bodyId}:${face.faceId}`).join(", ")}`);
    }
    const unrecognized = faces.filter((_reference, index) => selected[index]!.blendRadiusMm === null);
    if (unrecognized.length > 0) {
      throw new Error(`Refillet requires recognized fillet faces: ${unrecognized.map((face) => `${face.bodyId}:${face.faceId}`).join(", ")}`);
    }
    const nonpositive = faces.filter((_reference, index) => selected[index]!.blendRadiusMm! + deltaMm <= 0);
    if (nonpositive.length > 0) throw new Error("Refillet delta must leave every selected face with a positive radius");
    await this.runtime.mutate(nativeFunction`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          const shells = new Set(args.faces.map(ref => find(ref.bodyId)));
          factory.shells = Array.from(shells);
          factory.faces = args.faces.map(ref => {
            const view = find(ref.bodyId);
            const index = view.high.faces.versionIds.indexOf(ref.faceId);
            if (index < 0) throw new Error('Stale or unknown fillet face: ' + ref.faceId);
            return view.high.faces.get(index);
          });
          factory.distance = args.distance;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["RefilletFaceCommand", "RefilletFaceFactory"], [{ faces, distance: millimetersToMeters(deltaMm) }]);
    return await this.state();
  }

  async extrudeFaces(id: number, faceIds: string[], distanceMm: number, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("ExtrudeCommand")}
      const view = find(args.id);
      const faces = view.high.faces;
      factory.faces = args.faceIds.map(id => {
        const index = faces.versionIds.indexOf(id);
        if (index < 0) throw new Error('Stale or unknown face: ' + id);
        return faces.get(index);
      });
      factory.distance1 = args.distance;
      ${commandEnd}
    }`, ["ExtrudeFactory"], [{ id, faceIds, distance: millimetersToMeters(distanceMm) }]);
    return await this.state();
  }

  async extrudeProfile(id: number, distanceMm: number, revision: string, options: ExtrudeOptions = {}): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("ExtrudeCommand")}
      const view = find(args.id);
      if (view.constructor.name !== 'Wire') throw new Error('Profile must be a Wire');
      const profileItem = Array.from(nativeApi.geo.geometryModel.values()).find(item => item.view === view);
      if (!profileItem?.model?.IsClosed?.()) throw new Error('Profile must be a closed Wire');
      let basis;
      try { basis = editor.curves.lookup(view); } catch { throw new Error('Profile is not planar'); }
      const sketchEntry = Array.from(editor.curves.read.sketch2basis ?? [])
        .find(([, candidateBasis]) => candidateBasis === basis);
      const sketchId = Number(sketchEntry?.[0]);
      if (!Number.isInteger(sketchId)) throw new Error('Profile sketch is unavailable');
      const regions = [];
      for (const [versionId, item] of nativeApi.geo.geometryModel) {
        if (!nativeApi.geo.automatics.has(versionId) || item.view?.constructor?.name !== 'SketchIsland') continue;
        let candidateSketchId;
        try { candidateSketchId = Number(editor.sketches.getSketchId(item.view)); } catch { continue; }
        if (candidateSketchId !== sketchId) continue;
        for (let index = 0; index < (item.view.regions?.length ?? 0); index += 1) {
          const region = item.view.regions.get(index);
          if (region) regions.push(region);
        }
      }
      if (regions.length === 0) throw new Error('Profile is open or has no native region');
      if (regions.length > 1) throw new Error('Profile is ambiguous; use plasticity_list_regions and plasticity_extrude_regions');
      factory.regions = regions;
      factory.distance1 = args.distance;${applyExtrudeOptions}
      ${commandEnd}
    }`, ["ExtrudeFactory"], [{ id, distance: millimetersToMeters(distanceMm), options: nativeExtrudeOptions(options) }]);
    return await this.state();
  }

  async extrudeRegions(regionIds: string[], distanceMm: number, revision: string, options: ExtrudeOptions = {}): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (regionIds.length === 0) throw new Error("At least one Region ID is required");
    const uniqueIds = [...new Set(regionIds)];
    if (uniqueIds.length !== regionIds.length) throw new Error("Region IDs must be unique");
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${commandStart("ExtrudeCommand")}
      const wanted = new Set(args.regionIds);
      const regions = [];
      for (const [versionId, item] of nativeApi.geo.geometryModel) {
        if (!nativeApi.geo.automatics.has(versionId) || item.view?.constructor?.name !== 'SketchIsland') continue;
        for (let index = 0; index < (item.view.regions?.length ?? 0); index += 1) {
          const region = item.view.regions.get(index);
          if (region && wanted.has(String(region.versionId))) regions.push(region);
        }
      }
      const found = new Set(regions.map(region => String(region.versionId)));
      const missing = args.regionIds.filter(id => !found.has(id));
      if (missing.length > 0) throw new Error('Stale or unknown regions: ' + missing.join(', '));
      factory.regions = regions;
      factory.distance1 = args.distance;${applyExtrudeOptions}
      ${commandEnd}
    }`, ["ExtrudeFactory"], [{ regionIds: uniqueIds, distance: millimetersToMeters(distanceMm), options: nativeExtrudeOptions(options) }]);
    return await this.state();
  }

  // Open or closed Wires extruded along a world direction; open Wires make Sheets.
  async extrudeCurves(ids: number[], distanceMm: number, directionVector: Vector3 | undefined, revision: string, options: ExtrudeOptions = {}): Promise<RuntimeState> {
    await this.assertRevision(revision);
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) throw new Error("At least one Wire ID is required");
    if (directionVector && !(Math.hypot(...directionVector) > 0)) throw new Error("Extrude direction must be nonzero");
    await this.runtime.mutate(nativeFunction`async function (Factory, Vector, args) {
      ${findView}
      ${commandStart("ExtrudeCommand")}
      const curves = args.ids.map(id => {
        const view = find(id);
        if (view.constructor.name !== 'Wire') throw new Error('Body ' + id + ' is not a Wire');
        return view;
      });
      factory.curves = curves;
      if (args.direction) factory.direction = new Vector(...args.direction).normalize();
      factory.distance1 = args.distance;${applyExtrudeOptions}
      ${commandEnd}
    }`, ["ExtrudeFactory", "Vector3"], [{ ids: uniqueIds, distance: millimetersToMeters(distanceMm), direction: directionVector ?? null, options: nativeExtrudeOptions(options) }]);
    return await this.state();
  }

  async offsetPlanarCurves(ids: number[], distanceMm: number, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (!Number.isFinite(distanceMm) || distanceMm === 0) throw new Error("Planar curve offset distance must be nonzero");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) throw new Error("At least one Wire ID is required");
    if (uniqueIds.length !== ids.length) throw new Error("Wire IDs must be unique");
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      const findWire = id => {
        for (const [versionId, item] of nativeApi.geo.geometryModel) {
          if (nativeApi.db.lookupStableId(versionId) !== id) continue;
          if (item.view?.constructor?.name !== 'Wire') throw new Error('Planar curve offset requires Wire bodies');
          return item.view;
        }
        throw new Error('Unknown Wire ID: ' + id);
      };
      ${commandStart("OffsetPlanarCurveCommand")}
      factory.curves = args.ids.map(findWire);
      factory.distance1 = args.distance;
      ${commandEnd}
    }`, ["OffsetPlanarCurvesFactory"], [{ ids: uniqueIds, distance: millimetersToMeters(distanceMm) }]);
    return await this.state();
  }

  async createSlotProfiles(ids: number[], widthMm: number, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (!Number.isFinite(widthMm) || widthMm <= 0) throw new Error("Slot profile width must be positive");
    if (ids.length === 0) throw new Error("At least one Wire ID is required");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Wire IDs must be unique");
    const invalid = uniqueIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Slot profiles require current Wire bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      ${findView}
      const wires = args.ids.map(id => {
        const view = find(id);
        if (view?.constructor?.name !== 'Wire') throw new Error('Slot profile source is no longer a Wire: ' + id);
        return view;
      });
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.curves = wires;
          factory.width = args.width;
          return await factory.commit();
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["SlotFactory", "SlotCommand"], [{ ids: uniqueIds, width: millimetersToMeters(widthMm) }]);
    return await this.state();
  }

  async offsetRegions(regionIds: string[], offsetsMm: number[], individual: boolean, revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (regionIds.length === 0) throw new Error("At least one Region ID is required");
    const uniqueRegionIds = [...new Set(regionIds)];
    if (uniqueRegionIds.length !== regionIds.length) throw new Error("Region IDs must be unique");
    if (offsetsMm.length < 1 || offsetsMm.length > 2) throw new Error("Region offset requires one or two distances");
    if (offsetsMm.some((value) => !Number.isFinite(value) || value === 0)) throw new Error("Region offset distances must be finite and nonzero");
    if (new Set(offsetsMm).size !== offsetsMm.length) throw new Error("Region offset distances must be unique");
    const selected = uniqueRegionIds.map((id) => state.regions.find((region) => region.id === id));
    const missing = uniqueRegionIds.filter((_id, index) => !selected[index]);
    if (missing.length > 0) throw new Error(`Stale or unknown regions: ${missing.join(", ")}`);
    const islandVersionIds = new Set(selected.map((region) => region!.islandVersionId));
    if (islandVersionIds.size !== 1) throw new Error("Region offsets must belong to the same sketch island");
    const islandVersionId = selected[0]!.islandVersionId;
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${commandStart("OffsetRegionCommand")}
      const island = nativeApi.geo.geometryModel.get(args.islandVersionId);
      if (!island || island.view?.constructor?.name !== 'SketchIsland') throw new Error('Stale or unknown Region sketch');
      const wanted = new Set(args.regionIds);
      const regions = [];
      for (let index = 0; index < (island.view.regions?.length ?? 0); index += 1) {
        const region = island.view.regions.get(index);
        if (region && wanted.has(String(region.versionId))) regions.push(region);
      }
      const found = new Set(regions.map(region => String(region.versionId)));
      const missing = args.regionIds.filter(id => !found.has(id));
      if (missing.length > 0) throw new Error('Stale or unknown regions: ' + missing.join(', '));
      factory.sketch = island.view;
      factory.regions = regions;
      factory.distance1 = args.distance1;
      factory.distance2 = args.distance2;
      factory.isIndividual = args.individual;
      ${commandEnd}
    }`, ["OffsetRegionFactory"], [{
      regionIds: uniqueRegionIds,
      islandVersionId,
      distance1: millimetersToMeters(offsetsMm[0]!),
      distance2: offsetsMm[1] === undefined ? 0 : millimetersToMeters(offsetsMm[1]),
      individual,
    }]);
    return await this.state();
  }

  async trimCurveFragments(fragmentIds: string[], revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (fragmentIds.length === 0) throw new Error("At least one curve fragment ID is required");
    const uniqueIds = [...new Set(fragmentIds)];
    if (uniqueIds.length !== fragmentIds.length) throw new Error("Curve fragment IDs must be unique");
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${commandStart("TrimCommand")}
      const wanted = new Set(args.fragmentIds);
      const selected = [];
      for (const info of editor.fragments.read.modelId2info.values()) {
        const fragmentItem = nativeApi.geo.geometryModel.get(info.fragmentViewId);
        if (!fragmentItem) continue;
        for (const segment of Array.from(fragmentItem.view?.segments ?? [])) {
          if (wanted.has(String(segment.versionId))) selected.push(segment);
        }
      }
      const found = new Set(selected.map(segment => String(segment.versionId)));
      const missing = args.fragmentIds.filter(id => !found.has(id));
      if (missing.length > 0) throw new Error('Stale or unknown curve fragments: ' + missing.join(', '));
      factory.segments = selected;
      ${commandEnd}
    }`, ["TrimFactory"], [{ fragmentIds: uniqueIds }]);
    return await this.state();
  }

  async extendCurveEndpoints(endpointIds: string[], distanceMm: number, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (!Number.isFinite(distanceMm) || distanceMm <= 0) throw new Error("Curve extension distance must be positive");
    if (endpointIds.length === 0) throw new Error("At least one curve endpoint ID is required");
    const uniqueIds = [...new Set(endpointIds)];
    if (uniqueIds.length !== endpointIds.length) throw new Error("Curve endpoint IDs must be unique");
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${commandStart("ExtendCurveCommand")}
      const wanted = new Set(args.endpointIds);
      const selected = [];
      for (const [, item] of nativeApi.geo.geometryModel) {
        if (item.view?.constructor?.name !== 'Wire') continue;
        for (const vertex of Array.from(item.view.vertices ?? [])) {
          if (!wanted.has(String(vertex.versionId))) continue;
          const model = nativeApi.db.lookupTopologyItem(vertex);
          if (!model.IsSpur()) throw new Error('Curve extension requires open Wire endpoints');
          selected.push(vertex);
        }
      }
      const found = new Set(selected.map(vertex => String(vertex.versionId)));
      const missing = args.endpointIds.filter(id => !found.has(id));
      if (missing.length > 0) throw new Error('Stale or unknown curve endpoints: ' + missing.join(', '));
      factory.vertices = selected;
      factory.distance = args.distance;
      ${commandEnd}
    }`, ["MultiExtendVertexFactory"], [{ endpointIds: uniqueIds, distance: millimetersToMeters(distanceMm) }]);
    return await this.state();
  }

  async convertCurveVerticesToControlPoints(vertices: VertexReference[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (vertices.length === 0) throw new Error("At least one curve vertex is required");
    const keys = vertices.map(({ bodyId, vertexId }) => `${bodyId}:${vertexId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Curve vertex references must be unique");
    const invalidBodies = [...new Set(vertices.map(({ bodyId }) => bodyId))]
      .filter((bodyId) => state.bodies.find((body) => body.id === bodyId)?.type !== "Wire");
    if (invalidBodies.length > 0) {
      throw new Error(`Curve vertex conversion requires current Wire bodies: ${invalidBodies.join(", ")}`);
    }
    const listed = await this.listCurveVertices();
    if (listed.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${listed.revision}`);
    }
    const byKey = new Map(listed.vertices.map((vertex) => [vertex.id, vertex]));
    const missing = keys.filter((key) => !byKey.has(key));
    if (missing.length > 0) throw new Error(`Stale or unknown curve vertices: ${missing.join(", ")}`);
    const endpoints = keys.filter((key) => byKey.get(key)?.endpoint);
    if (endpoints.length > 0) {
      throw new Error(`Curve vertex conversion requires interior or closed Wire vertices: ${endpoints.join(", ")}`);
    }
    const invalidDegree = keys.filter((key) => byKey.get(key)?.adjacentEdgeEntityIds.length !== 2);
    if (invalidDegree.length > 0) {
      throw new Error(`Curve vertex conversion requires exactly two adjacent segments: ${invalidDegree.join(", ")}`);
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      const editor = this;
      if (editor.executor.isBusy) throw new Error('Plasticity is busy');
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const wanted = new Set(args.vertices.map(reference => reference.bodyId + ':' + reference.vertexId));
          const selected = [];
          const found = new Set();
          for (const [versionId, item] of nativeApi.geo.geometryModel) {
            if (item.view?.constructor?.name !== 'Wire') continue;
            const bodyId = nativeApi.db.lookupStableId(versionId);
            if (!Number.isInteger(bodyId)) continue;
            for (const view of Array.from(item.view.vertices ?? [])) {
              const vertex = nativeApi.db.lookupTopologyItem(view);
              const key = bodyId + ':' + vertex.Id();
              if (!wanted.has(key)) continue;
              if (vertex.IsSpur()) throw new Error('Cannot convert endpoint vertex: ' + key);
              selected.push(view);
              found.add(key);
            }
          }
          const missing = Array.from(wanted).filter(key => !found.has(key));
          if (missing.length > 0) throw new Error('Stale or unknown curve vertices: ' + missing.join(', '));
          const factory = new Factory(editor).resource(this);
          factory.vertices = selected;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["ConvertVertexFactory", "ConvertCommand"], [{ vertices }]);
    return await this.state();
  }

  // Native FilletCurveFactory: rounds the corner where two separate Wires meet or would meet.
  async filletCurves(firstId: number, secondId: number, radiusMm: number, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (!Number.isFinite(radiusMm) || radiusMm <= 0) throw new Error("Curve fillet radius must be positive");
    if (firstId === secondId) throw new Error("Curve fillet needs two different Wires; use plasticity_fillet_curve_vertices for corners inside one Wire");
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("FilletCurveCommand")}
      const curves = [args.first, args.second].map(id => {
        const view = find(id);
        if (view.constructor.name !== 'Wire') throw new Error('Body ' + id + ' is not a Wire');
        return view;
      });
      factory.curves = curves;
      factory.radius = args.radius;
      ${commandEnd}
    }`, ["FilletCurveFactory"], [{ first: firstId, second: secondId, radius: millimetersToMeters(radiusMm) }]);
    return await this.state();
  }

  async filletCurveVertices(vertices: VertexReference[], radiusMm: number, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (!Number.isFinite(radiusMm) || radiusMm <= 0) throw new Error("Curve fillet radius must be positive");
    if (vertices.length === 0) throw new Error("At least one curve vertex is required");
    const keys = vertices.map(({ bodyId, vertexId }) => `${bodyId}:${vertexId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Curve vertex references must be unique");
    const listed = await this.listCurveVertices();
    if (listed.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${listed.revision}`);
    }
    const byKey = new Map(listed.vertices.map((vertex) => [vertex.id, vertex]));
    const missing = keys.filter((key) => !byKey.has(key));
    if (missing.length > 0) throw new Error(`Stale or unknown curve vertices: ${missing.join(", ")}`);
    const endpoints = keys.filter((key) => byKey.get(key)?.endpoint);
    if (endpoints.length > 0) throw new Error(`Curve fillet requires interior or closed Wire vertices: ${endpoints.join(", ")}`);
    const invalidDegree = keys.filter((key) => byKey.get(key)?.adjacentEdgeEntityIds.length !== 2);
    if (invalidDegree.length > 0) throw new Error(`Curve fillet requires exactly two adjacent segments at every vertex: ${invalidDegree.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      const host = this;
      const wanted = new Set(args.vertices.map(reference => reference.bodyId + ':' + reference.vertexId));
      const selected = [];
      const found = new Set();
      for (const [versionId, item] of nativeApi.geo.geometryModel) {
        if (item.view?.constructor?.name !== 'Wire') continue;
        const bodyId = nativeApi.db.lookupStableId(versionId);
        if (!Number.isInteger(bodyId)) continue;
        for (const view of Array.from(item.view.vertices ?? [])) {
          const vertex = nativeApi.db.lookupTopologyItem(view);
          const key = bodyId + ':' + vertex.Id();
          if (!wanted.has(key)) continue;
          selected.push(view);
          found.add(key);
        }
      }
      const missing = Array.from(wanted).filter(key => !found.has(key));
      if (missing.length > 0) throw new Error('Stale or unknown curve vertices: ' + missing.join(', '));
      ${commandStart("FilletVertexCommand")}
      factory.vertices = selected;
      factory.radius = args.radius;
      ${commandEnd}
    }`, ["FilletVertexFactory"], [{ vertices, radius: millimetersToMeters(radiusMm) }]);
    return await this.state();
  }

  async unjoinCurves(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (ids.length === 0) throw new Error("At least one Wire ID is required");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Wire IDs must be unique");
    const invalid = uniqueIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve unjoin requires current Wire bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.curves = args.ids.map(find);
          return await factory.commit();
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["UnjoinCurvesCommand", "UnjoinCurvesFactory"], [{ ids: uniqueIds }]);
    return await this.state();
  }

  async duplicateCurves(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (ids.length === 0) throw new Error("At least one Wire ID is required");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Wire IDs must be unique");
    const invalid = uniqueIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve duplication requires current Wire bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.DuplicateCommand(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.curves = args.ids.map(find);
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["CurveDuplicateFactory"], [{ ids: uniqueIds }]);
    return await this.state();
  }

  async createCurvesFromRegions(regionIds: string[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (regionIds.length === 0) throw new Error("At least one Region ID is required");
    const uniqueIds = [...new Set(regionIds)];
    if (uniqueIds.length !== regionIds.length) throw new Error("Region IDs must be unique");
    const current = new Set(state.regions.map((region) => region.id));
    const missing = uniqueIds.filter((id) => !current.has(id));
    if (missing.length > 0) throw new Error(`Stale or unknown Region IDs: ${missing.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      const wanted = new Set(args.regionIds);
      const regions = [];
      for (const [, item] of nativeApi.geo.geometryModel) {
        if (item.view?.constructor?.name !== 'SketchIsland') continue;
        for (let index = 0; index < (item.view.regions?.length ?? 0); index += 1) {
          const region = item.view.regions.get(index);
          if (region && wanted.has(String(region.versionId))) regions.push(region);
        }
      }
      const found = new Set(regions.map(region => String(region.versionId)));
      const missing = args.regionIds.filter(id => !found.has(id));
      if (missing.length > 0) throw new Error('Stale or unknown Regions: ' + missing.join(', '));
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.DuplicateCommand(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.regions = regions;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["CreateCurvesFromRegionsFactory"], [{ regionIds: uniqueIds }]);
    return await this.state();
  }

  async joinCurves(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (ids.length < 2) throw new Error("At least two Wire IDs are required");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Wire IDs must be unique");
    const invalid = uniqueIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve join requires current Wire bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.curves = args.ids.map(find);
          return await factory.commit();
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["JoinCurvesCommand", "JoinCurvesFactory"], [{ ids: uniqueIds }]);
    return await this.state();
  }

  async rebuildCurves(ids: number[], options: RebuildCurveOptions, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one Wire ID is required");
    if (new Set(ids).size !== ids.length) throw new Error("Wire IDs must be unique");
    const invalid = ids.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve rebuild requires current Wire bodies: ${invalid.join(", ")}`);
    const preserveParameterization = options.preserveParameterization ?? false;
    const preserveChain = options.preserveChain ?? true;
    const keepCorners = options.keepCorners ?? true;
    let method: 0 | 1 | 2;
    let parameters: { tolerance?: number; pointCount?: number; degree?: number; spans?: number };
    switch (options.method) {
      case "tolerance":
        if (!Number.isFinite(options.toleranceMm) || options.toleranceMm <= 0) throw new Error("Curve rebuild tolerance must be positive");
        method = 0;
        parameters = { tolerance: millimetersToMeters(options.toleranceMm) };
        break;
      case "control-points":
        if (!Number.isInteger(options.pointCount) || options.pointCount < 4 || options.pointCount > 10_000) {
          throw new Error("Curve rebuild control-point count must be an integer from 4 to 10000");
        }
        method = 1;
        parameters = { pointCount: options.pointCount };
        break;
      case "degree-spans":
        if (!Number.isInteger(options.degree) || options.degree < 1 || options.degree > 15) {
          throw new Error("Curve rebuild degree must be an integer from 1 to 15");
        }
        if (!Number.isInteger(options.spans) || options.spans < 1 || options.spans > 10_000 || options.degree + options.spans > 10_000) {
          throw new Error("Curve rebuild spans must produce from 2 to 10000 control points with the selected degree");
        }
        method = 2;
        parameters = { degree: options.degree, spans: options.spans };
        break;
      default:
        throw new Error(`Unsupported curve rebuild method: ${String((options as { method?: unknown }).method)}`);
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("RebuildCurveCommand")}
      factory.curves = args.ids.map(find);
      factory.method = args.method;
      factory.preserveParameterization = args.preserveParameterization;
      factory.preserveChain = args.preserveChain;
      factory.keepCorners = args.keepCorners;
      if (args.method === 0) factory.tolerance = args.parameters.tolerance;
      else if (args.method === 1) factory.pointCount = args.parameters.pointCount;
      else {
        factory.degree = args.parameters.degree;
        factory.spans = args.parameters.spans;
      }
      ${commandEnd}
    }`, ["RebuildCurveFactory"], [{
      ids,
      method,
      parameters,
      preserveParameterization,
      preserveChain,
      keepCorners,
    }]);
    return await this.state();
  }

  async raiseCurveDegree(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one Wire ID is required");
    if (new Set(ids).size !== ids.length) throw new Error("Wire IDs must be unique");
    const invalid = ids.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve degree elevation requires current Wire bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.curves = args.ids.map(find);
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["RaiseDegreeCurveFactory", "RaiseDegreeCurveCommand"], [{ ids }]);
    return await this.state();
  }

  async subdivideCurves(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one Wire ID is required");
    if (new Set(ids).size !== ids.length) throw new Error("Wire IDs must be unique");
    const invalid = ids.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve subdivision requires current Wire bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.curves = args.ids.map(find);
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["SubdivideCurveFactory", "SubdivideCurveCommand"], [{ ids }]);
    return await this.state();
  }

  async insertCurveKnot(
    reference: CurveSegmentReference,
    normalizedParameter: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (state.bodies.find((body) => body.id === reference.bodyId)?.type !== "Wire") {
      throw new Error(`Curve knot insertion requires a current Wire body: ${reference.bodyId}`);
    }
    if (!Number.isInteger(reference.segmentEntityId) || reference.segmentEntityId <= 0) {
      throw new Error("Curve knot segment entity ID must be a positive integer");
    }
    if (!Number.isFinite(normalizedParameter) || normalizedParameter <= 0 || normalizedParameter >= 1) {
      throw new Error("Curve knot normalized parameter must be greater than 0 and less than 1");
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const wire = find(args.reference.bodyId);
      if (wire?.constructor?.name !== 'Wire') throw new Error('Curve knot source is no longer a Wire');
      let segment;
      let edge;
      for (const candidate of Array.from(wire.segments ?? [])) {
        const model = nativeApi.db.lookupTopologyItem(candidate);
        if (Number(model?.Id?.()) !== args.reference.segmentEntityId) continue;
        segment = candidate;
        edge = model;
        break;
      }
      if (!segment || !edge) throw new Error('Stale or unknown curve segment: ' + args.reference.bodyId + ':' + args.reference.segmentEntityId);
      const wrapped = edge.GetCurve();
      const curve = wrapped?.curve ?? wrapped;
      if (curve?.constructor?.name !== 'BCurve') throw new Error('Curve knot insertion requires a native B-Spline segment');
      const nativeParameter = edge.Denormalize(args.normalizedParameter);
      if (!Number.isFinite(nativeParameter)) throw new Error('Native curve parameter is unavailable');

      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.segment = segment;
          nativeApi.configureCurveKnot(factory, nativeParameter);
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["InsertKnotFactory", "InsertKnotCommand"], [{ reference, normalizedParameter }]);
    return await this.state();
  }

  async splitCurveSegment(
    reference: CurveSegmentReference,
    normalizedParameter: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (state.bodies.find((body) => body.id === reference.bodyId)?.type !== "Wire") {
      throw new Error(`Curve segment split requires a current Wire body: ${reference.bodyId}`);
    }
    if (!Number.isInteger(reference.segmentEntityId) || reference.segmentEntityId <= 0) {
      throw new Error("Curve split segment entity ID must be a positive integer");
    }
    if (!Number.isFinite(normalizedParameter) || normalizedParameter <= 0 || normalizedParameter >= 1) {
      throw new Error("Curve split normalized parameter must be greater than 0 and less than 1");
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const wire = find(args.reference.bodyId);
      if (wire?.constructor?.name !== 'Wire') throw new Error('Curve split source is no longer a Wire');
      let segment;
      let edge;
      for (const candidate of Array.from(wire.segments ?? [])) {
        const model = nativeApi.db.lookupTopologyItem(candidate);
        if (Number(model?.Id?.()) !== args.reference.segmentEntityId) continue;
        segment = candidate;
        edge = model;
        break;
      }
      if (!segment || !edge) throw new Error('Stale or unknown curve segment: ' + args.reference.bodyId + ':' + args.reference.segmentEntityId);
      if (edge.IsPeriodic()) throw new Error('Periodic closed curve segments cannot be split at only one point');

      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          nativeApi.configureCurveSplit(factory, segment, args.normalizedParameter);
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["SplitSegmentFactory", "SplitSegmentCommand"], [{ reference, normalizedParameter }]);
    return await this.state();
  }

  async planarizeCurves(ids: number[], originMm: Vector3, normal: Vector3, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one Wire ID is required");
    if (new Set(ids).size !== ids.length) throw new Error("Wire IDs must be unique");
    const invalid = ids.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve planarization requires current Wire bodies: ${invalid.join(", ")}`);
    const unitNormal = normalize(normal);
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, Vector, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.curves = args.ids.map(find);
          factory.origin.copy(new Vector(...args.origin));
          factory.normal.copy(new Vector(...args.normal));
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["PlanarizeCurveFactory", "DeformCurveCommand", "Vector3"], [{ ids, origin: toMeters(originMm), normal: unitNormal }]);
    return await this.state();
  }

  async moveCurveControlPoints(
    points: CurveControlPointReference[],
    deltaMm: Vector3,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertCurveControlPointReferences(points, revision);
    if (deltaMm.some((value) => !Number.isFinite(value)) || Math.hypot(...deltaMm) === 0) {
      throw new Error("Curve control point move delta must be a finite nonzero vector");
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      ${findCurveControlPoints}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          nativeApi.setCurveControlPoints(factory, vertices, cvs);
          factory.move.fromArray(args.delta);
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["MultiMoveControlPointFactory", "MoveControlPointCommand"], [{ points, delta: toMeters(deltaMm) }]);
    return await this.state();
  }

  async slideCurveControlPoints(
    points: CurveControlPointReference[],
    direction: "positive-u" | "negative-u",
    distanceMm: number,
    revision: string,
  ): Promise<RuntimeState> {
    const inventory = await this.assertCurveControlPointReferences(points, revision);
    if (!Number.isFinite(distanceMm) || distanceMm <= 0) {
      throw new Error("Curve control point slide distance must be finite and positive");
    }
    const nativeDirection = direction === "positive-u" ? "posU" : direction === "negative-u" ? "negU" : undefined;
    if (!nativeDirection) throw new Error(`Unsupported curve control point slide direction: ${String(direction)}`);
    const slideable = new Set(inventory.curves.flatMap((curve) => [
      ...curve.boundaryVertices.filter((point) => point.slideDirections).map((point) => `${curve.id}:vertex:${point.reference.pointId}`),
      ...curve.interiorControlPoints.filter((point) => point.slideDirections).map((point) => `${curve.id}:control-point:${point.reference.pointId}`),
    ]));
    const unsupported = points.filter((point) => !slideable.has(`${point.bodyId}:${point.kind}:${point.pointId}`));
    if (unsupported.length > 0) {
      throw new Error(`Native slide directions are unavailable for curve control points: ${unsupported.map((point) => `${point.bodyId}:${point.kind}:${point.pointId}`).join(", ")}`);
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      ${findCurveControlPoints}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          nativeApi.setCurveControlPoints(factory, vertices, cvs);
          factory.direction = nativeApi.slideDirection(args.direction);
          factory.distance = args.distance;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["MultiSlideControlPointFactory", "MoveControlPointCommand"], [{
      points,
      direction: nativeDirection,
      distance: millimetersToMeters(distanceMm),
    }]);
    return await this.state();
  }

  async rotateCurveControlPoints(
    points: CurveControlPointReference[],
    pivotMm: Vector3,
    axis: Vector3,
    degrees: number,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertCurveControlPointReferences(points, revision);
    if (!Number.isFinite(degrees) || degrees === 0) throw new Error("Curve control point rotation angle must be finite and nonzero");
    const unitAxis = normalize(axis);
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, Vector, Quaternion, args) {
      ${findCurveControlPoints}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          nativeApi.setCurveControlPoints(factory, vertices, cvs);
          factory.pivot.fromArray(args.pivot);
          factory.rotation.copy(new Quaternion().setFromAxisAngle(new Vector(...args.axis), args.radians));
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["MultiRotateControlPointFactory", "RotateControlPointCommand", "Vector3", "Quaternion"], [{
      points,
      pivot: toMeters(pivotMm),
      axis: unitAxis,
      radians: degreesToRadians(degrees),
    }]);
    return await this.state();
  }

  async scaleCurveControlPoints(
    points: CurveControlPointReference[],
    pivotMm: Vector3,
    factors: Vector3,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertCurveControlPointReferences(points, revision);
    if (factors.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error("Curve control point scale factors must be finite and positive");
    }
    if (factors.every((value) => value === 1)) throw new Error("Curve control point scale must change at least one factor");
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      ${findCurveControlPoints}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          nativeApi.setCurveControlPoints(factory, vertices, cvs);
          factory.pivot.fromArray(args.pivot);
          factory.scale.fromArray(args.factors);
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["MultiScaleControlPointFactory", "ScaleControlPointCommand"], [{ points, pivot: toMeters(pivotMm), factors }]);
    return await this.state();
  }

  async deleteCurveControlPoints(points: CurveControlPointReference[], revision: string): Promise<RuntimeState> {
    await this.assertCurveControlPointReferences(points, revision);
    if (points.some((point) => point.kind !== "control-point")) {
      throw new Error("Only interior B-Spline control points can be deleted");
    }
    const bodyIds = new Set(points.map((point) => point.bodyId));
    if (bodyIds.size !== 1) throw new Error("Deleted curve control points must belong to one Wire");
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      ${findCurveControlPoints}
      if (vertices.length > 0 || cvs.length !== args.points.length) throw new Error('Only interior B-Spline control points can be deleted');
      const view = views.get(args.points[0].bodyId);
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.curve = view;
          nativeApi.setCurveControlPoints(factory, [], cvs);
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["DeleteControlPointFactory", "DeleteControlPointCommand"], [{ points }]);
    return await this.state();
  }

  async reverseCurves(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (ids.length === 0) throw new Error("At least one Wire ID is required");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Wire IDs must be unique");
    const invalid = uniqueIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve reversal requires current Wire bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.curves = args.ids.map(find);
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["ReverseCurveCommand", "ReverseCurveFactory"], [{ ids: uniqueIds }]);
    return await this.state();
  }

  async reverseSheets(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (ids.length === 0) throw new Error("At least one Sheet ID is required");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Sheet IDs must be unique");
    const invalid = uniqueIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Sheet");
    if (invalid.length > 0) throw new Error(`Sheet reversal requires current Sheet bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.sheets = args.ids.map(find);
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["ReverseSheetCommand", "ReverseSheetFactory"], [{ ids: uniqueIds }]);
    return await this.state();
  }

  async createBodyOutlines(
    ids: number[],
    planeIdentity: ReferenceIdentity,
    placement: "source" | "workplane",
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.syncConstructionState(revision);
    if (ids.length === 0) throw new Error("At least one Solid or Sheet is required for body outlines");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Body outline IDs must be unique");
    if (placement !== "source" && placement !== "workplane") {
      throw new Error(`Unsupported body outline placement: ${String(placement)}`);
    }
    const invalid = uniqueIds.filter((id) => {
      const type = state.bodies.find((body) => body.id === id)?.type;
      return type !== "Solid" && type !== "Sheet";
    });
    if (invalid.length > 0) throw new Error(`Body outlines require current Solid or Sheet bodies: ${invalid.join(", ")}`);
    const plane = this.datumRegistry.requireCurrentPlane(planeIdentity, state.documentToken, state.revision);
    const factoryBinding = placement === "source" ? "CreateOutlineFromShellsFactory" : "ProjectOutlineFromShellsFactory";
    await this.runtime.mutate(nativeFunction`async function (Factory, Database, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const viewport = Array.from(this.viewports)[0];
      if (!viewport) throw new Error('Plasticity viewport is unavailable');
      let selected;
      if (args.plane.source === 'standard') {
        selected = Database[args.plane.nativeId];
      } else {
        const snapshot = this.planes.snapshot();
        const idEntries = snapshot.ids instanceof Map ? Array.from(snapshot.ids) : Object.entries(snapshot.ids ?? {});
        const idEntry = idEntries.find(([, nativeId]) => String(nativeId) === args.plane.nativeId);
        const index = idEntry ? Number(idEntry[0]) : undefined;
        selected = snapshot.planes?.[index];
      }
      if (!selected) throw new Error('Construction plane is unavailable: ' + args.plane.nativeId);
      const previous = viewport.constructionPlane;
      viewport.constructionPlane = selected;
      if (viewport.constructionPlane !== selected) throw new Error('Plasticity did not activate the requested outline plane');
      viewport.setNeedsRender();

      const shells = args.ids.map(id => {
        const view = find(id);
        if (view.constructor.name !== 'Solid' && view.constructor.name !== 'Sheet') {
          throw new Error('Body outline inputs must be Solid or Sheet bodies');
        }
        return view;
      });
      const editor = this;
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.shells = shells;
          return await factory.commit();
        } catch (error) {
          failure = error;
          viewport.constructionPlane = previous;
          viewport.setNeedsRender();
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, [factoryBinding, "ConstructionPlaneDatabase"], [{
      ids: uniqueIds,
      plane: { id: plane.id, nativeId: plane.nativeId, source: plane.source },
    }]);
    return await this.state();
  }

  async curvePattern(ids: number[], spineId: number, count: number, revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (ids.length === 0) throw new Error("At least one Solid or Sheet is required for a curve pattern");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Curve-pattern body IDs must be unique");
    const invalid = uniqueIds.filter((id) => {
      const type = state.bodies.find((body) => body.id === id)?.type;
      return type !== "Solid" && type !== "Sheet";
    });
    if (invalid.length > 0) throw new Error(`Curve pattern requires current Solid or Sheet bodies: ${invalid.join(", ")}`);
    if (state.bodies.find((body) => body.id === spineId)?.type !== "Wire") {
      throw new Error(`Curve pattern requires a current Wire spine: ${spineId}`);
    }
    if (!Number.isInteger(count) || count < 2 || count > 1000) {
      throw new Error("Curve-pattern count must be an integer between 2 and 1000");
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          const spine = find(args.spineId);
          if (spine.constructor.name !== 'Wire') throw new Error('Curve pattern spine must be a Wire');
          factory.items = args.ids.map(find);
          factory.curve = spine;
          factory.num = args.count;
          factory.shouldMakeInstances = false;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["CurveArrayFactory"], [{ ids: uniqueIds, spineId, count }]);
    return await this.state();
  }

  async projectCurvesOntoBody(
    targetId: number,
    curveIds: number[],
    direction: Vector3,
    options: { bidirectional?: boolean; occlude?: boolean; completion?: "none" | "edge" | "face-set" },
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (curveIds.length === 0) throw new Error("At least one Wire ID is required");
    const uniqueIds = [...new Set(curveIds)];
    if (uniqueIds.length !== curveIds.length) throw new Error("Wire IDs must be unique");
    if (uniqueIds.includes(targetId)) throw new Error("Projection curves must not include the target body");
    const length = Math.hypot(...direction);
    if (!Number.isFinite(length) || length === 0) throw new Error("Projection direction must be nonzero");
    const normalizedDirection = direction.map((value) => value / length) as Vector3;
    const completion = options.completion ?? "none";
    const completionName = ({ none: "None", edge: "Edge", "face-set": "FaceSet" } as const)[completion];
    if (!completionName) throw new Error(`Unsupported projection completion: ${completion}`);
    await this.runtime.mutate(nativeFunction`async function (Factory, Vector, ProjectionMethod, ProjectionCompletionType, args) {
      const find = id => {
        for (const [versionId, item] of nativeApi.geo.geometryModel) {
          if (nativeApi.db.lookupStableId(versionId) === id) return item.view;
        }
        throw new Error('Unknown body ID: ' + id);
      };
      ${commandStart("ProjectCurveBodyCommand")}
      const target = find(args.targetId);
      if (target.constructor.name === 'Wire') throw new Error('Projection target must be a surface body');
      const curves = args.curveIds.map(id => {
        const curve = find(id);
        if (curve.constructor.name !== 'Wire') throw new Error('Projection inputs must be Wire bodies');
        return curve;
      });
      factory.target = target;
      factory.curves = curves;
      factory.method = ProjectionMethod.Vector;
      factory.direction.copy(new Vector(...args.direction));
      factory.bidirectional = args.bidirectional;
      factory.occlude = args.occlude;
      factory.complete = ProjectionCompletionType[args.completionName];
      ${commandEnd}
    }`, ["ProjectCurveBodyFactory", "Vector3", "ProjectionMethod", "ProjectionCompletionType"], [{
      targetId,
      curveIds: uniqueIds,
      direction: normalizedDirection,
      bidirectional: options.bidirectional ?? false,
      occlude: options.occlude ?? true,
      completionName,
    }]);
    return await this.state();
  }

  async createBodyIntersectionCurves(targetId: number, toolIds: number[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (toolIds.length === 0) throw new Error("At least one intersection tool body is required");
    const uniqueIds = [...new Set(toolIds)];
    if (uniqueIds.length !== toolIds.length) throw new Error("Intersection tool body IDs must be unique");
    if (uniqueIds.includes(targetId)) throw new Error("The intersection target cannot also be a tool body");
    const targetType = state.bodies.find((body) => body.id === targetId)?.type;
    if (targetType !== "Solid" && targetType !== "Sheet") {
      throw new Error(`Body intersection target must be a current Solid or Sheet: ${targetId}`);
    }
    const invalid = uniqueIds.filter((id) => {
      const type = state.bodies.find((body) => body.id === id)?.type;
      return type !== "Solid" && type !== "Sheet";
    });
    if (invalid.length > 0) throw new Error(`Body intersection tools must be current Solid or Sheet bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.target = find(args.targetId);
          factory.tools = args.toolIds.map(find);
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["ProjectBodyBodyCommand", "ProjectBodyBodyFactory"], [{ targetId, toolIds: uniqueIds }]);
    return await this.state();
  }

  async projectCurvePair(
    firstId: number,
    firstDirection: Vector3,
    secondId: number,
    secondDirection: Vector3,
    projectionDepthMm: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (firstId === secondId) throw new Error("Curve projection requires two distinct Wire bodies");
    for (const id of [firstId, secondId]) {
      if (state.bodies.find((body) => body.id === id)?.type !== "Wire") {
        throw new Error(`Curve projection requires a current Wire body: ${id}`);
      }
    }
    const normalize = (value: Vector3, label: string): Vector3 => {
      const length = Math.hypot(...value);
      if (!Number.isFinite(length) || length === 0) throw new Error(`${label} must be nonzero`);
      return value.map((component) => component / length) as Vector3;
    };
    const first = normalize(firstDirection, "First projection direction");
    const second = normalize(secondDirection, "Second projection direction");
    const crossLength = Math.hypot(
      first[1] * second[2] - first[2] * second[1],
      first[2] * second[0] - first[0] * second[2],
      first[0] * second[1] - first[1] * second[0],
    );
    if (crossLength <= 1e-9) throw new Error("Curve projection directions must not be parallel");
    if (!Number.isFinite(projectionDepthMm) || projectionDepthMm <= 0) {
      throw new Error("Curve projection depth must be positive");
    }
    await this.runtime.mutate(nativeFunction`async function (Command, Factory, Vector, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.curve1 = find(args.firstId);
          factory.curve2 = find(args.secondId);
          factory.extrude1.direction.copy(new Vector(...args.firstDirection));
          factory.extrude1.distance1 = args.projectionDepth;
          factory.extrude1.distance2 = -args.projectionDepth;
          factory.extrude2.direction.copy(new Vector(...args.secondDirection));
          factory.extrude2.distance1 = args.projectionDepth;
          factory.extrude2.distance2 = -args.projectionDepth;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["ProjectCurveCurveCommand", "ProjectCurveCurveFactory", "Vector3"], [{
      firstId,
      firstDirection: first,
      secondId,
      secondDirection: second,
      projectionDepth: millimetersToMeters(projectionDepthMm),
    }]);
    return await this.state();
  }

  async insertIsoparamEdges(
    face: { bodyId: number; faceId: string },
    direction: "u" | "v",
    count: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    const body = state.bodies.find((candidate) => candidate.id === face.bodyId);
    if ((body?.type !== "Solid" && body?.type !== "Sheet") || !body.faceIds.includes(face.faceId)) {
      throw new Error(`Isoparam insertion requires a current Solid or Sheet face: ${face.bodyId}:${face.faceId}`);
    }
    if (!Number.isInteger(count) || count < 1 || count > 1000) {
      throw new Error("Isoparam count must be an integer between 1 and 1000");
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findFaceViews}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.IsoparamCommand(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.shell = find(args.faces[0].bodyId);
          factory.face = selectedFaces[0];
          factory.count = args.count;
          if (factory.uOrV !== args.uOrV) factory.toggleUV();
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["IsoparamFactory"], [{ faces: [face], count, uOrV: direction === "u" }]);
    return await this.state();
  }

  async raiseSurfaceDegree(faces: FaceReference[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, faces, "face");
    const invalid = faces.filter((reference) => {
      const body = state.bodies.find((candidate) => candidate.id === reference.bodyId);
      return (body?.type !== "Solid" && body?.type !== "Sheet") ||
        body.faces.find((face) => face.id === reference.faceId)?.surfaceType !== "BSurf";
    });
    if (invalid.length > 0) {
      throw new Error(`Surface degree elevation requires current B-Surface faces: ${invalid.map((face) => `${face.bodyId}:${face.faceId}`).join(", ")}`);
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      ${findFaceViews}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.faces = selectedFaces;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["RaiseDegreeFaceFactory", "RaiseDegreeFaceCommand"], [{ faces }]);
    return await this.state();
  }

  async rebuildFace(face: FaceReference, toleranceMm: number, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, [face], "face");
    const body = state.bodies.find((candidate) => candidate.id === face.bodyId);
    if (body?.type !== "Solid" && body?.type !== "Sheet") {
      throw new Error(`Face rebuild requires a current Solid or Sheet body: ${face.bodyId}`);
    }
    if (!Number.isFinite(toleranceMm) || toleranceMm <= 0 || toleranceMm > 10) {
      throw new Error("Face rebuild tolerance must be positive and no greater than 10 mm");
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, RebuildFaceMethod, ChangeEdgeMethod, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const view = find(args.face.bodyId);
      if (view?.constructor?.name !== 'Solid' && view?.constructor?.name !== 'Sheet') {
        throw new Error('Face rebuild source is no longer a Solid or Sheet');
      }
      const index = view.high.faces.versionIds.indexOf(args.face.faceId);
      if (index < 0) throw new Error('Stale or unknown face: ' + args.face.faceId);
      const selectedFace = view.high.faces.get(index);
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.shell = view;
          factory.face = selectedFace;
          factory.method = RebuildFaceMethod.Refit;
          factory.tolerance = args.tolerance;
          factory.changeEdgeMethod = ChangeEdgeMethod.Project;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["RebuildFaceFactory", "RebuildFaceCommand", "RebuildFaceMethod", "ChangeEdgeMethod"], [{
      face,
      tolerance: millimetersToMeters(toleranceMm),
    }]);
    return await this.state();
  }

  async matchFaces(
    faces: FaceReference[],
    replacement: FaceReference,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (faces.length === 0) throw new Error("At least one source face is required for face matching");
    requireTopologySelection(state, [...faces, replacement], "face");
    const invalidBodies = [...new Set([...faces, replacement].map((reference) => reference.bodyId))].filter((bodyId) => {
      const type = state.bodies.find((body) => body.id === bodyId)?.type;
      return type !== "Solid" && type !== "Sheet";
    });
    if (invalidBodies.length > 0) {
      throw new Error(`Face matching requires current Solid or Sheet bodies: ${invalidBodies.join(", ")}`);
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const face = reference => {
        const view = find(reference.bodyId);
        if (view?.constructor?.name !== 'Solid' && view?.constructor?.name !== 'Sheet') {
          throw new Error('Face matching input is no longer a Solid or Sheet');
        }
        const index = view.high.faces.versionIds.indexOf(reference.faceId);
        if (index < 0) throw new Error('Stale or unknown matching face: ' + reference.bodyId + ':' + reference.faceId);
        return view.high.faces.get(index);
      };
      const sourceShells = Array.from(new Set(args.faces.map(reference => find(reference.bodyId))));
      const sourceFaces = args.faces.map(face);
      const replacementFace = face(args.replacement);
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.shells = sourceShells;
          factory.faces = sourceFaces;
          factory.replacement = replacementFace;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["MatchFaceFactory", "MatchFaceCommand"], [{ faces, replacement }]);
    return await this.state();
  }

  async untrimFaces(faces: FaceReference[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, faces, "face");
    const invalidBodies = [...new Set(faces.map((reference) => reference.bodyId))].filter((bodyId) => {
      const type = state.bodies.find((body) => body.id === bodyId)?.type;
      return type !== "Solid" && type !== "Sheet";
    });
    if (invalidBodies.length > 0) throw new Error(`Surface untrim requires current Solid or Sheet bodies: ${invalidBodies.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findFaceViews}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.UntrimCommand(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.faces = selectedFaces;
          factory.keepEdges = false;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["UntrimFactory"], [{ faces }]);
    return await this.state();
  }

  async imprintCurvesOnBody(
    targetId: number,
    curveIds: number[],
    direction: Vector3 | undefined,
    options: { projectionMethod?: "vector" | "normal"; bidirectional?: boolean; occlude?: boolean; completion?: "none" | "edge" | "face-set" },
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (curveIds.length === 0) throw new Error("At least one Wire ID is required");
    const uniqueIds = [...new Set(curveIds)];
    if (uniqueIds.length !== curveIds.length) throw new Error("Wire IDs must be unique");
    if (uniqueIds.includes(targetId)) throw new Error("Imprint curves must not include the target body");
    const projectionMethod = options.projectionMethod ?? "vector";
    if (projectionMethod !== "vector" && projectionMethod !== "normal") throw new Error("Unsupported imprint projection method");
    if (projectionMethod === "normal" && direction !== undefined) throw new Error("Imprint direction is only valid for vector projection");
    const length = direction ? Math.hypot(...direction) : 0;
    if (projectionMethod === "vector" && (!Number.isFinite(length) || length === 0)) throw new Error("Imprint vector direction must be nonzero");
    const normalizedDirection = direction ? direction.map((value) => value / length) as Vector3 : null;
    const completion = options.completion ?? "none";
    const completionName = ({ none: "None", edge: "Edge", "face-set": "FaceSet" } as const)[completion];
    if (!completionName) throw new Error(`Unsupported imprint completion: ${completion}`);
    await this.runtime.mutate(nativeFunction`async function (Factory, Vector, ProjectionMethod, ProjectionCompletionType, args) {
      ${findView}
      ${commandStart("ImprintCurveBodyCommand")}
      const target = find(args.targetId);
      if (target.constructor.name === 'Wire') throw new Error('Imprint target must be a surface body');
      const curves = args.curveIds.map(id => {
        const curve = find(id);
        if (curve.constructor.name !== 'Wire') throw new Error('Imprint inputs must be Wire bodies');
        return curve;
      });
      factory.target = target;
      factory.curves = curves;
      factory.method = ProjectionMethod[args.projectionMethodName];
      if (args.direction) factory.direction.copy(new Vector(...args.direction));
      factory.bidirectional = args.bidirectional;
      factory.occlude = args.occlude;
      factory.complete = ProjectionCompletionType[args.completionName];
      ${commandEnd}
    }`, ["ImprintCurveBodyFactory", "Vector3", "ProjectionMethod", "ProjectionCompletionType"], [{
      targetId,
      curveIds: uniqueIds,
      direction: normalizedDirection,
      projectionMethodName: projectionMethod === "normal" ? "Normal" : "Vector",
      bidirectional: options.bidirectional ?? false,
      occlude: options.occlude ?? true,
      completionName,
    }]);
    return await this.state();
  }

  async imprintBodies(targetId: number, toolIds: number[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (toolIds.length === 0) throw new Error("At least one imprint tool body is required");
    const uniqueIds = [...new Set(toolIds)];
    if (uniqueIds.length !== toolIds.length) throw new Error("Imprint tool body IDs must be unique");
    if (uniqueIds.includes(targetId)) throw new Error("The imprint target cannot also be a tool body");
    const targetType = state.bodies.find((body) => body.id === targetId)?.type;
    if (targetType !== "Solid" && targetType !== "Sheet") {
      throw new Error(`Body imprint target must be a current Solid or Sheet: ${targetId}`);
    }
    const invalid = uniqueIds.filter((id) => {
      const type = state.bodies.find((body) => body.id === id)?.type;
      return type !== "Solid" && type !== "Sheet";
    });
    if (invalid.length > 0) throw new Error(`Body imprint tools must be current Solid or Sheet bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.target = find(args.targetId);
          factory.tools = args.toolIds.map(find);
          factory.imprintTool = false;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["ImprintBodyBodyCommand", "ImprintBodyBodyFactory"], [{ targetId, toolIds: uniqueIds }]);
    return await this.state();
  }

  async sweepRegions(
    regionIds: string[],
    spineId: number,
    options: {
      alignment?: "normal" | "parallel" | "transport";
      corner?: "miter" | "round";
      twistDegrees?: number;
      scale?: number;
      simplify?: boolean;
      guideIds?: number[] | undefined;
      guideMethod?: SweepGuideMethodName | undefined;
    },
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (regionIds.length === 0) throw new Error("At least one Region ID is required");
    const uniqueIds = [...new Set(regionIds)];
    if (uniqueIds.length !== regionIds.length) throw new Error("Region IDs must be unique");
    const selected = uniqueIds.map((id) => state.regions.find((region) => region.id === id));
    const missing = uniqueIds.filter((_id, index) => !selected[index]);
    if (missing.length > 0) throw new Error(`Stale or unknown regions: ${missing.join(", ")}`);
    const spine = state.bodies.find((body) => body.id === spineId);
    if (!spine || spine.type !== "Wire") throw new Error(`Sweep requires a current Wire spine: ${spineId}`);
    if (selected.some((region) => region!.sketchWireIds.includes(spineId))) {
      throw new Error("Sweep spine must not be one of the Region profile curves");
    }
    const scale = options.scale ?? 1;
    if (!Number.isFinite(scale) || scale <= 0) throw new Error("Sweep scale must be positive");
    const twistDegrees = options.twistDegrees ?? 0;
    if (!Number.isFinite(twistDegrees)) throw new Error("Sweep twist must be finite");
    const alignmentName = ({ normal: "Normal", parallel: "Parallel", transport: "Transport" } as const)[options.alignment ?? "normal"];
    const cornerName = ({ miter: "Mitre", round: "Round" } as const)[options.corner ?? "miter"];
    const guideIds = options.guideIds ?? [];
    const guided = guideIds.length > 0;
    if (guided) requireSweepGuides(state, guideIds, spineId, selected.flatMap((region) => region!.sketchWireIds), options.guideMethod);
    else if (options.guideMethod !== undefined) throw new Error("Sweep guide method requires guide IDs");
    await this.runtime.mutate(nativeFunction`async function (Factory, SweepAlignmentType, SweepCornerType${guided ? ", SweepGuideMethod" : ""}, args) {
      ${guided ? findView : ""}
      ${commandStart("SweepCommand")}
      const wanted = new Set(args.regionIds);
      const regions = [];
      let spine;
      for (const [versionId, item] of nativeApi.geo.geometryModel) {
        if (nativeApi.db.lookupStableId(versionId) === args.spineId) spine = item.view;
        if (!nativeApi.geo.automatics.has(versionId) || item.view?.constructor?.name !== 'SketchIsland') continue;
        for (let index = 0; index < (item.view.regions?.length ?? 0); index += 1) {
          const region = item.view.regions.get(index);
          if (region && wanted.has(String(region.versionId))) regions.push(region);
        }
      }
      if (!spine || spine.constructor.name !== 'Wire') throw new Error('Stale or unknown sweep spine');
      const found = new Set(regions.map(region => String(region.versionId)));
      const missing = args.regionIds.filter(id => !found.has(id));
      if (missing.length > 0) throw new Error('Stale or unknown regions: ' + missing.join(', '));
      factory.regions = regions;
      factory.spine = spine;
      factory.alignment = SweepAlignmentType[args.alignmentName];
      factory.cornerType = SweepCornerType[args.cornerName];
      factory.twistDegrees = args.twistDegrees;
      factory.scale = args.scale;
      factory.simplify = args.simplify;
      ${guided ? sweepGuides : ""}
      ${commandEnd}
    }`, ["SweepFactory", "SweepAlignmentType", "SweepCornerType", ...(guided ? ["SweepGuideMethod"] : [])], [{
      regionIds: uniqueIds,
      spineId,
      alignmentName,
      cornerName,
      twistDegrees,
      scale,
      simplify: options.simplify ?? false,
      ...(guided ? { guideIds, ...(options.guideMethod ? { guideMethodName: SWEEP_GUIDE_METHODS[options.guideMethod] } : {}) } : {}),
    }]);
    return await this.state();
  }

  async sweepCurves(
    profileIds: number[],
    spineId: number,
    options: {
      guideIds?: number[] | undefined;
      guideMethod?: SweepGuideMethodName | undefined;
      twistDegrees?: number | undefined;
      scale?: number | undefined;
    },
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (profileIds.length === 0 || new Set(profileIds).size !== profileIds.length) {
      throw new Error("Sweep profile Wire IDs must be a nonempty unique list");
    }
    const wires = new Map(state.bodies.filter((body) => body.type === "Wire").map((body) => [body.id, body]));
    const unknownProfiles = profileIds.filter((id) => !wires.has(id));
    if (unknownProfiles.length > 0) throw new Error(`Sweep profiles must be current Wire IDs: ${unknownProfiles.join(", ")}`);
    if (!wires.has(spineId)) throw new Error(`Sweep requires a current Wire spine: ${spineId}`);
    if (profileIds.includes(spineId)) throw new Error("Sweep spine must not be one of the profile curves");
    const guideIds = options.guideIds ?? [];
    const guided = guideIds.length > 0;
    if (guided) requireSweepGuides(state, guideIds, spineId, profileIds, options.guideMethod);
    else if (options.guideMethod !== undefined) throw new Error("Sweep guide method requires guide IDs");
    if (options.scale !== undefined && (!Number.isFinite(options.scale) || options.scale <= 0)) throw new Error("Sweep scale must be positive");
    if (options.twistDegrees !== undefined && !Number.isFinite(options.twistDegrees)) throw new Error("Sweep twist must be finite");
    await this.runtime.mutate(nativeFunction`async function (Factory, SweepGuideMethod, args) {
      ${findView}
      ${commandStart("SweepCommand")}
      const profiles = args.profileIds.map(find);
      const spine = find(args.spineId);
      if (spine.constructor.name !== 'Wire' || profiles.some(profile => profile.constructor.name !== 'Wire')) throw new Error('Sweep profiles and spine must be Wires');
      factory.curves = profiles;
      factory.spine = spine;
      if (args.twistDegrees !== undefined) factory.twistDegrees = args.twistDegrees;
      if (args.scale !== undefined) factory.scale = args.scale;
      ${sweepGuides}
      ${commandEnd}
    }`, ["SweepFactory", "SweepGuideMethod"], [{
      profileIds,
      spineId,
      ...(options.twistDegrees !== undefined ? { twistDegrees: options.twistDegrees } : {}),
      ...(options.scale !== undefined ? { scale: options.scale } : {}),
      ...(guided ? { guideIds, ...(options.guideMethod ? { guideMethodName: SWEEP_GUIDE_METHODS[options.guideMethod] } : {}) } : {}),
    }]);
    return await this.state();
  }

  async loftRegions(
    regionIds: string[],
    options: { closed?: boolean; simplify?: boolean; guideIds?: number[]; trimGuides?: boolean },
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (regionIds.length < 2) throw new Error("Loft requires at least two Region profiles");
    const uniqueIds = [...new Set(regionIds)];
    if (uniqueIds.length !== regionIds.length) throw new Error("Loft Region IDs must be unique");
    if (options.closed && uniqueIds.length < 3) throw new Error("Closed loft requires at least three Region profiles");
    const selected = uniqueIds.map((id) => state.regions.find((region) => region.id === id));
    const missing = uniqueIds.filter((_id, index) => !selected[index]);
    if (missing.length > 0) throw new Error(`Stale or unknown regions: ${missing.join(", ")}`);
    if (new Set(selected.map((region) => region!.islandVersionId)).size !== selected.length) {
      throw new Error("Loft profiles must come from different sketch islands");
    }
    const guideIds = options.guideIds ?? [];
    if (new Set(guideIds).size !== guideIds.length) throw new Error("Loft guide IDs must be unique");
    const invalidGuides = guideIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalidGuides.length > 0) throw new Error(`Loft guides must be current Wire bodies: ${invalidGuides.join(", ")}`);
    const profileWireIds = new Set(selected.flatMap((region) => region!.sketchWireIds));
    const profileGuides = guideIds.filter((id) => profileWireIds.has(id));
    if (profileGuides.length > 0) throw new Error(`Loft guide must not reuse a profile Wire: ${profileGuides.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("LoftCommand")}
      const available = new Map();
      for (const [versionId, item] of nativeApi.geo.geometryModel) {
        if (!nativeApi.geo.automatics.has(versionId) || item.view?.constructor?.name !== 'SketchIsland') continue;
        for (let index = 0; index < (item.view.regions?.length ?? 0); index += 1) {
          const region = item.view.regions.get(index);
          if (region) available.set(String(region.versionId), region);
        }
      }
      factory.regions = args.regionIds.map(id => {
        const region = available.get(id);
        if (!region) throw new Error('Stale or unknown Region: ' + id);
        return region;
      });
      if (args.guideIds.length > 0) {
        factory.guides = args.guideIds.map(id => {
          const guide = find(id);
          if (guide.constructor.name !== 'Wire') throw new Error('Loft guides must be Wire bodies');
          return guide;
        });
      }
      factory.trimGuides = args.trimGuides;
      factory.closed = args.closed;
      factory.simplify = args.simplify;
      ${commandEnd}
    }`, ["RegionLoftFactory"], [{
      regionIds: uniqueIds,
      guideIds,
      trimGuides: options.trimGuides ?? true,
      closed: options.closed ?? false,
      simplify: options.simplify ?? true,
    }]);
    return await this.state();
  }

  async loftCurves(
    profileIds: number[],
    options: {
      guideIds?: number[];
      trimGuides?: boolean;
      trimProfiles?: boolean;
      closed?: boolean;
      simplify?: boolean;
      curvature?: "natural" | "unconstrained" | "clamped";
      startMagnitude?: number;
      endMagnitude?: number;
    },
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (profileIds.length < 2) throw new Error("Curve loft requires at least two ordered Wire profiles");
    if (new Set(profileIds).size !== profileIds.length) throw new Error("Curve loft profile IDs must be unique");
    if (options.closed && profileIds.length < 3) throw new Error("Closed curve loft requires at least three Wire profiles");
    const invalidProfiles = profileIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalidProfiles.length > 0) throw new Error(`Curve loft profiles must be current Wire bodies: ${invalidProfiles.join(", ")}`);
    const guideIds = options.guideIds ?? [];
    if (new Set(guideIds).size !== guideIds.length) throw new Error("Curve loft guide IDs must be unique");
    const invalidGuides = guideIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalidGuides.length > 0) throw new Error(`Curve loft guides must be current Wire bodies: ${invalidGuides.join(", ")}`);
    const profileSet = new Set(profileIds);
    const profileGuides = guideIds.filter((id) => profileSet.has(id));
    if (profileGuides.length > 0) throw new Error(`Curve loft guide must not reuse a profile Wire: ${profileGuides.join(", ")}`);
    const startMagnitude = options.startMagnitude ?? 1;
    const endMagnitude = options.endMagnitude ?? 1;
    if (!Number.isFinite(startMagnitude) || startMagnitude <= 0 || !Number.isFinite(endMagnitude) || endMagnitude <= 0) {
      throw new Error("Curve loft start and end magnitudes must be finite and positive");
    }
    const curvature = ({ natural: "Natural", unconstrained: "Unconstrained", clamped: "Clamped" } as const)[options.curvature ?? "unconstrained"];

    await this.runtime.mutate(nativeFunction`async function (Factory, Command, Curvature, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      editor.selection.selected.removeAll();
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.profiles = args.profileIds.map(find);
          if (args.guideIds.length > 0) factory.guides = args.guideIds.map(find);
          factory.trimGuides = args.trimGuides;
          factory.trimProfiles = args.trimProfiles;
          factory.closed = args.closed;
          factory.simplify = args.simplify;
          factory.curvature = Curvature[args.curvature];
          factory.startMagnitude = args.startMagnitude;
          factory.endMagnitude = args.endMagnitude;
          factory.join = false;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["CurveLoftFactory", "LoftEdgeCommand", "LoftCurvatureType"], [{
      profileIds,
      guideIds,
      trimGuides: options.trimGuides ?? true,
      trimProfiles: options.trimProfiles ?? true,
      closed: options.closed ?? false,
      simplify: options.simplify ?? true,
      curvature,
      startMagnitude,
      endMagnitude,
    }]);
    return await this.state();
  }

  async loftFaces(
    faces: FaceReference[],
    options: {
      guideIds?: number[];
      trimGuides?: boolean;
      simplify?: boolean;
      startCondition?: "natural" | "unconstrained" | "clamped";
      endCondition?: "natural" | "unconstrained" | "clamped";
      startMagnitude?: number;
      endMagnitude?: number;
    },
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (faces.length < 2) throw new Error("Face loft requires at least two ordered planar faces");
    const keys = faces.map((face) => `${face.bodyId}:${face.faceId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Face loft references must be unique");
    if (new Set(faces.map((face) => face.bodyId)).size !== faces.length) {
      throw new Error("Face loft profiles must come from different source bodies");
    }
    requireTopologySelection(state, faces, "face");
    const bodies = new Map(state.bodies.map((body) => [body.id, body]));
    const invalidBodies = faces.filter((face) => !["Solid", "Sheet"].includes(bodies.get(face.bodyId)!.type));
    if (invalidBodies.length > 0) {
      throw new Error(`Face loft profiles must belong to current Solid or Sheet bodies: ${invalidBodies.map((face) => face.bodyId).join(", ")}`);
    }
    const nonPlanar = faces.filter((reference) => !bodies.get(reference.bodyId)!.faces.find((face) => face.id === reference.faceId)!.planar);
    if (nonPlanar.length > 0) {
      throw new Error(`Face loft currently requires planar profile faces: ${nonPlanar.map((face) => `${face.bodyId}:${face.faceId}`).join(", ")}`);
    }
    const guideIds = options.guideIds ?? [];
    if (new Set(guideIds).size !== guideIds.length) throw new Error("Face loft guide IDs must be unique");
    const invalidGuides = guideIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalidGuides.length > 0) throw new Error(`Face loft guides must be current Wire bodies: ${invalidGuides.join(", ")}`);
    const startMagnitude = options.startMagnitude ?? 1;
    const endMagnitude = options.endMagnitude ?? 1;
    if (!Number.isFinite(startMagnitude) || startMagnitude <= 0 || !Number.isFinite(endMagnitude) || endMagnitude <= 0) {
      throw new Error("Face loft start and end magnitudes must be finite and positive");
    }
    const conditionNames = { natural: "Natural", unconstrained: "Unconstrained", clamped: "Clamped" } as const;
    const startCondition = conditionNames[options.startCondition ?? "unconstrained"];
    const endCondition = conditionNames[options.endCondition ?? "unconstrained"];

    await this.runtime.mutate(nativeFunction`async function (Factory, Command, Curvature, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const face = reference => {
        const view = find(reference.bodyId);
        if (view?.constructor?.name !== 'Solid' && view?.constructor?.name !== 'Sheet') {
          throw new Error('Face loft profile is no longer a Solid or Sheet');
        }
        const index = view.high.faces.versionIds.indexOf(reference.faceId);
        if (index < 0) throw new Error('Stale or unknown Face loft profile: ' + reference.bodyId + ':' + reference.faceId);
        return view.high.faces.get(index);
      };
      editor.selection.selected.removeAll();
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.faces = args.faces.map(face);
          if (args.guideIds.length > 0) {
            factory.guides = args.guideIds.map(id => {
              const guide = find(id);
              if (guide?.constructor?.name !== 'Wire') throw new Error('Face loft guide is no longer a Wire');
              return guide;
            });
          }
          factory.trimGuides = args.trimGuides;
          factory.closed = false;
          factory.simplify = args.simplify;
          factory.startCurvature = Curvature[args.startCondition];
          factory.endCurvature = Curvature[args.endCondition];
          factory.startMagnitude = args.startMagnitude;
          factory.endMagnitude = args.endMagnitude;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["FaceLoftFactory", "LoftSurfaceCommand", "LoftCurvatureType"], [{
      faces,
      guideIds,
      trimGuides: options.trimGuides ?? true,
      simplify: options.simplify ?? true,
      startCondition,
      endCondition,
      startMagnitude,
      endMagnitude,
    }]);
    return await this.state();
  }

  async patchRegions(regionIds: string[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (regionIds.length === 0) throw new Error("At least one Region ID is required");
    const uniqueIds = [...new Set(regionIds)];
    if (uniqueIds.length !== regionIds.length) throw new Error("Region IDs must be unique");
    const availableIds = new Set(state.regions.map((region) => region.id));
    const missing = uniqueIds.filter((id) => !availableIds.has(id));
    if (missing.length > 0) throw new Error(`Stale or unknown regions: ${missing.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${commandStart("PatchCommand")}
      const wanted = new Set(args.regionIds);
      const regions = [];
      for (const [versionId, item] of nativeApi.geo.geometryModel) {
        if (!nativeApi.geo.automatics.has(versionId) || item.view?.constructor?.name !== 'SketchIsland') continue;
        for (let index = 0; index < (item.view.regions?.length ?? 0); index += 1) {
          const region = item.view.regions.get(index);
          if (region && wanted.has(String(region.versionId))) regions.push(region);
        }
      }
      const found = new Set(regions.map(region => String(region.versionId)));
      const missing = args.regionIds.filter(id => !found.has(id));
      if (missing.length > 0) throw new Error('Stale or unknown regions: ' + missing.join(', '));
      // Clear inside the command so a selected profile cannot start a follow-up move.
      editor.selection.selected.removeAll();
      factory.regions = regions;
      ${commandEnd}
    }`, ["PatchRegionFactory"], [{ regionIds: uniqueIds }]);
    return await this.state();
  }

  async patchClosedWires(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0 || new Set(ids).size !== ids.length) {
      throw new Error("Closed-Wire patch IDs must be a nonempty unique list");
    }
    const current = new Map(state.bodies.map((body) => [body.id, body]));
    const missing = ids.filter((id) => !current.has(id));
    if (missing.length > 0) throw new Error(`Unknown current closed-Wire patch body IDs: ${missing.join(", ")}`);
    const invalid = ids.filter((id) => current.get(id)!.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Closed-Wire patching requires current Wire bodies: ${invalid.join(", ")}`);
    const closure = await this.runtime.read<Array<{ id: number; closed: boolean }>>(nativeFunction`function (ids) {
      const wanted = new Set(ids);
      const result = [];
      for (const [versionId, item] of nativeApi.geo.geometryModel) {
        const id = nativeApi.db.lookupStableId(versionId);
        if (!wanted.has(id)) continue;
        if (item.view?.constructor?.name !== 'Wire') throw new Error('Closed-Wire patch source is no longer a Wire: ' + id);
        result.push({ id, closed: Boolean(item.model?.IsClosed?.()) });
      }
      return result;
    }`, [ids]);
    await this.assertRevision(revision);
    const closureById = new Map(closure.map((item) => [item.id, item.closed]));
    const unresolved = ids.filter((id) => !closureById.has(id));
    if (unresolved.length > 0) throw new Error(`Closed-Wire patch sources changed while being inspected: ${unresolved.join(", ")}`);
    const open = ids.filter((id) => closureById.get(id) !== true);
    if (open.length > 0) throw new Error(`Surface patching requires closed Wire bodies: ${open.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const findWire = id => {
        for (const [versionId, item] of nativeApi.geo.geometryModel) {
          if (nativeApi.db.lookupStableId(versionId) !== id) continue;
          if (item.view?.constructor?.name !== 'Wire' || !item.model?.IsClosed?.()) {
            throw new Error('Surface patch source must remain a closed Wire: ' + id);
          }
          return item.view;
        }
        throw new Error('Surface patch source is missing: ' + id);
      };
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const curves = args.ids.map(findWire);
          const factory = new Factory(editor).resource(this);
          factory.curves = curves;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["PatchHoleInWireFactory", "PatchHoleInCurveCommand"], [{ ids }]);
    return await this.state();
  }

  // X-sided patch (FINDINGS gaps 2 and 6). PatchCommand drives XSidedFactory for boundary curves or edges; with
  // interior guide curves XNurbsCommand drives the same factory. The source Wires and Sheet stay.
  async xsidedPatch(
    input: {
      curveIds?: number[] | undefined;
      edges?: { bodyId: number; edgeIds: string[] } | undefined;
      guideIds?: number[] | undefined;
      continuity?: XSidedContinuity | undefined;
      edgeContinuity?: Array<{ edgeId: string; continuity: XSidedContinuity }> | undefined;
      tension?: number | undefined;
      quality?: "auto" | "high" | "max" | undefined;
    },
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    const { curveIds, edges, guideIds, continuity, edgeContinuity, tension, quality } = input;
    if (curveIds === undefined && edges === undefined) {
      throw new Error(guideIds?.length ? "X-sided patch guides need a boundary: give curveIds or edges" : "X-sided patch requires exactly one of curveIds and edges");
    }
    if (curveIds !== undefined && edges !== undefined) throw new Error("X-sided patch requires exactly one of curveIds and edges, not both");
    const wires = new Set(state.bodies.filter((body) => body.type === "Wire").map((body) => body.id));
    if (curveIds !== undefined) {
      if (curveIds.length < 3 || new Set(curveIds).size !== curveIds.length) throw new Error("X-sided patch curveIds must be a unique list of at least 3 Wire IDs");
      const invalid = curveIds.filter((id) => !wires.has(id));
      if (invalid.length > 0) throw new Error(`X-sided patch boundary curves must be current Wire IDs: ${invalid.join(", ")}`);
      if (continuity !== undefined) throw new Error("X-sided patch continuity applies to boundary edges only; use edges");
    }
    if (edges !== undefined) {
      const body = state.bodies.find((candidate) => candidate.id === edges.bodyId);
      if (!body || (body.type !== "Sheet" && body.type !== "Solid")) throw new Error(`X-sided patch edges need a current Sheet or Solid body: ${edges.bodyId}`);
      if (edges.edgeIds.length === 0 || new Set(edges.edgeIds).size !== edges.edgeIds.length) throw new Error("X-sided patch edge IDs must be a nonempty unique list");
      const unknown = edges.edgeIds.filter((id) => !body.edgeIds.includes(id));
      if (unknown.length > 0) throw new Error(`Stale or unknown X-sided patch edges: ${unknown.join(", ")}`);
    }
    if (continuity !== undefined && !(continuity in XSIDED_CONTINUITY)) {
      throw new Error(`X-sided patch continuity must be one of: ${Object.keys(XSIDED_CONTINUITY).join(", ")}`);
    }
    // Per-edge continuity (XNurbsFactory.setContinuityForEdge), tension (the dialog's Tension input writes the factory's
    // blending) and quality (the dialog's Quality buttons write enforceTolerance: EnforceToleranceType Automatic/High/Max)
    // each changed the patch measurably on 26.1.3 (surfacing tool runs, S3 three-sheet hole). Edge IDs must be boundary edges.
    if (edgeContinuity !== undefined) {
      if (edges === undefined) throw new Error("X-sided patch edgeContinuity applies to boundary edges only; use edges");
      if (edgeContinuity.length === 0) throw new Error("X-sided patch edgeContinuity must not be empty");
      const ids = edgeContinuity.map((entry) => entry.edgeId);
      if (new Set(ids).size !== ids.length) throw new Error("X-sided patch edgeContinuity edge IDs must be unique");
      const outside = ids.filter((id) => !edges.edgeIds.includes(id));
      if (outside.length > 0) throw new Error(`X-sided patch edgeContinuity edges must be boundary edges in edges.edgeIds: ${outside.join(", ")}`);
      const bad = edgeContinuity.filter((entry) => !(entry.continuity in XSIDED_CONTINUITY));
      if (bad.length > 0) throw new Error(`X-sided patch edge continuity must be one of: ${Object.keys(XSIDED_CONTINUITY).join(", ")}`);
    }
    if (tension !== undefined && !(Number.isFinite(tension) && tension >= 0.1 && tension <= 1)) throw new Error("X-sided patch tension must be between 0.1 and 1.0");
    if (quality !== undefined && !(quality in XSIDED_QUALITY)) throw new Error(`X-sided patch quality must be one of: ${Object.keys(XSIDED_QUALITY).join(", ")}`);
    const needsContinuityEnum = continuity !== undefined || edgeContinuity !== undefined;
    const guided = guideIds !== undefined && guideIds.length > 0;
    if (guideIds !== undefined) {
      if (guideIds.length === 0 || new Set(guideIds).size !== guideIds.length) throw new Error("X-sided patch guide IDs must be a nonempty unique list");
      const invalid = guideIds.filter((id) => !wires.has(id));
      if (invalid.length > 0) throw new Error(`X-sided patch guides must be current Wire IDs: ${invalid.join(", ")}`);
      if (guideIds.some((id) => curveIds?.includes(id))) throw new Error("X-sided patch guide must not be one of the boundary curves");
    }
    try {
    await this.runtime.mutate(nativeFunction`async function (Factory${needsContinuityEnum ? ", ContinuityType" : ""}${quality !== undefined ? ", pk_default" : ""}, args) {
      ${findView}
      ${enumMember}
      ${commandStart(guided ? "XNurbsCommand" : "PatchCommand")}
      const wire = id => {
        const view = find(id);
        if (view.constructor.name !== 'Wire') throw new Error('X-sided patch curves must be Wires: ' + id);
        return view;
      };
      if (args.curveIds) factory.curves = args.curveIds.map(wire);
      if (args.edges) {
        const view = find(args.edges.bodyId);
        factory.edges = args.edges.edgeIds.map(edgeId => {
          const index = view.high.edges.versionIds.indexOf(edgeId);
          if (index < 0) throw new Error('Stale or unknown edge: ' + args.edges.bodyId + ':' + edgeId);
          return view.high.edges.get(index);
        });
        if (args.continuityName !== undefined) factory.continuity = enumMember(ContinuityType, 'ContinuityType', args.continuityName);${edgeContinuity !== undefined ? `
        for (const entry of args.edgeContinuity) {
          const edge = factory.edges[args.edges.edgeIds.indexOf(entry.edgeId)];
          if (!edge) throw new Error('Stale or unknown edge: ' + args.edges.bodyId + ':' + entry.edgeId);
          factory.setContinuityForEdge(edge, enumMember(ContinuityType, 'ContinuityType', entry.continuityName));
        }` : ""}
      }${tension !== undefined ? `
      factory.blending = args.tension;` : ""}${quality !== undefined ? `
      factory.enforceTolerance = enumMember(pk_default.a.EnforceToleranceType, 'EnforceToleranceType', args.qualityName);` : ""}
      if (args.guideIds) factory.guides = args.guideIds.map(wire);
      ${commandEnd}
    }`, ["XSidedFactory", ...(needsContinuityEnum ? ["ContinuityType"] : []), ...(quality !== undefined ? ["pk_default"] : [])], [{
      ...(curveIds !== undefined ? { curveIds } : {}),
      ...(edges !== undefined ? { edges } : {}),
      ...(guided ? { guideIds } : {}),
      ...(continuity !== undefined ? { continuityName: XSIDED_CONTINUITY[continuity] } : {}),
      ...(edgeContinuity !== undefined ? { edgeContinuity: edgeContinuity.map((entry) => ({ edgeId: entry.edgeId, continuityName: XSIDED_CONTINUITY[entry.continuity] })) } : {}),
      ...(tension !== undefined ? { tension } : {}),
      ...(quality !== undefined ? { qualityName: XSIDED_QUALITY[quality] } : {}),
    }]);
    } catch (error) {
      throw explainXNurbsError(error);
    }
    return await this.state();
  }

  // Converts one quad-dominant reference mesh into a native PolySplines body (FINDINGS gap 7). The reference mesh
  // is consumed and the result is a subdivision-limit surface, so a 10 mm cube comes out about 8.4 mm and rounded.
  async convertReferenceMeshToPolySplines(
    referenceMeshId: number,
    options: { mergePatches?: boolean | undefined; interpolateBoundary?: boolean | undefined },
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireReferenceMeshIds(state, [referenceMeshId]);
    for (const [name, value] of Object.entries(options)) {
      if (value !== undefined && typeof value !== "boolean") throw new Error(`PolySplines ${name} must be a boolean`);
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${commandStart("PolySplinesCommand")}
      const empty = nativeApi.db.lookupEmptyById(args.referenceMeshId);
      if (!nativeApi.isReferenceMesh(empty)) throw new Error('Unknown native reference mesh ID: ' + args.referenceMeshId);
      factory.empties = [empty];
      if (args.mergePatches !== undefined) factory.mergePatches = args.mergePatches;
      if (args.interpolateBoundary !== undefined) factory.interpolateBoundary = args.interpolateBoundary;
      ${commandEnd}
    }`, ["ConvertMeshToPolySplinesFactory"], [{
      referenceMeshId,
      ...(options.mergePatches !== undefined ? { mergePatches: options.mergePatches } : {}),
      ...(options.interpolateBoundary !== undefined ? { interpolateBoundary: options.interpolateBoundary } : {}),
    }]);
    return await this.state();
  }

  // Shows the control points of Sheet or Solid B-Surface faces (FINDINGS gap 5; probes-2026-11-followups). The
  // show is a history step and an edit of the body: face IDs change and every cvId of the body may renumber.
  // Only BSurf faces have points (a Plane or Cylinder face shows none but would still cost a step), so other
  // surface types are rejected first. Faces whose points are already shown cost no step either: a second show
  // is a history step that changes nothing (probe-facepoints-sheet.json). Faces split on one B-Surface carry
  // identical control grids, so their shown points could never be attributed: they are refused before the edit.
  // Returns only the requested faces' points, their grid shapes, and whether other faces' cvIds were renumbered.
  // undoSteps is measured from the Undo depth.
  async showFaceControlPoints(
    bodyId: number,
    faceIds: string[],
    revision: string,
  ): Promise<{ state: RuntimeState; faces: FaceControlPointFace[]; controlPoints: FaceControlPoint[]; grids: FaceControlGridShape[]; renumbered: boolean; undoSteps: number; message?: string }> {
    const state = await this.assertRevision(revision);
    this.requireFaceControlPointFaces(state, bodyId, faceIds, true);
    const before = await this.readFaceControlPointLayout(bodyId, { tolerant: true, duplicates: true });
    if (before.unattributed) {
      throw new Error(`The shown control points of body ${bodyId} cannot be attributed to faces (${before.unattributed}). Hide them with plasticity_hide_face_control_points first; nothing was changed`);
    }
    const requested = new Set(faceIds);
    const twins = (before.duplicates ?? []).filter((group) => group.some((id) => requested.has(id)));
    if (twins.length > 0) {
      throw new Error(`These faces share one control grid (faces split on one B-Surface): ${twins.map((group) => group.map((id) => `${bodyId}:${id}`).join(" = ")).join("; ")}. Plasticity's shown points could not be told apart, so the show is refused; nothing was changed`);
    }
    const gridsOf = (layout: FaceControlPointLayout, current: Map<string, string>): FaceControlGridShape[] => faceIds.flatMap((id) => {
      const grid = layout.grids?.find((candidate) => candidate.faceId === current.get(id));
      return grid ? [{ faceId: grid.faceId, u: grid.u, v: grid.v }] : [];
    });
    const shownBefore = new Set(before.blocks.map((block) => block.faceId));
    if (faceIds.every((id) => shownBefore.has(id))) {
      const same = mapFaceIds(before, before, faceIds);
      return { state, ...faceControlPointSelection(before, faceIds, same), grids: gridsOf(before, same), renumbered: false, undoSteps: 0, message: "control points of these faces are already shown; nothing changed" };
    }
    const entities = await this.toggleFaceControlPoints(bodyId, faceIds, true);
    const afterState = await this.state();
    const undoSteps = afterState.undoDepth - state.undoDepth;
    const { after, current } = await this.afterFaceControlPointEdit("Showing", bodyId, before, faceIds, entities, undoSteps);
    const selected = faceControlPointSelection(after, faceIds, current);
    // Plasticity numbers the shown points of all faces together: other faces' cvIds change with this edit.
    const wanted = new Set(faceIds.map((id) => current.get(id)!));
    const othersBefore = before.points.filter((point) => !requested.has(point.faceId)).map((point) => point.cvId);
    const othersAfter = after.points.filter((point) => !wanted.has(point.faceId)).map((point) => point.cvId);
    const renumbered = othersBefore.length > 0 && JSON.stringify(othersBefore) !== JSON.stringify(othersAfter);
    const empty = selected.faces.filter((face) => face.controlPointCount === 0).map((face) => `${bodyId}:${face.requestedFaceId}`);
    const notes = [
      ...(empty.length > 0 ? [`${empty.join(", ")} showed no editable control points; the show still took ${undoStepsText(undoSteps)}`] : []),
      ...(renumbered ? [`the cvIds of other faces' shown points of body ${bodyId} were renumbered; read them again before moving them`] : []),
    ];
    return {
      state: afterState, ...selected, grids: gridsOf(after, current), renumbered, undoSteps,
      ...(notes.length > 0 ? { message: notes.join("; ") } : {}),
    };
  }

  // Hides shown face control points (ShowFacePointsFactory with show = false; verified live in
  // probe-facepoints-sheet.json). One history step; the remaining points of the body renumber, so they are returned.
  // Faces with no shown points cost no step: hiding them would be a history step that changes nothing. Hiding works
  // by face, so it needs no per-point attribution: a body whose shown points cannot be attributed (faces split on
  // one B-Surface) can always be hidden. undoSteps is measured from the Undo depth.
  async hideFaceControlPoints(
    bodyId: number,
    faceIds: string[],
    revision: string,
  ): Promise<{ state: RuntimeState; faces: FaceControlPointFace[]; controlPoints: FaceControlPoint[]; undoSteps: number; message?: string }> {
    const state = await this.assertRevision(revision);
    this.requireFaceControlPointFaces(state, bodyId, faceIds, false);
    const before = await this.readFaceControlPointLayout(bodyId, { tolerant: true });
    const shownBefore = new Set(before.blocks.map((block) => block.faceId));
    const nothingShown = before.cvCount === 0 || (!before.unattributed && !faceIds.some((id) => shownBefore.has(id)));
    if (nothingShown) {
      return { state, faces: faceIds.map((id) => ({ requestedFaceId: id, faceId: id, controlPointCount: 0 })), controlPoints: before.points.map(publicPoint), undoSteps: 0, message: "no control points of these faces are shown; nothing changed" };
    }
    const entities = await this.toggleFaceControlPoints(bodyId, faceIds, false);
    const afterState = await this.state();
    const undoSteps = afterState.undoDepth - state.undoDepth;
    const steps = undoStepsText(undoSteps);
    let after: FaceControlPointLayout;
    let current: Map<string, string>;
    try {
      after = await this.readFaceControlPointLayout(bodyId, { tolerant: true });
      current = mapFaceIds(before, after, faceIds, entities);
    } catch (error) {
      throw new Error(`Hiding face control points took ${steps}, but the points could not be read back (${error instanceof Error ? error.message : String(error)}); inspect the body or undo`);
    }
    const faces = faceIds.map((id) => ({ requestedFaceId: id, faceId: current.get(id)!, controlPointCount: 0 }));
    if (after.unattributed) {
      // The hidden faces are gone from the points; the remaining ones still cannot be told apart.
      return {
        state: afterState, faces, controlPoints: [], undoSteps,
        message: `${after.cvCount ?? 0} shown control points of other faces of body ${bodyId} remain but cannot be attributed to faces (${after.unattributed}); hide those faces too`,
      };
    }
    const remaining = faceControlPointSelection(after, faceIds, current).faces.filter((face) => face.controlPointCount > 0);
    if (remaining.length > 0) {
      throw new Error(`Hiding face control points took ${steps}, but points remain on ${remaining.map((face) => `${bodyId}:${face.faceId}`).join(", ")}; inspect the body or undo`);
    }
    return { state: afterState, faces, controlPoints: after.points.map(publicPoint), undoSteps };
  }

  // Reads the layout after a show and finds the requested faces again. The step is already in the Undo history, so
  // a failure here says so instead of reading like an unchanged document.
  private async afterFaceControlPointEdit(verb: string, bodyId: number, before: FaceControlPointLayout, faceIds: string[], entities: Array<number | null>, undoSteps: number): Promise<{ after: FaceControlPointLayout; current: Map<string, string> }> {
    try {
      const after = await this.readFaceControlPointLayout(bodyId);
      return { after, current: mapFaceIds(before, after, faceIds, entities) };
    } catch (error) {
      throw new Error(`${verb} face control points took ${undoStepsText(undoSteps)}, but the points could not be read back (${error instanceof Error ? error.message : String(error)}); inspect the body or undo`);
    }
  }

  // Moves shown face control points by a shared world-space delta (FINDINGS gap 5). cvIds come from the show tool at
  // the current revision; unknown IDs are rejected before any native edit. Points of several faces move in one
  // step. The result is read back: each point must have moved by the delta on every axis within
  // faceControlPointTolerance (positions are float32, so the tolerance grows with the distance from the origin). A
  // delta the read-back could not tell from no move (every axis within the tolerance at that point) is refused
  // before the edit. Moving one of two coincident points on an edge shared by two faces leaves the other point in
  // place; on 26.1.3 Plasticity then rebuilds that face's surface (its grid grew from 4 x 2 to 7 x 2), the kernel
  // still reports the body valid, and the shown points no longer match the face's grid, so the read-back reports it
  // (probe-coincident-point.json). The error names the new revision, the undo, and both cvIds; when the twin face's
  // points are not shown it says to show that face first. undoSteps is measured; a verified move whose Undo depth did
  // not change reports undoSteps null with a note.
  // 26.1.3 writes factory.cvs directly; 26.2 face points are not verified (MultiMoveControlPointFactory is aliased).
  async moveFaceControlPoints(
    bodyId: number,
    cvIds: string[],
    deltaMm: Vector3,
    revision: string,
  ): Promise<{ state: RuntimeState; controlPoints: FaceControlPoint[]; undoSteps: number | null; message?: string }> {
    const state = await this.assertRevision(revision);
    const body = state.bodies.find((candidate) => candidate.id === bodyId);
    if (!body || (body.type !== "Sheet" && body.type !== "Solid")) throw new Error(`Face control points need a current Sheet or Solid body: ${bodyId}`);
    if (cvIds.length === 0 || new Set(cvIds).size !== cvIds.length) throw new Error("Face control point IDs must be a nonempty unique list");
    if (deltaMm.length !== 3 || deltaMm.some((value) => !Number.isFinite(value)) || Math.hypot(...deltaMm) === 0) {
      throw new Error("Face control point move delta must be a finite nonzero vector");
    }
    const before = await this.readFaceControlPointLayout(bodyId, { tolerant: true, hiddenGrids: true });
    if (before.unattributed) {
      throw new Error(`The shown control points of body ${bodyId} cannot be attributed to faces (${before.unattributed}), so a move could not be checked. Hide them with plasticity_hide_face_control_points; nothing was changed`);
    }
    const byId = new Map(before.points.map((point) => [point.cvId, point]));
    const missing = cvIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new Error(`Unknown face control point IDs on body ${bodyId}: ${missing.join(", ")}. Call plasticity_show_face_control_points first and use the cvId values it returns.`);
    }
    // The read-back passes when every axis is within the tolerance, so a delta inside the tolerance on every axis of
    // a point could not be told from no move at all: refuse it before the edit.
    const unverifiable = cvIds.flatMap((cvId) => {
      const expected = add(byId.get(cvId)!.rawMm, deltaMm);
      if (deltaMm.some((value, axis) => Math.abs(value) > faceControlPointTolerance(expected[axis]!))) return [];
      const axis = deltaMm.reduce((best, value, index) => Math.abs(value) > Math.abs(deltaMm[best]!) ? index : best, 0);
      return [{ cvId, resolution: faceControlPointTolerance(expected[axis]!) }];
    });
    if (unverifiable.length > 0) {
      const resolution = Math.max(...unverifiable.map((entry) => entry.resolution));
      throw new Error(`Face control point move delta [${deltaMm.join(", ")}] mm is below the verifiable resolution ${Number(resolution.toPrecision(3))} mm at this distance from the origin (cv ${unverifiable.map((entry) => entry.cvId).join(", ")}): the read-back could not tell the move from no move; nothing was changed`);
    }
    // Points of other faces that sit where a moved point sits (a shared edge) and are not moved with it: shown ones
    // (by cvId) and, from the kernel grids, ones of faces whose points are not shown.
    const moving = new Set(cvIds);
    const coincident = (a: Vector3, b: Vector3) => a.every((value, axis) => Math.abs(value - b[axis]!) <= faceControlPointTolerance(value));
    const separated = cvIds.flatMap((cvId) => {
      const point = byId.get(cvId)!;
      return before.points
        .filter((other) => !moving.has(other.cvId) && other.faceId !== point.faceId && coincident(other.rawMm, point.rawMm))
        .map((other) => `${cvId} and ${other.cvId}`);
    });
    const hiddenTwins = cvIds.flatMap((cvId) => {
      const point = byId.get(cvId)!;
      return (before.hiddenPoints ?? [])
        .filter((other) => other.faceId !== point.faceId && (coincident(other.rawMm, point.rawMm) || coincident(other.projectedMm, point.rawMm)))
        .map((other) => ({ cvId, faceId: other.faceId }));
    });
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      const available = new Map(Array.from(find(args.bodyId).high?.cvs ?? []).map(cv => [String(cv.versionId), cv]));
      const missing = args.cvIds.filter(id => !available.has(id));
      if (missing.length > 0) throw new Error('Unknown face control point IDs on body ' + args.bodyId + ': ' + missing.join(', ') + '. Call plasticity_show_face_control_points first and use the cvId values it returns.');
      const cvs = args.cvIds.map(id => available.get(id));
      ${commandStart("MoveControlPointCommand")}
      factory.cvs = cvs;
      factory.move.fromArray(args.delta);
      ${commandEnd}
    }`, ["MultiMoveControlPointFactory"], [{ bodyId, cvIds, delta: toMeters(deltaMm) }]);
    const afterState = await this.state();
    const measuredSteps = afterState.undoDepth - state.undoDepth;
    const steps = undoStepsText(measuredSteps);
    const twinFaces = [...new Set(hiddenTwins.map((twin) => `${bodyId}:${twin.faceId}`))];
    const twinParts = [
      ...(separated.length > 0 ? [`The move separated coincident points of two faces (${separated.join("; ")}): Plasticity reshapes the moved face when one point of a shared edge moves alone`] : []),
      ...(hiddenTwins.length > 0 ? [`cv ${[...new Set(hiddenTwins.map((twin) => twin.cvId))].join(", ")} sits on an edge shared with face ${twinFaces.join(", ")}, whose control points are not shown: Plasticity reshapes the moved face when one point of a shared edge moves alone; show ${twinFaces.length === 1 ? "that face" : "those faces"} with plasticity_show_face_control_points first`] : []),
    ];
    const separatedNote = twinParts.length > 0
      ? `. ${twinParts.join(". ")}. The document is now at revision ${afterState.revision}; undo with plasticity_undo, re-read the cvIds with plasticity_show_face_control_points, then include both cvIds to move a shared edge point`
      : "";
    const committed = (message: string) => new CommittedChangeError(message, afterState.revision, measuredSteps);
    let after: FaceControlPointLayout;
    try {
      after = await this.readFaceControlPointLayout(bodyId);
    } catch (error) {
      throw committed(`Moving face control points took ${steps}, but the points could not be read back (${error instanceof Error ? error.message : String(error)})${separatedNote}; inspect the body or undo`);
    }
    const entityOf = new Map(before.entities);
    const faceOfEntity = new Map(after.entities.map(([id, entity]) => [entity, id]));
    const blockOf = (faceId: string | undefined) => after.blocks.find((block) => block.faceId === faceId);
    const problems: string[] = [];
    const tolerances: string[] = [];
    const moved = cvIds.map((cvId) => {
      const old = byId.get(cvId)!;
      const faceId = faceOfEntity.get(entityOf.get(old.faceId) ?? null);
      const block = blockOf(faceId);
      const oldBlock = before.blocks.find((candidate) => candidate.faceId === old.faceId)!;
      if (!block || block.count !== oldBlock.count) {
        problems.push(`face ${old.faceId} lost or renumbered its control points`);
        return undefined;
      }
      const point = after.points.find((candidate) => candidate.faceId === faceId && candidate.index === old.index)!;
      // Unrounded float32 positions, checked per axis against a tolerance that grows with the coordinate.
      const expected = add(old.rawMm, deltaMm);
      const tolerance = expected.map(faceControlPointTolerance) as Vector3;
      if (point.rawMm.some((value, axis) => Math.abs(value - expected[axis]!) > tolerance[axis]!)) {
        const round = (value: number) => Math.round(value * 1000) / 1000;
        problems.push(`cv ${cvId} is at [${point.positionMm.join(", ")}], expected [${expected.map(round).join(", ")}]`);
        tolerances.push(`cv ${cvId} [${tolerance.map((value) => Number(value.toPrecision(3))).join(", ")}] mm`);
      }
      return publicPoint(point);
    });
    if (problems.length > 0) {
      const used = tolerances.length > 0 ? ` (read-back tolerance per axis: ${tolerances.join("; ")})` : "";
      throw committed(`Moving face control points took ${steps}, but the read-back does not match: ${problems.join("; ")}${separatedNote}; inspect the body or undo${used}`);
    }
    const notes = [
      ...(measuredSteps === 0 ? ["the move was read back, but the Undo depth did not change, so the number of Undo steps is unknown (undoSteps null)"] : []),
      ...(twinParts.length > 0 ? [`${twinParts.join("; ")}; include both cvIds to move a shared edge point`] : []),
    ];
    return {
      state: afterState, controlPoints: moved as FaceControlPoint[], undoSteps: measuredSteps === 0 ? null : measuredSteps,
      ...(notes.length > 0 ? { message: notes.join("; ") } : {}),
    };
  }

  // Body, face and surface checks shared by show and hide. A face the read model knows as a non-BSurf surface has
  // no editable control points (live: Plane and Cylinder show none, probe-facepoints-zero.json).
  private requireFaceControlPointFaces(state: RuntimeState, bodyId: number, faceIds: string[], requireBSurf: boolean): void {
    const body = state.bodies.find((candidate) => candidate.id === bodyId);
    if (!body || (body.type !== "Sheet" && body.type !== "Solid")) throw new Error(`Face control points need a current Sheet or Solid body: ${bodyId}`);
    if (faceIds.length === 0 || new Set(faceIds).size !== faceIds.length) throw new Error("Face control point face IDs must be a nonempty unique list");
    const unknown = faceIds.filter((id) => !body.faceIds.includes(id));
    if (unknown.length > 0) throw new Error(`Stale or unknown faces: ${unknown.map((id) => `${bodyId}:${id}`).join(", ")}`);
    if (!requireBSurf) return;
    const analytic = faceIds.flatMap((id) => {
      const face = body.faces.find((candidate) => candidate.id === id);
      return face && face.surfaceType !== "BSurf" ? [`${bodyId}:${id} (${face.surfaceType})`] : [];
    });
    if (analytic.length > 0) {
      throw new Error(`These faces have no editable control points: ${analytic.join(", ")}. The tool supports B-Surface (BSurf) faces only (Plane and Cylinder faces show none); nothing was changed`);
    }
  }

  // ShowFacePointsFactory with an explicit show flag; returns the kernel entity ids of the requested faces so the
  // caller can find the same faces after the edit (face version IDs change, entity ids stay; probe-facepoints-move.json).
  private async toggleFaceControlPoints(bodyId: number, faceIds: string[], show: boolean): Promise<Array<number | null>> {
    return await this.runtime.mutate<Array<number | null>>(nativeFunction`async function (Factory, args) {
      ${findView}
      let entities = [];
      ${commandStart("TogglePointsCommand")}
      const view = find(args.bodyId);
      factory.faces = args.faceIds.map(faceId => {
        const index = view.high.faces.versionIds.indexOf(faceId);
        if (index < 0) throw new Error('Stale or unknown face: ' + args.bodyId + ':' + faceId);
        return view.high.faces.get(index);
      });
      entities = factory.faces.map(face => face.entityId ?? null);
      factory.show = ${show ? "true" : "false"};
      ${commandEnd}
      return entities;
    }`, ["ShowFacePointsFactory"], [{ bodyId, faceIds }]);
  }

  // tolerant: report points that cannot be attributed (unattributed) instead of failing; duplicates: also find faces
  // whose control grids are identical.
  private async readFaceControlPointLayout(bodyId: number, options: { tolerant?: boolean; duplicates?: boolean; hiddenGrids?: boolean } = {}): Promise<FaceControlPointLayout> {
    return await this.runtime.read<FaceControlPointLayout>(nativeFunction`function (args) {
      ${FACE_CONTROL_POINT_LAYOUT}
    }`, [{ bodyId, ...(options.tolerant ? { tolerant: true } : {}), ...(options.duplicates ? { duplicates: true } : {}), ...(options.hiddenGrids ? { hiddenGrids: true } : {}) }]);
  }

  private async readFaceControlPoints(bodyId: number): Promise<FaceControlPoint[]> {
    return (await this.readFaceControlPointLayout(bodyId)).points.map(publicPoint);
  }

  // Runs a native command that reads the selection click point and waits for its own dialog (FINDINGS
  // probes-2026-11-pick). Everything runs inside ONE mutate call whose CDP timeout outlives the internal waits, so
  // the in-call cancel always runs before Node gives up. The native source reports facts (finish() called, how
  // execute() settled and with which error, the Undo delta before and after the settle window, what is active, how
  // the cancel and the cleanup went); the caller's read-back adds whether the body changed and the geometry check;
  // classifyPickOutcome decides. committed-verified returns; committed-mismatch throws a certain CommittedChangeError
  // (plasticity_undo restores it); rejected-unchanged throws a certain error (or returns when acceptUnchanged says
  // so); undetermined marks the runtime uncertain and throws with plasticity_reconcile.
  private async runPickCommand<T>(spec: PickCommandSpec): Promise<PickCommandResult<T>> {
    const timeouts = spec.timeouts ?? PICK_COMMAND_TIMEOUTS;
    for (const [name, value] of Object.entries(timeouts)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Pick command ${name} must be a positive whole number of milliseconds`);
    }
    // Without a caller read-back, the selected bodies are compared before and after the call.
    const bodyIds = [...new Set(spec.select.map((item) => item.bodyId))];
    const bodiesOf = (state: RuntimeState) => JSON.stringify(bodyIds.map((id) => state.bodies.find((body) => body.id === id) ?? null));
    const before = spec.readBack ? null : bodiesOf(await this.state());
    const native = await this.runtime.mutate<PickCommandNativeResult>(pickCommandSource(spec.drive, spec.extraBindings), [spec.command, spec.dialog, "Vector3", ...(spec.extraBindings ?? [])], [{
      select: spec.select,
      hits: spec.hits,
      driveArgs: spec.driveArgs ?? null,
      timeouts,
      // The settle window lies inside the cancelMs budget, so the CDP timeout needs no extra time for it.
      settleMs: timeouts.settleMs ?? PICK_COMMAND_SETTLE_MS,
      label: spec.label,
      ...(spec.domDialog ? { domDialog: true } : {}),
      ...(spec.cancelOnlyWhenAwaiting ? { cancelOnlyWhenAwaiting: true } : {}),
      ...(spec.restoreSelection ? { restoreSelection: true } : {}),
    }], pickCommandCdpTimeoutMs(timeouts));
    if (!native || typeof native !== "object" || typeof native.outcome !== "string") {
      this.runtime.markUncertain();
      throw new Error(`${spec.label} returned no outcome; ${PICK_RECONCILE}`);
    }
    if (!PICK_NATIVE_OUTCOMES.has(native.outcome)) {
      this.runtime.markUncertain();
      throw new Error(`${spec.label} returned an unknown outcome ${String(native.outcome)}; ${PICK_RECONCILE}`);
    }
    const run: PickCommandRun<T> = { native, drive: native.drive as T, facts: pickCommandFacts(native), timeouts };
    let readBack: PickReadBack;
    try {
      if (spec.readBack) readBack = await spec.readBack(run as PickCommandRun<unknown>);
      else {
        const after = await this.state();
        readBack = {
          bodyChanged: bodiesOf(after) !== before, geometry: null, revision: after.revision,
          subject: `bodies ${bodyIds.join(", ")}`, readback: "the helper has no read-back for this command", noChange: "no Undo step was added",
        };
      }
    } catch (error) {
      this.runtime.markUncertain();
      throw new Error(`${spec.label} ran, but the document could not be read back (${error instanceof Error ? error.message : String(error)}); ${PICK_RECONCILE}`);
    }
    const outcome = classifyPickOutcome({ ...run.facts, bodyChanged: readBack.bodyChanged, geometry: readBack.geometry });
    if (outcome.kind === "committed-verified") return { ...run, outcome };
    if (outcome.kind === "committed-mismatch") {
      throw new CommittedChangeError(
        `${spec.label} committed one Undo step, but the read-back does not match: ${readBack.readback}. The document is in a known state at revision ${readBack.revision}: one Undo step was added, and plasticity_undo restores the previous geometry`,
        readBack.revision, 1,
      );
    }
    if (outcome.kind === "rejected-unchanged") {
      if (spec.acceptUnchanged?.(run as PickCommandRun<unknown>)) return { ...run, outcome };
      throw new Error(pickRejectedMessage(spec, run as PickCommandRun<unknown>, outcome));
    }
    this.runtime.markUncertain();
    throw new Error(pickUndeterminedMessage(spec.label, run as PickCommandRun<unknown>, outcome, readBack));
  }

  // Sets the distance between a planar face and a reference face by moving movingFaceId, as Plasticity's Dimension
  // tool does (DimensionDistanceCommand; FINDINGS probes-2026-11-pick). Selection order decides which face moves:
  // the last selected face moves, so the selection is [reference, moving]; the hit location does not decide it
  // (probes-2026-11-followups/probe-driving.json). The seeded hit is the kernel's own point on the moving face
  // (a washer's midpoint lies in its hole), with the face's outward normal; it never comes from the caller.
  // runPickCommand classifies the run: committed-verified (success), committed-mismatch (a certain error: one Undo
  // step, plasticity_undo restores it), rejected-unchanged (a certain error, or the equal-distance no-op),
  // undetermined (runtime uncertain, plasticity_reconcile). Verified on Plasticity 26.1.3 only.
  async setDrivingDistance(
    input: { bodyId: number; movingFaceId: string; referenceFaceId?: string | undefined; distanceMm: number },
    revision: string,
    timeouts: PickCommandTimeouts = PICK_COMMAND_TIMEOUTS,
  ): Promise<DrivingDistanceResult> {
    const state = await this.assertRevision(revision);
    const { bodyId, movingFaceId, referenceFaceId, distanceMm } = input;
    requirePositiveFinite(distanceMm, "Driving distance");
    const body = state.bodies.find((candidate) => candidate.id === bodyId);
    if (!body || (body.type !== "Solid" && body.type !== "Sheet")) throw new Error(`Driving distance needs a current Solid or Sheet body: ${bodyId}`);
    const faceOf = (faceId: string, role: string) => {
      const face = body.faces.find((candidate) => candidate.id === faceId);
      if (!face) throw new Error(`Stale or unknown ${role} face: ${bodyId}:${faceId}`);
      if (!face.planar) throw new Error(`The ${role} face must be planar: ${bodyId}:${faceId}`);
      return face;
    };
    const moving = faceOf(movingFaceId, "moving");
    const movingNormal = normalize(moving.normal, "Moving face normal");
    const movingOffset = dot(movingNormal, moving.centerMm);
    let pairDistance: number | undefined;
    if (referenceFaceId !== undefined) {
      if (referenceFaceId === movingFaceId) throw new Error("The reference face must differ from the moving face");
      const reference = faceOf(referenceFaceId, "reference");
      const referenceNormal = normalize(reference.normal, "Reference face normal");
      // Opposite or same-direction normals are both allowed: Plasticity dimensions a stepped pair (two faces that
      // face the same way) live (probes-2026-11-followups/probe-driving.json, stepped case).
      if (1 - Math.abs(dot(movingNormal, referenceNormal)) > 1e-9) {
        throw new Error(`The moving and reference faces must be parallel planes: ${bodyId}:${movingFaceId} and ${bodyId}:${referenceFaceId} are not`);
      }
      const current = Math.abs(movingOffset - dot(movingNormal, reference.centerMm));
      pairDistance = current;
      if (current < 1e-6) {
        throw new Error(`The moving and reference faces lie in the same plane: ${bodyId}:${movingFaceId} and ${bodyId}:${referenceFaceId}`);
      }
      // Plasticity commits an Undo step even when the distance does not change, so an equal distance never runs.
      if (Math.abs(current - distanceMm) <= DRIVING_DISTANCE_TOLERANCE_MM) {
        return {
          state, changed: false, previousDistanceMm: roundMicro(current), distanceMm, undoSteps: 0,
          movedFaceId: null, movingFaceId, planeOffsetMm: roundMicro(movingOffset),
          message: `distance already ${roundMicro(current)} mm; nothing changed`,
        };
      }
    }
    // The body before the edit, by value: the read model may hand back the same objects after the edit.
    const snapshot = (faces: typeof body.faces): DrivingDistanceGeometryFace[] => faces.map((face) => ({
      id: face.id, planar: face.planar, centerMm: [...face.centerMm] as Vector3, normal: [...face.normal] as Vector3,
      boundsMm: face.boundsMm ? { min: [...face.boundsMm.min] as Vector3, max: [...face.boundsMm.max] as Vector3 } : null,
    }));
    const facesBefore = snapshot(body.faces);
    const versionBefore = body.versionId;
    const signatureOf = (faces: DrivingDistanceGeometryFace[]) => JSON.stringify(faces.map((face) => [face.id, face.centerMm, face.normal, face.boundsMm ?? null]));
    const signatureBefore = signatureOf(facesBefore);
    type Drive = { previousDistanceM: number | null; referencePointM?: Vector3 | null };
    const previousOf = (run: PickCommandRun<unknown>) => {
      const previousM = (run.drive as Drive | null)?.previousDistanceM;
      return typeof previousM === "number" && Number.isFinite(previousM) ? roundMicro(previousM * 1000) : null;
    };
    const currentOf = (run: PickCommandRun<unknown>) => previousOf(run) ?? (pairDistance !== undefined ? roundMicro(pairDistance) : null);
    let after: RuntimeState | undefined;
    let geometry: DrivingDistanceGeometryCheck | null = null;
    const movingRef: PickItemReference = { kind: "face", bodyId, id: movingFaceId };
    const run = await this.runPickCommand<Drive>({
      command: "DimensionDistanceCommand",
      dialog: "DimensionDistanceSpaceDialog",
      select: referenceFaceId === undefined ? [movingRef] : [{ kind: "face", bodyId, id: referenceFaceId }, movingRef],
      hits: [{ item: movingRef, pointM: toMeters(moving.centerMm), normalM: movingNormal, onFace: true }],
      drive: DRIVING_DISTANCE_DRIVE,
      driveArgs: { distanceM: millimetersToMeters(distanceMm) },
      rejectedMessage: "Plasticity could not dimension these faces (no effect)",
      label: "Driving distance",
      timeouts,
      readBack: async (picked) => {
        after = await this.state();
        const bodyAfter = after.bodies.find((candidate) => candidate.id === bodyId);
        const facesAfter = bodyAfter ? snapshot(bodyAfter.faces) : [];
        const currentMm = currentOf(picked);
        const noChange = `Plasticity made no change: distance is still ${currentMm === null ? "unknown" : `${currentMm} mm`}, requested ${distanceMm} mm`;
        let readback = "the read-back did not run";
        // The geometry check runs for a one-step commit after finish(): face IDs change, so it tracks planes and footprints.
        if (picked.facts.finishCalled && picked.native.undoDelta === 1) {
          const hitM = Array.isArray(picked.native.hits?.[0]) ? picked.native.hits![0] : null;
          const referencePoint = (picked.drive as Drive | null)?.referencePointM;
          const previousMm = previousOf(picked);
          try {
            geometry = checkDrivingDistanceGeometry({
              bodyId, movingFaceId, referenceFaceId, distanceMm,
              hitPointMm: hitM && hitM.every(Number.isFinite) ? hitM.map((value) => value * 1000) as Vector3 : null,
              referencePointMm: Array.isArray(referencePoint) && referencePoint.every(Number.isFinite) ? referencePoint.map((value) => value * 1000) as Vector3 : null,
              referenceOffsetMm: previousMm !== null ? movingOffset - previousMm : null,
              before: facesBefore, after: facesAfter,
            });
            if (!geometry.ok) readback = `${geometry.problem} along [${geometry.normal.join(", ")}] (planes now: ${geometry.planesNow})${geometry.nothingMoved ? `; ${noChange}` : ""}`;
          } catch (error) {
            readback = error instanceof Error ? error.message : String(error);
          }
        }
        return {
          bodyChanged: !bodyAfter || bodyAfter.versionId !== versionBefore || signatureOf(facesAfter) !== signatureBefore,
          geometry: geometry === null ? null : !geometry.ok ? "fail" : geometry.ambiguous ? "ambiguous" : "pass",
          revision: after.revision, subject: `body ${bodyId}`, readback, noChange,
        };
      },
      // Single-face mode with an equal distance: the dialog opens, finish() gives "Operation has no effect" and
      // nothing changes (probes-2026-11-followups/probe-driving.json, equal_single_face_pz_5mm).
      acceptUnchanged: (picked) => {
        const currentMm = currentOf(picked);
        return picked.facts.finishCalled && currentMm !== null && Math.abs(currentMm - distanceMm) <= DRIVING_DISTANCE_TOLERANCE_MM;
      },
    });
    const previousDistanceMm = previousOf(run as PickCommandRun<unknown>);
    if (run.outcome.kind === "rejected-unchanged") {
      return {
        state: after!, changed: false, previousDistanceMm, distanceMm, undoSteps: 0, movedFaceId: null, movingFaceId, planeOffsetMm: roundMicro(movingOffset),
        message: `distance already ${currentOf(run as PickCommandRun<unknown>)} mm; nothing changed`,
      };
    }
    const check = geometry as DrivingDistanceGeometryCheck | null;
    const moved = check!.movedFace!;
    const note = pickVerifiedNote(run.native, run.timeouts);
    return {
      state: after!, changed: true, previousDistanceMm, distanceMm, undoSteps: 1, movedFaceId: moved.id, movingFaceId: moved.id,
      planeOffsetMm: roundMicro(dot(check!.normal, moved.centerMm)),
      ...(check!.ambiguous ? { verification: "ambiguous" as const, note: check!.note! } : {}),
      ...(note ? { message: note } : {}),
      ...(run.native.foreignActive ? { warning: `Another Plasticity command (${run.native.foreignActive}) is active; it is not part of this edit and was left alone` } : {}),
    };
  }

  // Square (surfacing P7; FINDINGS probes-2026-11-surfacing section 5): one four-sided XNurbs Sheet from four boundary
  // items, each a Sheet/Solid boundary edge or a Wire, factory-direct (SquareFactory.boundaries is one flat list; the
  // command route opens an empty factory). Per-edge continuity g0 or g1 only: g2 never measured as G2 live. One Undo step.
  async squareSurface(
    input: { boundary: Array<{ bodyId: number; edgeId: string } | { wireId: number }>; edgeContinuity?: Array<{ edgeId: string; continuity: "g0" | "g1" }> | undefined },
    revision: string,
  ): Promise<{ state: RuntimeState; sheetId: number; undoSteps: number }> {
    const state = await this.assertRevision(revision);
    const { boundary, edgeContinuity } = input;
    if (boundary.length !== 4) throw new Error("Square needs exactly four boundary items");
    const keys = boundary.map((item) => ("wireId" in item ? `wire:${item.wireId}` : `edge:${item.bodyId}:${item.edgeId}`));
    if (new Set(keys).size !== 4) throw new Error("Square boundary items must be unique");
    for (const item of boundary) {
      if ("wireId" in item) {
        const wire = state.bodies.find((body) => body.id === item.wireId);
        if (!wire || wire.type !== "Wire") throw new Error(`Square boundary wireId must be a current Wire: ${item.wireId}`);
      } else {
        const body = state.bodies.find((candidate) => candidate.id === item.bodyId);
        if (!body || (body.type !== "Sheet" && body.type !== "Solid")) throw new Error(`Square boundary edges need a current Sheet or Solid body: ${item.bodyId}`);
        const edge = body.edges.find((candidate) => candidate.id === item.edgeId);
        if (!edge) throw new Error(`Stale or unknown Square boundary edge: ${item.bodyId}:${item.edgeId}`);
      }
    }
    const boundaryEdgeIds = boundary.flatMap((item) => ("edgeId" in item ? [item.edgeId] : []));
    if (edgeContinuity !== undefined) {
      if (edgeContinuity.length === 0) throw new Error("Square edgeContinuity must not be empty");
      const ids = edgeContinuity.map((entry) => entry.edgeId);
      if (new Set(ids).size !== ids.length) throw new Error("Square edgeContinuity edge IDs must be unique");
      const outside = ids.filter((id) => !boundaryEdgeIds.includes(id));
      if (outside.length > 0) throw new Error(`Square edgeContinuity applies to boundary edges given in boundary: ${outside.join(", ")}`);
      const bad = edgeContinuity.filter((entry) => entry.continuity !== "g0" && entry.continuity !== "g1");
      if (bad.length > 0) throw new Error("Square edge continuity must be g0 or g1 (g2 never measured as G2 on 26.1.3)");
    }
    // Closure before any edit: XNurbs builds over a 0.005 mm corner gap, and refuses 1 mm with error 31.
    const endsM = await this.runtime.read<Vector3[][]>(SQUARE_ENDS_SOURCE, [{ boundary: boundary.map((item) => ("wireId" in item ? { wireId: item.wireId } : { bodyId: item.bodyId, edgeId: item.edgeId })) }]);
    const problem = squareClosureProblem(endsM.map((ends) => ends.map((point) => point.map((value) => value * 1000) as Vector3)));
    if (problem) throw new Error(`Square boundary is open: ${problem}; nothing was changed`);
    const beforeIds = new Set(state.bodies.map((body) => body.id));
    try {
      await this.runtime.mutate(nativeFunction`async function (Factory, Command, ContinuityType, args) {
        ${findView}
        ${enumMember}
        if (this.executor.isBusy || this.executor.active) throw new Error('Plasticity is busy; finish or cancel the active command first');
        const editor = this;
        let failure;
        const command = new Command(editor);
        command.remember = false;
        command.execute = async function () {
          try {
            const factory = new Factory(editor).resource(this);
            const views = args.boundary.map(item => {
              const view = find(item.wireId ?? item.bodyId);
              if (item.wireId !== undefined) {
                if (view.constructor.name !== 'Wire') throw new Error('Square boundary must be a Wire: ' + item.wireId);
                return view;
              }
              const index = view.high?.edges?.versionIds?.indexOf(item.edgeId) ?? -1;
              if (index < 0) throw new Error('Stale or unknown edge: ' + item.bodyId + ':' + item.edgeId);
              return view.high.edges.get(index);
            });
            factory.boundaries = views;
            for (const entry of args.edgeContinuity ?? []) {
              const at = args.boundary.findIndex(item => item.edgeId === entry.edgeId);
              factory.setContinuityForEdge(views[at], enumMember(ContinuityType, 'ContinuityType', entry.continuityName));
            }
            return await factory.commit();
          } catch (error) { failure = error; throw error; }
        };
        await this.exec(command);
        if (failure) throw failure;
      }`, ["SquareFactory", "SquareEdgeCommand", "ContinuityType"], [{
        boundary: boundary.map((item) => ("wireId" in item ? { wireId: item.wireId } : { bodyId: item.bodyId, edgeId: item.edgeId })),
        ...(edgeContinuity !== undefined ? { edgeContinuity: edgeContinuity.map((entry) => ({ edgeId: entry.edgeId, continuityName: entry.continuity === "g1" ? "G1" : "G0" })) } : {}),
      }]);
    } catch (error) {
      throw explainXNurbsError(error);
    }
    const after = await this.state();
    const added = after.bodies.filter((body) => !beforeIds.has(body.id));
    const sheet = added.find((body) => body.type === "Sheet");
    const undoSteps = after.undoDepth - state.undoDepth;
    if (!sheet || added.length !== 1 || undoSteps !== 1) {
      throw new CommittedChangeError(`Square committed, but the read-back does not match: ${added.length} new bodies (${added.map((body) => `${body.id} ${body.type}`).join(", ") || "none"}), ${undoSteps} Undo steps. The document is at revision ${after.revision}; plasticity_undo restores it`, after.revision, undoSteps);
    }
    return { state: after, sheetId: sheet.id, undoSteps };
  }

  // Surface Align (surfacing P6; FINDINGS probes-2026-11-surfacing section 4): moves the moving Sheet's boundary edge onto
  // the reference Sheet's boundary edge with g0/g1/g2 continuity, through the real AlignEdgeCommand on runPickCommand's
  // lifecycle (one mutate call, our command identity-checked, cancel in the same call, classifyPickOutcome). The read-back
  // samples both edges in the kernel: the moving edge must lie on the reference edge within 0.001 mm. Achieved continuity
  // is not measured (the sheets are separate bodies; a join would change the document).
  async surfaceAlign(
    input: { moving: { bodyId: number; edgeId: string }; reference: { bodyId: number; edgeId: string }; continuity: SurfaceAlignContinuity },
    revision: string,
    timeouts: PickCommandTimeouts = SURFACE_ALIGN_TIMEOUTS,
  ) {
    const state = await this.assertRevision(revision);
    const { moving, reference, continuity } = input;
    if (!(continuity in SURFACE_ALIGN_CONTINUITY)) throw new Error(`Surface Align continuity must be one of: ${Object.keys(SURFACE_ALIGN_CONTINUITY).join(", ")}`);
    if (moving.bodyId === reference.bodyId) throw new Error("Surface Align needs two different Sheet bodies (two edges of one body were never verified)");
    const boundaryEdge = (ref: { bodyId: number; edgeId: string }, role: string) => {
      const body = state.bodies.find((candidate) => candidate.id === ref.bodyId);
      if (!body || body.type !== "Sheet") throw new Error(`Surface Align ${role} must be a current Sheet body (Solid edges were never verified): ${ref.bodyId}`);
      const edge = body.edges.find((candidate) => candidate.id === ref.edgeId);
      if (!edge) throw new Error(`Stale or unknown ${role} edge: ${ref.bodyId}:${ref.edgeId}`);
      if (edge.faceIds.length !== 1) throw new Error(`The ${role} edge must be a boundary edge of its Sheet (one face): ${ref.bodyId}:${ref.edgeId}`);
      return body;
    };
    const movingBody = boundaryEdge(moving, "moving");
    const referenceBody = boundaryEdge(reference, "reference");
    let after: RuntimeState | undefined;
    let measured: AlignReadBackNative | undefined;
    const run = await this.runPickCommand<{ readiness: string; readyAfterMs: number }>({
      command: "AlignEdgeCommand",
      dialog: "AlignEdgeDialog",
      // The first selected edge moves (verified both ways, probe-align-3.json and -swapped.json).
      select: [{ kind: "edge", bodyId: moving.bodyId, id: moving.edgeId }, { kind: "edge", bodyId: reference.bodyId, id: reference.edgeId }],
      hits: [],
      drive: SURFACE_ALIGN_DRIVE,
      driveArgs: { movingEdgeId: moving.edgeId, referenceEdgeId: reference.edgeId, continuityName: SURFACE_ALIGN_CONTINUITY[continuity], readyMs: SURFACE_ALIGN_READY_MS, fallbackWaitMs: SURFACE_ALIGN_FALLBACK_WAIT_MS },
      extraBindings: ["ContinuityType"],
      domDialog: true,
      cancelOnlyWhenAwaiting: true,
      restoreSelection: true,
      rejectedMessage: "Plasticity could not align these edges (no effect)",
      label: "Surface Align",
      timeouts,
      readBack: async (picked) => {
        after = await this.state();
        const movingAfter = after.bodies.find((candidate) => candidate.id === moving.bodyId);
        const referenceAfter = after.bodies.find((candidate) => candidate.id === reference.bodyId);
        const bodyChanged = !movingAfter || !referenceAfter || movingAfter.versionId !== movingBody.versionId || referenceAfter.versionId !== referenceBody.versionId;
        let geometry: "pass" | "fail" | null = null;
        let readback = "the read-back did not run";
        if (picked.facts.finishCalled && picked.native.undoDelta === 1) {
          try {
            measured = await this.runtime.read<AlignReadBackNative>(SURFACE_ALIGN_READBACK_SOURCE, [{ reference, movingBodyId: moving.bodyId, samples: 21 }]);
            const gapMm = measured.maxGapM === null ? null : measured.maxGapM * 1000;
            const referenceKept = referenceAfter?.versionId === referenceBody.versionId;
            const movingMoved = movingAfter !== undefined && movingAfter.versionId !== movingBody.versionId;
            geometry = measured.referenceFound && gapMm !== null && gapMm <= SURFACE_ALIGN_COINCIDENCE_MM && referenceKept && movingMoved ? "pass" : "fail";
            readback = !measured.referenceFound ? "the reference edge is gone" : !referenceKept ? "the reference Sheet changed" : !movingMoved ? "the moving Sheet did not change" : `the moving Sheet's nearest edge lies up to ${gapMm} mm from the reference edge (needs <= ${SURFACE_ALIGN_COINCIDENCE_MM} mm)`;
          } catch (error) {
            readback = error instanceof Error ? error.message : String(error);
          }
        }
        return { bodyChanged, geometry, revision: after.revision, subject: `Sheets ${moving.bodyId} and ${reference.bodyId}`, readback, noChange: "no Undo step was added" };
      },
    });
    const gapMm = measured!.maxGapM! * 1000;
    return {
      state: after!,
      undoSteps: 1,
      moving: { bodyId: moving.bodyId, edgeId: measured!.movingEdgeId },
      reference,
      continuity,
      coincidence: { maxGapMm: Math.round(gapMm * 1e9) / 1e9, toleranceMm: SURFACE_ALIGN_COINCIDENCE_MM, samples: measured!.samples },
      ...(measured!.maxNormalAngleDeg !== null ? { maxTangentPlaneAngleDeg: Math.round(measured!.maxNormalAngleDeg * 1e9) / 1e9 } : {}),
      achieved: "not measured" as const,
      note: "The sheets stay separate, so the achieved continuity is not measured: join them with plasticity_join_sheets, then call plasticity_analyze_surface_continuity on the shared edge. maxTangentPlaneAngleDeg is the largest angle between the two faces' tangent planes at 21 kernel samples along the reference edge.",
      readiness: run.drive?.readiness ?? null,
      ...(run.native.foreignActive ? { warning: `Another Plasticity command (${run.native.foreignActive}) is active; it is not part of this edit and was left alone` } : {}),
    };
  }

  async bridgeSurface(
    first: { bodyId: number; faceId: string; pickPointMm: Vector3 },
    second: { bodyId: number; faceId: string; pickPointMm: Vector3 },
    widthMm: number,
    softness: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (!Number.isFinite(widthMm) || widthMm <= 0) throw new Error("Surface Bridge width must be positive");
    if (!Number.isFinite(softness) || softness <= 0) throw new Error("Surface Bridge softness must be positive");
    if ([...first.pickPointMm, ...second.pickPointMm].some((value) => !Number.isFinite(value))) {
      throw new Error("Surface Bridge pick points must contain finite coordinates");
    }
    if (first.bodyId === second.bodyId) throw new Error("Surface Bridge requires faces from two different Sheet bodies");
    const references = [first, second];
    const invalid = references.filter((reference) => {
      const body = state.bodies.find((candidate) => candidate.id === reference.bodyId);
      return body?.type !== "Sheet" || !body.faceIds.includes(reference.faceId);
    });
    if (invalid.length > 0) {
      throw new Error(`Surface Bridge requires current Sheet faces; stale or unknown: ${invalid.map((reference) => `${reference.bodyId}:${reference.faceId}`).join(", ")}`);
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, Vector, BlendShape, BlendTrim, args) {
      ${findView}
      ${commandStart("BridgeSurfaceCommand")}
      const face = ref => {
        const view = find(ref.bodyId);
        if (view.constructor.name !== 'Sheet') throw new Error('Surface Bridge inputs must be Sheet bodies');
        const index = view.high.faces.versionIds.indexOf(ref.faceId);
        if (index < 0) throw new Error('Stale or unknown Sheet face: ' + ref.faceId);
        return view.high.faces.get(index);
      };
      factory.shape = BlendShape.G2;
      factory.trimBlend = BlendTrim.Both;
      factory.trimWalls = true;
      factory.propagate = true;
      factory.width = args.width;
      factory.softness = args.softness;
      factory.push(face(args.faces[0]), false, new Vector(...args.pickPoints[0]));
      factory.push(face(args.faces[1]), false, new Vector(...args.pickPoints[1]));
      ${commandEnd}
    }`, ["BridgeSurfaceWithPreviewFactory", "Vector3", "BlendShape", "BlendTrim"], [{
      faces: references.map(({ bodyId, faceId }) => ({ bodyId, faceId })),
      pickPoints: references.map(({ pickPointMm }) => toMeters(pickPointMm)),
      width: millimetersToMeters(widthMm),
      softness,
    }]);
    return await this.state();
  }

  async joinSheets(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (ids.length < 2) throw new Error("At least two Sheet IDs are required");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Sheet IDs must be unique");
    const invalid = uniqueIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Sheet");
    if (invalid.length > 0) throw new Error(`Join requires current Sheet bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("JoinSheetsCommand")}
      factory.sheets = args.ids.map(id => {
        const sheet = find(id);
        if (sheet.constructor.name !== 'Sheet') throw new Error('Join inputs must be Sheet bodies');
        return sheet;
      });
      ${commandEnd}
    }`, ["JoinSheetsFactory"], [{ ids: uniqueIds }]);
    return await this.state();
  }

  async createConstrainedSurface(
    pointsMm: Vector3[],
    normals: Vector3[],
    options: {
      toleranceMm?: number;
      angularToleranceDegrees?: number;
      optimization?: "performance" | "smoothness";
    },
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (pointsMm.length < 4) throw new Error("Constrained surface requires at least four points");
    if (normals.length !== pointsMm.length) throw new Error("Constrained surface requires one normal per point");
    if (new Set(pointsMm.map((point) => point.join(","))).size < 4) {
      throw new Error("Constrained surface requires at least four distinct points");
    }
    const normalizedNormals = normals.map((normal) => {
      const length = Math.hypot(...normal);
      if (!Number.isFinite(length) || length === 0) throw new Error("Each constrained-surface normal must be nonzero");
      return normal.map((value) => value / length) as Vector3;
    });
    const toleranceMm = options.toleranceMm ?? 0.01;
    if (!Number.isFinite(toleranceMm) || toleranceMm <= 0) throw new Error("Constrained-surface tolerance must be positive");
    const angularToleranceDegrees = options.angularToleranceDegrees ?? 5;
    if (!Number.isFinite(angularToleranceDegrees) || angularToleranceDegrees <= 0 || angularToleranceDegrees > 90) {
      throw new Error("Constrained-surface angular tolerance must be greater than zero and at most 90 degrees");
    }
    const optimizationName = options.optimization === "smoothness" ? "Smoothness" : "Performance";
    await this.runtime.mutate(`async function (Factory, Vector, ConstrainedSurfaceOptimizationType, args) {
      ${commandStart("ConstrainedSurfaceCommand")}
      factory.points = args.points.map(point => new Vector(...point));
      factory.normals = args.normals.map(normal => new Vector(...normal));
      factory.tolerance = args.tolerance;
      factory.angularToleranceDegrees = args.angularToleranceDegrees;
      factory.optimize = ConstrainedSurfaceOptimizationType[args.optimizationName];
      ${commandEnd}
    }`, ["ConstrainedSurfaceFactory", "Vector3", "ConstrainedSurfaceOptimizationType"], [{
      points: pointsMm.map(toMeters),
      normals: normalizedNormals,
      tolerance: millimetersToMeters(toleranceMm),
      angularToleranceDegrees,
      optimizationName,
    }]);
    return await this.state();
  }

  async extractFaces(faces: Array<{ bodyId: number; faceId: string }>, revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (faces.length === 0) throw new Error("At least one face reference is required");
    const keys = faces.map((face) => `${face.bodyId}:${face.faceId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Face references must be unique");
    const invalid = faces.filter((reference) =>
      !state.bodies.find((body) => body.id === reference.bodyId)?.faceIds.includes(reference.faceId));
    if (invalid.length > 0) {
      throw new Error(`Stale or unknown faces: ${invalid.map((face) => `${face.bodyId}:${face.faceId}`).join(", ")}`);
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("CreateSolidFromFacesCommand")}
      factory.faces = args.faces.map(ref => {
        const view = find(ref.bodyId);
        const index = view.high.faces.versionIds.indexOf(ref.faceId);
        if (index < 0) throw new Error('Stale or unknown face: ' + ref.faceId);
        return view.high.faces.get(index);
      });
      ${commandEnd}
    }`, ["CreateSheetFromFacesFactory"], [{ faces }]);
    return await this.state();
  }

  async unwrapFace(face: FaceReference, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, [face], "face");
    const descriptor = state.bodies.find((body) => body.id === face.bodyId)!.faces.find((candidate) => candidate.id === face.faceId)!;
    if (descriptor.surfaceType !== "Cylinder") {
      throw new Error(`Exact face unwrapping requires an analytic Cylinder face: ${face.bodyId}:${face.faceId}`);
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const view = find(args.face.bodyId);
          const index = view.high.faces.versionIds.indexOf(args.face.faceId);
          if (index < 0) throw new Error('Stale or unknown face: ' + args.face.faceId);
          const selectedFaces = [view.high.faces.get(index)];
          const factory = new Factory(editor).resource(this);
          factory.faces = selectedFaces;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["UnwrapFactory"], [{ face }]);
    return await this.state();
  }

  async analyzeConeDevelopment(face: FaceReference, revision: string): Promise<{
    documentToken: string;
    revision: string;
    measurementSource: "native-brep";
    bodyId: number;
    faceId: string;
    boundaryRadiusMm: [number, number];
    development: ReturnType<typeof calculateConeDevelopment>;
  }> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, [face], "face");
    const body = state.bodies.find((candidate) => candidate.id === face.bodyId)!;
    if (body.type !== "Solid" && body.type !== "Sheet") {
      throw new Error(`Cone development requires a current Solid or Sheet body: ${face.bodyId}`);
    }
    const descriptor = body.faces.find((candidate) => candidate.id === face.faceId)!;
    if (descriptor.surfaceType !== "Cone") {
      throw new Error(`Cone development requires a current native Cone face: ${face.bodyId}:${face.faceId}`);
    }
    if (descriptor.axisOriginMm === null || descriptor.axisDirection === null || descriptor.coneBasisRadiusMm === undefined || descriptor.coneSemiAngleRad === undefined) {
      throw new Error(`Cone face is missing exact native basis parameters: ${face.bodyId}:${face.faceId}`);
    }

    const boundaryEdges = body.edges.filter((edge) => descriptor.edgeIds.includes(edge.id) && edge.faceIds.includes(face.faceId));
    const circularEdges = boundaryEdges.filter((edge) => edge.circle && edge.curveType === "Circle");
    const seamEdges = boundaryEdges.filter((edge) => edge.line && edge.curveType === "Line");
    if (boundaryEdges.length !== 3 || circularEdges.length !== 2 || seamEdges.length !== 1) {
      throw new Error("Cone development currently requires one complete frustum face bounded by two full circles and one straight seam");
    }

    const development = calculateConeDevelopment({
      basisRadiusMm: descriptor.coneBasisRadiusMm,
      semiAngleRad: descriptor.coneSemiAngleRad,
      axisOriginMm: descriptor.axisOriginMm,
      axisDirection: descriptor.axisDirection,
      circularBoundaries: circularEdges.map((edge) => ({ pointOnCircleMm: edge.centerMm, circumferenceMm: edge.lengthMm })),
    });
    const seamSlantLengthMm = seamEdges[0]!.lengthMm;
    if (Math.abs(seamSlantLengthMm - development.slantLengthMm) > 0.01) {
      throw new Error("Cone development seam length does not match the exact frustum slant length");
    }

    return {
      documentToken: state.documentToken,
      revision: state.revision,
      measurementSource: "native-brep",
      bodyId: face.bodyId,
      faceId: face.faceId,
      boundaryRadiusMm: circularEdges.map((edge) => edge.lengthMm / (2 * Math.PI)).sort((first, second) => first - second) as [number, number],
      development,
    };
  }

  async createConeDevelopment(face: FaceReference, originMm: Vector3, revision: string): Promise<{
    documentToken: string;
    revision: string;
    measurementSource: "native-brep";
    sourceFace: FaceReference;
    profileWireId: number;
    sheetBodyId: number;
    originMm: Vector3;
    boundaryRadiusMm: [number, number];
    development: ReturnType<typeof calculateConeDevelopment>;
    sourceAreaMm2: number;
    sheetAreaMm2: number;
    sheetBoundaryLengthsMm: number[];
    validation: BodyValidationDescriptor;
    historySteps: number;
  }> {
    if (originMm.some((value) => !Number.isFinite(value))) throw new Error("Cone development placement origin must be finite");
    const initial = await this.assertRevision(revision);
    const analysis = await this.analyzeConeDevelopment(face, revision);
    const descriptor = initial.bodies.find((body) => body.id === face.bodyId)!.faces.find((candidate) => candidate.id === face.faceId)!;
    const plan = planConeDevelopmentCurves(originMm, analysis.development);
    const sourceProperties = await this.measureFaceProperties([face], revision);
    const sourceAreaMm2 = sourceProperties.faces[0]!.areaMm2;
    const expectedAreaMm2 = Math.PI * (analysis.boundaryRadiusMm[0] + analysis.boundaryRadiusMm[1]) * analysis.development.slantLengthMm;
    if (Math.abs(sourceAreaMm2 - expectedAreaMm2) > Math.max(0.01, expectedAreaMm2 * 1e-6)) {
      throw new Error("Native cone face area does not match the full-frustum lateral area; no development geometry was created");
    }

    const originalBodies = new Map(initial.bodies.map((body) => [body.id, JSON.stringify(body)]));
    let state = initial;
    const createdWireIds: number[] = [];
    const assertOriginalBodiesUnchanged = (next: RuntimeState): void => {
      if (next.documentToken !== initial.documentToken) throw new Error("Plasticity document changed during cone development; inspect the partial result before continuing");
      for (const [id, snapshot] of originalBodies) {
        const current = next.bodies.find((body) => body.id === id);
        if (!current || JSON.stringify(current) !== snapshot) {
          throw new Error(`An original CAD body changed during cone development: ${id}; inspect the partial result before continuing`);
        }
      }
    };
    const createCurve = async (operation: Promise<RuntimeState>): Promise<number> => {
      const before = state;
      const next = await operation;
      assertOriginalBodiesUnchanged(next);
      if (next.undoDepth !== before.undoDepth + 1) {
        throw new Error("Cone development curve did not create exactly one history step; inspect the partial result before continuing");
      }
      const beforeIds = new Set(before.bodies.map((body) => body.id));
      const additions = next.bodies.filter((body) => !beforeIds.has(body.id));
      if (additions.length !== 1 || additions[0]!.type !== "Wire") {
        throw new Error("Cone development expected one new native Wire per curve; inspect the partial result before continuing");
      }
      if (createdWireIds.some((id) => !next.bodies.some((body) => body.id === id))) {
        throw new Error("A previously created cone development curve disappeared; inspect the partial result before continuing");
      }
      createdWireIds.push(additions[0]!.id);
      state = next;
      return additions[0]!.id;
    };

    for (const arc of plan.arcs) {
      await createCurve(this.createCenterArc(arc.centerMm, arc.radiusMm, arc.startAngleDegrees, arc.sweepAngleDegrees, state.revision, plan.normal, plan.xDirection));
    }
    for (const [start, end] of plan.radialSegments) {
      await createCurve(this.createPolyline([start, end], false, state.revision));
    }

    const beforeJoin = state;
    const joined = await this.joinCurves(createdWireIds, beforeJoin.revision);
    assertOriginalBodiesUnchanged(joined);
    if (joined.undoDepth !== beforeJoin.undoDepth + 1) throw new Error("Cone development join did not create exactly one history step; inspect the partial result before continuing");
    const joinedWires = joined.bodies.filter((body) => !originalBodies.has(body.id));
    if (joinedWires.length !== 1 || joinedWires[0]!.type !== "Wire") {
      throw new Error("Native curve join did not produce exactly one development Wire; inspect the partial result before continuing");
    }
    const profileWireId = joinedWires[0]!.id;
    state = joined;

    const beforePatch = state;
    const patched = await this.patchClosedWires([profileWireId], beforePatch.revision);
    assertOriginalBodiesUnchanged(patched);
    if (patched.undoDepth !== beforePatch.undoDepth + 1) throw new Error("Cone development patch did not create exactly one history step; inspect the partial result before continuing");
    const developmentBodies = patched.bodies.filter((body) => !originalBodies.has(body.id));
    const retainedWire = developmentBodies.find((body) => body.id === profileWireId && body.type === "Wire");
    const sheet = developmentBodies.filter((body) => body.type === "Sheet");
    if (!retainedWire || sheet.length !== 1) throw new Error("Native Wire patch did not preserve one profile and create exactly one Sheet; inspect the partial result before continuing");
    const sheetBody = sheet[0]!;
    if (sheetBody.faces.length !== 1 || !sheetBody.faces[0]!.planar || sheetBody.faces[0]!.edgeIds.length !== 4) {
      throw new Error("Cone development Sheet is not one planar four-edge face; inspect the partial result before continuing");
    }
    const sheetEdges = sheetBody.edges.filter((edge) => sheetBody.faces[0]!.edgeIds.includes(edge.id));
    const circularLengths = sheetEdges.filter((edge) => edge.circle).map((edge) => edge.lengthMm).sort((first, second) => first - second);
    const lineLengths = sheetEdges.filter((edge) => edge.line).map((edge) => edge.lengthMm).sort((first, second) => first - second);
    const expectedCircularLengths = [
      analysis.development.innerRadiusMm * analysis.development.includedAngleRad,
      analysis.development.outerRadiusMm * analysis.development.includedAngleRad,
    ].sort((first, second) => first - second);
    if (sheetEdges.length !== 4 || circularLengths.length !== 2 || lineLengths.length !== 2 ||
        circularLengths.some((length, index) => Math.abs(length - expectedCircularLengths[index]!) > 0.01) ||
        lineLengths.some((length) => Math.abs(length - analysis.development.slantLengthMm) > 0.01)) {
      throw new Error("Cone development Sheet boundaries do not match the exact annular-sector profile; inspect the partial result before continuing");
    }

    const validation = await this.validateBodies([sheetBody.id], patched.revision);
    if (!validation.bodies[0]!.nativeValid) throw new Error("Cone development Sheet failed Plasticity native validation; inspect the result before continuing");
    const sheetProperties = await this.measureFaceProperties([{ bodyId: sheetBody.id, faceId: sheetBody.faces[0]!.id }], patched.revision);
    const sheetAreaMm2 = sheetProperties.faces[0]!.areaMm2;
    if (Math.abs(sheetAreaMm2 - expectedAreaMm2) > Math.max(0.01, expectedAreaMm2 * 1e-6)) {
      throw new Error("Developed Sheet area does not match the source conical face; inspect the result before continuing");
    }
    const finalState = await this.assertRevision(patched.revision);
    assertOriginalBodiesUnchanged(finalState);
    if (JSON.stringify(finalState.bodies.find((body) => body.id === sheetBody.id)) !== JSON.stringify(sheetBody)) {
      throw new Error("Development Sheet changed during validation; inspect the result before continuing");
    }

    return {
      documentToken: finalState.documentToken,
      revision: finalState.revision,
      measurementSource: "native-brep",
      sourceFace: face,
      profileWireId,
      sheetBodyId: sheetBody.id,
      originMm,
      boundaryRadiusMm: analysis.boundaryRadiusMm,
      development: analysis.development,
      sourceAreaMm2,
      sheetAreaMm2,
      sheetBoundaryLengthsMm: sheetEdges.map((edge) => edge.lengthMm).sort((first, second) => first - second),
      validation: validation.bodies[0]!,
      historySteps: finalState.undoDepth - initial.undoDepth,
    };
  }

  async deformBodiesBetweenFaces(
    ids: number[],
    sourceFace: FaceReference,
    targetFace: FaceReference,
    options: {
      scaleU: number;
      scaleV: number;
      scaleNormal: number;
      flipUV: boolean;
      flipNormal: boolean;
      mirror: boolean;
    },
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0 || new Set(ids).size !== ids.length) {
      throw new Error("Deformation body IDs must be a nonempty unique list");
    }
    const current = new Map(state.bodies.map((body) => [body.id, body]));
    const missing = ids.filter((id) => !current.has(id));
    if (missing.length > 0) throw new Error(`Unknown current deformation body IDs: ${missing.join(", ")}`);
    const invalid = ids.filter((id) => !["Solid", "Sheet"].includes(current.get(id)!.type));
    if (invalid.length > 0) throw new Error(`Face deformation requires current Solid or Sheet bodies: ${invalid.join(", ")}`);
    if (sourceFace.bodyId === targetFace.bodyId && sourceFace.faceId === targetFace.faceId) {
      throw new Error("Source and target deformation faces must be different");
    }
    requireTopologySelection(state, [sourceFace, targetFace], "face");
    const referenceBodyIds = new Set([sourceFace.bodyId, targetFace.bodyId]);
    const overlapping = ids.filter((id) => referenceBodyIds.has(id));
    if (overlapping.length > 0) {
      throw new Error(`Deformation bodies must be separate from source and target face bodies: ${overlapping.join(", ")}`);
    }
    for (const [name, value] of Object.entries({
      scaleU: options.scaleU,
      scaleV: options.scaleV,
      scaleNormal: options.scaleNormal,
    })) {
      if (!Number.isFinite(value) || value <= 0 || value > 1000) {
        throw new Error(`${name} must be positive and at most 1000`);
      }
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      ${findView}
      const findFace = ref => {
        const view = find(ref.bodyId);
        const index = view.high.faces.versionIds.indexOf(ref.faceId);
        if (index < 0) throw new Error('Stale or unknown face: ' + ref.faceId);
        return view.high.faces.get(index);
      };
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.faces = args.ids.flatMap(id => {
            const view = find(id);
            if (view.constructor.name !== 'Solid' && view.constructor.name !== 'Sheet') {
              throw new Error('Face deformation inputs must remain Solid or Sheet bodies');
            }
            return Array.from({ length: view.high.faces.length }, (_, index) => view.high.faces.get(index));
          });
          nativeApi.setDeformationFaces(factory, findFace(args.sourceFace), findFace(args.targetFace));
          factory.keepTools = true;
          factory.scaleU = args.options.scaleU;
          factory.scaleV = args.options.scaleV;
          factory.scaleNormal = args.options.scaleNormal;
          factory.flipUV = args.options.flipUV;
          factory.flipNormal = args.options.flipNormal;
          factory.mirror = args.options.mirror;
          factory.offsetU = 0;
          factory.offsetV = 0;
          factory.offsetNormal = 0;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["DeformFaceFactory", "DeformFaceCommand"], [{ ids, sourceFace, targetFace, options }]);
    return await this.state();
  }

  async deformCurvesBetweenFaces(
    ids: number[],
    sourceFace: FaceReference,
    targetFace: FaceReference,
    options: {
      scaleU: number;
      scaleV: number;
      scaleNormal: number;
      flipUV: boolean;
      flipNormal: boolean;
      mirror: boolean;
    },
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0 || new Set(ids).size !== ids.length) {
      throw new Error("Deformation curve IDs must be a nonempty unique list");
    }
    const current = new Map(state.bodies.map((body) => [body.id, body]));
    const missing = ids.filter((id) => !current.has(id));
    if (missing.length > 0) throw new Error(`Unknown current deformation curve IDs: ${missing.join(", ")}`);
    const invalid = ids.filter((id) => current.get(id)!.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve deformation requires current Wire bodies: ${invalid.join(", ")}`);
    if (sourceFace.bodyId === targetFace.bodyId && sourceFace.faceId === targetFace.faceId) {
      throw new Error("Source and target deformation faces must be different");
    }
    requireTopologySelection(state, [sourceFace, targetFace], "face");
    const referenceBodyIds = new Set([sourceFace.bodyId, targetFace.bodyId]);
    const overlapping = ids.filter((id) => referenceBodyIds.has(id));
    if (overlapping.length > 0) {
      throw new Error(`Deformation curves must be separate from source and target face bodies: ${overlapping.join(", ")}`);
    }
    for (const [name, value] of Object.entries({
      scaleU: options.scaleU,
      scaleV: options.scaleV,
      scaleNormal: options.scaleNormal,
    })) {
      if (!Number.isFinite(value) || value <= 0 || value > 1000) {
        throw new Error(`${name} must be positive and at most 1000`);
      }
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      ${findView}
      const findFace = ref => {
        const view = find(ref.bodyId);
        const index = view.high.faces.versionIds.indexOf(ref.faceId);
        if (index < 0) throw new Error('Stale or unknown face: ' + ref.faceId);
        return view.high.faces.get(index);
      };
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.curves = args.ids.map(id => {
            const view = find(id);
            if (view.constructor.name !== 'Wire') throw new Error('Curve deformation inputs must remain Wire bodies');
            return view;
          });
          nativeApi.setDeformationFaces(factory, findFace(args.sourceFace), findFace(args.targetFace));
          factory.keepTools = true;
          factory.scaleU = args.options.scaleU;
          factory.scaleV = args.options.scaleV;
          factory.scaleNormal = args.options.scaleNormal;
          factory.flipUV = args.options.flipUV;
          factory.flipNormal = args.options.flipNormal;
          factory.mirror = args.options.mirror;
          factory.offsetU = 0;
          factory.offsetV = 0;
          factory.offsetNormal = 0;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["DeformCurveFactory", "DeformCurveCommand"], [{ ids, sourceFace, targetFace, options }]);
    return await this.state();
  }

  async extractEdges(edges: Array<{ bodyId: number; edgeId: string }>, revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (edges.length === 0) throw new Error("At least one edge reference is required");
    const keys = edges.map((edge) => `${edge.bodyId}:${edge.edgeId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Edge references must be unique");
    const invalid = edges.filter((reference) =>
      !state.bodies.find((body) => body.id === reference.bodyId)?.edgeIds.includes(reference.edgeId));
    if (invalid.length > 0) {
      throw new Error(`Stale or unknown edges: ${invalid.map((edge) => `${edge.bodyId}:${edge.edgeId}`).join(", ")}`);
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("DuplicateEdgeAndProjectCommand")}
      factory.edges = args.edges.map(ref => {
        const view = find(ref.bodyId);
        const index = view.high.edges.versionIds.indexOf(ref.edgeId);
        if (index < 0) throw new Error('Stale or unknown edge: ' + ref.edgeId);
        return view.high.edges.get(index);
      });
      ${commandEnd}
    }`, ["CreateCurveFromEdgesFactory"], [{ edges }]);
    return await this.state();
  }

  async unjoinFaces(faces: Array<{ bodyId: number; faceId: string }>, revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (faces.length === 0) throw new Error("At least one face reference is required");
    const keys = faces.map((face) => `${face.bodyId}:${face.faceId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Face references must be unique");
    const invalid = faces.filter((reference) =>
      !state.bodies.find((body) => body.id === reference.bodyId)?.faceIds.includes(reference.faceId));
    if (invalid.length > 0) {
      throw new Error(`Stale or unknown faces: ${invalid.map((face) => `${face.bodyId}:${face.faceId}`).join(", ")}`);
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("UnjoinFacesCommand")}
      factory.faces = args.faces.map(ref => {
        const view = find(ref.bodyId);
        const index = view.high.faces.versionIds.indexOf(ref.faceId);
        if (index < 0) throw new Error('Stale or unknown face: ' + ref.faceId);
        return view.high.faces.get(index);
      });
      ${commandEnd}
    }`, ["UnjoinFacesFactory"], [{ faces }]);
    return await this.state();
  }

  async insertSheet(targetSheetId: number, edgeIds: string[], fillSheetId: number, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (targetSheetId === fillSheetId) throw new Error("Sheet insertion requires two different Sheet bodies");
    const target = state.bodies.find((body) => body.id === targetSheetId);
    const fill = state.bodies.find((body) => body.id === fillSheetId);
    if (target?.type !== "Sheet") throw new Error(`Sheet insertion requires a current target Sheet body: ${targetSheetId}`);
    if (fill?.type !== "Sheet") throw new Error(`Sheet insertion requires a current fill Sheet body: ${fillSheetId}`);
    if (edgeIds.length === 0) throw new Error("Sheet insertion requires at least one target boundary edge");
    const uniqueIds = [...new Set(edgeIds)];
    if (uniqueIds.length !== edgeIds.length) throw new Error("Sheet insertion edge IDs must be unique");
    const selected = uniqueIds.map((edgeId) => target.edges.find((edge) => edge.id === edgeId));
    const missing = uniqueIds.filter((_edgeId, index) => !selected[index]);
    if (missing.length > 0) throw new Error(`Stale or unknown target Sheet edges: ${missing.join(", ")}`);
    const nonBoundary = selected.filter((edge) => edge!.faceIds.length !== 1).map((edge) => edge!.id);
    if (nonBoundary.length > 0) throw new Error(`Sheet insertion requires target boundary edges: ${nonBoundary.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          const target = find(args.targetSheetId);
          const fill = find(args.fillSheetId);
          if (target.constructor.name !== 'Sheet' || fill.constructor.name !== 'Sheet') {
            throw new Error('Sheet insertion inputs must remain Sheet bodies');
          }
          factory.sheet = target;
          factory.edges = args.edgeIds.map(id => {
            const index = target.high.edges.versionIds.indexOf(id);
            if (index < 0) throw new Error('Stale or unknown target Sheet edge: ' + id);
            return target.high.edges.get(index);
          });
          factory.fillSheet = fill;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["InsertSheetFactory", "InsertSheetCommand"], [{ targetSheetId, edgeIds: uniqueIds, fillSheetId }]);
    return await this.state();
  }

  async unjoinShells(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0 || new Set(ids).size !== ids.length) {
      throw new Error("Shell body IDs must be a nonempty unique list");
    }
    const current = new Map(state.bodies.map((body) => [body.id, body]));
    const missing = ids.filter((id) => !current.has(id));
    if (missing.length > 0) throw new Error(`Unknown current body IDs: ${missing.join(", ")}`);
    const invalid = ids.filter((id) => !["Solid", "Sheet"].includes(current.get(id)!.type));
    if (invalid.length > 0) throw new Error(`Shell unjoin requires current Solid or Sheet bodies: ${invalid.join(", ")}`);
    const singleFace = ids.filter((id) => current.get(id)!.faceIds.length < 2);
    if (singleFace.length > 0) throw new Error(`Shell unjoin requires bodies with at least two faces: ${singleFace.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Factory, SheetFactory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.UnjoinShellsCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = nativeApi.createUnjoinFactory(Factory, SheetFactory, args.ids.map(find)).resource(this);
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["UnjoinShellsFactory", "CreateSheetFromFacesFactory"], [{ ids }]);
    return await this.state();
  }

  async createSolidFromSheet(id: number, revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (state.bodies.find((body) => body.id === id)?.type !== "Sheet") {
      throw new Error(`Solid creation requires a current Sheet body: ${id}`);
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("CreateSolidFromFacesCommand")}
      const view = find(args.id);
      if (view.constructor.name !== 'Sheet') throw new Error('Solid creation input must be a Sheet body');
      factory.shell = view;
      factory.faces = Array.from({ length: view.high.faces.length }, (_, index) => view.high.faces.get(index));
      ${commandEnd}
    }`, ["CreateSolidFromFacesFactory"], [{ id }]);
    return await this.state();
  }

  async deleteFaces(faces: Array<{ bodyId: number; faceId: string }>, revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (faces.length === 0) throw new Error("At least one face reference is required");
    const keys = faces.map((face) => `${face.bodyId}:${face.faceId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Face references must be unique");
    const invalid = faces.filter((reference) =>
      !state.bodies.find((body) => body.id === reference.bodyId)?.faceIds.includes(reference.faceId));
    if (invalid.length > 0) {
      throw new Error(`Stale or unknown faces: ${invalid.map((face) => `${face.bodyId}:${face.faceId}`).join(", ")}`);
    }
    await this.runtime.mutate(nativeFunction`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.faces = args.faces.map(ref => {
            const view = find(ref.bodyId);
            const index = view.high.faces.versionIds.indexOf(ref.faceId);
            if (index < 0) throw new Error('Stale or unknown face: ' + ref.faceId);
            return view.high.faces.get(index);
          });
          return await factory.commit();
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["DeleteFaceCommand", "DeleteFaceFactory"], [{ faces }]);
    return await this.state();
  }

  async dissolveFaces(faces: Array<{ bodyId: number; faceId: string }>, revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (faces.length === 0) throw new Error("At least one face reference is required");
    const keys = faces.map((face) => `${face.bodyId}:${face.faceId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Face references must be unique");
    const invalid = faces.filter((reference) =>
      !state.bodies.find((body) => body.id === reference.bodyId)?.faceIds.includes(reference.faceId));
    if (invalid.length > 0) {
      throw new Error(`Stale or unknown faces: ${invalid.map((face) => `${face.bodyId}:${face.faceId}`).join(", ")}`);
    }
    await this.runtime.mutate(nativeFunction`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.faces = args.faces.map(ref => {
            const view = find(ref.bodyId);
            const index = view.high.faces.versionIds.indexOf(ref.faceId);
            if (index < 0) throw new Error('Stale or unknown face: ' + ref.faceId);
            return view.high.faces.get(index);
          });
          return await factory.commit();
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["DissolveFaceCommand", "DissolveFaceFactory"], [{ faces }]);
    return await this.state();
  }

  async patchSheetHole(id: number, edgeIds: string[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    const sheet = state.bodies.find((body) => body.id === id);
    if (sheet?.type !== "Sheet") throw new Error(`Hole patch requires a current Sheet body: ${id}`);
    if (edgeIds.length < 3) throw new Error("Sheet-hole patch requires at least three boundary edges");
    const uniqueIds = [...new Set(edgeIds)];
    if (uniqueIds.length !== edgeIds.length) throw new Error("Sheet-hole edge IDs must be unique");
    const selected = uniqueIds.map((edgeId) => sheet.edges.find((edge) => edge.id === edgeId));
    const missing = uniqueIds.filter((_edgeId, index) => !selected[index]);
    if (missing.length > 0) throw new Error(`Stale or unknown Sheet edges: ${missing.join(", ")}`);
    const nonBoundary = selected.filter((edge) => edge!.faceIds.length !== 1).map((edge) => edge!.id);
    if (nonBoundary.length > 0) throw new Error(`Hole patch requires boundary edges: ${nonBoundary.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("PatchCommand")}
      const view = find(args.id);
      if (view.constructor.name !== 'Sheet') throw new Error('Hole patch input must be a Sheet body');
      factory.sheet = view;
      factory.edges = args.edgeIds.map(id => {
        const index = view.high.edges.versionIds.indexOf(id);
        if (index < 0) throw new Error('Stale or unknown Sheet edge: ' + id);
        return view.high.edges.get(index);
      });
      ${commandEnd}
    }`, ["PatchHoleInSheetFactory"], [{ id, edgeIds: uniqueIds }]);
    return await this.state();
  }

  async capSheetHoles(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (ids.length === 0) throw new Error("At least one Sheet ID is required");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Sheet IDs must be unique");
    const invalid = uniqueIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Sheet");
    if (invalid.length > 0) throw new Error(`Hole capping requires current Sheet bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.sheets = args.ids.map(find);
          return await factory.commit();
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["PatchHolesInSheetCommand", "CapHolesInSheetFactory"], [{ ids: uniqueIds }]);
    return await this.state();
  }

  async extendSheetEdges(
    id: number,
    edgeIds: string[],
    distanceMm: number | undefined,
    revision: string,
    options: { shape?: SheetExtensionShape | undefined; targetId?: number | undefined; merge?: boolean | undefined } = {},
  ): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    const sheet = state.bodies.find((body) => body.id === id);
    if (sheet?.type !== "Sheet") throw new Error(`Sheet extension requires a current Sheet body: ${id}`);
    if (edgeIds.length === 0) throw new Error("Sheet extension requires at least one boundary edge");
    const uniqueIds = [...new Set(edgeIds)];
    if (uniqueIds.length !== edgeIds.length) throw new Error("Sheet extension edge IDs must be unique");
    if (distanceMm !== undefined && options.targetId !== undefined) {
      throw new Error("Sheet extension takes either a distance or a target body, not both");
    }
    if (distanceMm === undefined && options.targetId === undefined) {
      throw new Error("Sheet extension requires a distance or a target body");
    }
    if (distanceMm !== undefined && (!Number.isFinite(distanceMm) || distanceMm <= 0)) throw new Error("Sheet extension distance must be positive");
    if (options.shape !== undefined && !(options.shape in SHEET_EXTENSION_SHAPES)) {
      throw new Error(`Sheet extension shape must be one of: ${Object.keys(SHEET_EXTENSION_SHAPES).join(", ")}`);
    }
    if (options.targetId !== undefined) {
      const target = state.bodies.find((body) => body.id === options.targetId);
      if (!target || (target.type !== "Solid" && target.type !== "Sheet") || target.id === id) {
        throw new Error(`Sheet extension target must be a different current Solid or Sheet body: ${options.targetId}`);
      }
    }
    const selected = uniqueIds.map((edgeId) => sheet.edges.find((edge) => edge.id === edgeId));
    const missing = uniqueIds.filter((_edgeId, index) => !selected[index]);
    if (missing.length > 0) throw new Error(`Stale or unknown Sheet edges: ${missing.join(", ")}`);
    const nonBoundary = selected.filter((edge) => edge!.faceIds.length !== 1).map((edge) => edge!.id);
    if (nonBoundary.length > 0) throw new Error(`Sheet extension requires boundary edges: ${nonBoundary.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Factory, ExtensionShape, BodyExtensionType, ExtensionLimit, args) {
      ${findView}
      ${enumMember}
      ${commandStart("ExtendSheetCommand")}
      const view = find(args.id);
      if (view.constructor.name !== 'Sheet') throw new Error('Sheet extension input must be a Sheet body');
      factory.edges = args.edgeIds.map(id => {
        const index = view.high.edges.versionIds.indexOf(id);
        if (index < 0) throw new Error('Stale or unknown Sheet edge: ' + id);
        return view.high.edges.get(index);
      });
      if (args.distance !== undefined) factory.distance = args.distance;
      enumMember(ExtensionShape, 'ExtensionShape', 'Linear');
      enumMember(BodyExtensionType, 'BodyExtensionType', 'Distance');
      enumMember(ExtensionLimit, 'ExtensionLimit', 'Minimal');
      factory.shape = ExtensionShape.Linear;
      factory.type = BodyExtensionType.Distance;
      factory.limit = ExtensionLimit.Minimal;
      factory.modify = true;
      if (args.shapeName !== undefined) factory.shape = enumMember(ExtensionShape, 'ExtensionShape', args.shapeName);
      if (args.targetId !== undefined) {
        factory.type = enumMember(BodyExtensionType, 'BodyExtensionType', 'Target');
        factory.target = find(args.targetId);
      }
      if (args.merge !== undefined) factory.modify = args.merge;
      ${commandEnd}
    }`, ["ExtendSheetFactory", "ExtensionShape", "BodyExtensionType", "ExtensionLimit"], [{
      id,
      edgeIds: uniqueIds,
      ...(distanceMm !== undefined ? { distance: millimetersToMeters(distanceMm) } : {}),
      ...(options.shape !== undefined ? { shapeName: SHEET_EXTENSION_SHAPES[options.shape] } : {}),
      ...(options.targetId !== undefined ? { targetId: options.targetId } : {}),
      ...(options.merge !== undefined ? { merge: options.merge } : {}),
    }]);
    return await this.state();
  }

  async validateBodies(ids: number[], revision: string): Promise<{
    documentToken: string;
    revision: string;
    measurementSource: "native-brep";
    bodies: BodyValidationDescriptor[];
  }> {
    const before = await this.state();
    if (before.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${before.revision}`);
    }
    if (ids.length === 0) throw new Error("At least one body ID is required");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Body IDs must be unique");
    const bodies = uniqueIds.map((id) => before.bodies.find((body) => body.id === id));
    const missing = uniqueIds.filter((_id, index) => !bodies[index]);
    if (missing.length > 0) throw new Error(`Unknown body IDs: ${missing.join(", ")}`);

    const nativeChecks = await this.runtime.readNative<Array<{ id: number; nativeCheckCodes: number[] }>>(nativeFunction`function (args) {
      const wanted = new Set(args.ids);
      const result = [];
      for (const [versionId, item] of nativeApi.geo.geometryModel) {
        const id = nativeApi.db.lookupStableId(versionId);
        if (!wanted.has(id)) continue;
        const model = item.model;
        if (!model || typeof model.Check !== 'function') throw new Error('Native Check is unavailable for body ID: ' + id);
        result.push({ id, nativeCheckCodes: Array.from(model.Check(), Number) });
      }
      return result;
    }`, [], [{ ids: uniqueIds }]);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while bodies were being validated");
    }
    const checksById = new Map(nativeChecks.map((entry) => [entry.id, entry.nativeCheckCodes]));
    const unread = uniqueIds.filter((id) => !checksById.has(id));
    if (unread.length > 0) throw new Error(`Native validation did not return body IDs: ${unread.join(", ")}`);

    return {
      documentToken: after.documentToken,
      revision: after.revision,
      measurementSource: "native-brep",
      bodies: bodies.map((body) => {
        const current = body!;
        const nativeCheckCodes = checksById.get(current.id)!;
        const nativeValid = nativeCheckCodes.length === 0;
        // A periodic Solid face may expose its seam edge once through GetFaces(),
        // although the Parasolid body is closed. Trust the native Solid type plus
        // Check() for closure; retain the adjacency heuristic for open Sheets.
        const boundaryEdgeIds = current.type === "Solid"
          ? []
          : current.edges.filter((edge) => edge.faceIds.length === 1).map((edge) => edge.id);
        const closed = current.type === "Solid" ? nativeValid : current.type !== "Wire" && boundaryEdgeIds.length === 0;
        return {
          id: current.id,
          versionId: current.versionId,
          type: current.type,
          name: current.name,
          measurementSource: "native-brep",
          faceCount: current.faces.length,
          edgeCount: current.edges.length,
          boundaryEdgeIds,
          closed,
          nativeCheckCodes,
          nativeValid,
          printableSolid: current.type === "Solid" && closed && nativeValid,
        };
      }),
    };
  }

  async createPipes(spineIds: number[], diameterMm: number, wallThicknessMm: number, revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (spineIds.length === 0) throw new Error("At least one Wire spine ID is required");
    const uniqueIds = [...new Set(spineIds)];
    if (uniqueIds.length !== spineIds.length) throw new Error("Wire spine IDs must be unique");
    if (!Number.isFinite(diameterMm) || diameterMm <= 0) throw new Error("Pipe diameter must be positive");
    if (!Number.isFinite(wallThicknessMm) || wallThicknessMm < 0) throw new Error("Pipe wall thickness must be nonnegative");
    const invalid = uniqueIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Pipe requires current Wire spines: ${invalid.join(", ")}`);
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("PipeCommand")}
      const spines = args.spineIds.map(id => {
        const spine = find(id);
        if (spine.constructor.name !== 'Wire') throw new Error('Pipe inputs must be Wire bodies');
        return spine;
      });
      factory.spines = spines;
      factory.diameter = args.diameter;
      factory.thickness = args.thickness;
      ${commandEnd}
    }`, ["PipeFactory"], [{
      spineIds: uniqueIds,
      diameter: millimetersToMeters(diameterMm),
      thickness: millimetersToMeters(wallThicknessMm),
    }]);
    return await this.state();
  }

  async revolveProfile(
    id: number,
    axisOriginMm: Vector3,
    axis: Vector3,
    angleDegrees: number,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("RevolveCommand")}
      const view = find(args.id);
      if (view.constructor.name !== 'Wire') throw new Error('Profile must be a Wire');
      factory.curves = [view];
      factory.origin.fromArray(args.axisOrigin);
      factory.axis.fromArray(args.axis).normalize();
      factory.degrees = args.angleDegrees;
      ${commandEnd}
    }`, ["RevolveFactory"], [{
      id,
      axisOrigin: toMeters(axisOriginMm),
      axis,
      angleDegrees,
    }]);
    return await this.state();
  }

  async thickenSheets(
    ids: number[],
    frontMm: number,
    backMm: number,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("ThickenSheetCommand")}
      const sheets = args.ids.map(find);
      for (const view of sheets) {
        if (view.constructor.name !== 'Sheet') throw new Error('Thicken inputs must be Sheets');
      }
      factory.sheets = sheets;
      factory.front = args.front;
      factory.back = args.back;
      ${commandEnd}
    }`, ["ThickenSheetFactory"], [{
      ids,
      front: millimetersToMeters(frontMm),
      back: millimetersToMeters(backMm),
    }]);
    return await this.state();
  }

  async draftFaces(
    id: number,
    faceIds: string[],
    referenceFace: { bodyId: number; faceId: string },
    angleDegrees: number,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (referenceFace.bodyId === id && faceIds.includes(referenceFace.faceId)) {
      throw new Error("Draft faces must not include the neutral reference face");
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("DraftFaceCommand")}
      const view = find(args.id);
      const faces = view.high.faces;
      factory.faces = args.faceIds.map(id => {
        const index = faces.versionIds.indexOf(id);
        if (index < 0) throw new Error('Stale or unknown draft face: ' + id);
        return faces.get(index);
      });
      const referenceView = find(args.referenceFace.bodyId);
      const referenceFaces = referenceView.high.faces;
      const referenceIndex = referenceFaces.versionIds.indexOf(args.referenceFace.faceId);
      if (referenceIndex < 0) throw new Error('Stale or unknown neutral reference face: ' + args.referenceFace.faceId);
      factory.reference = referenceFaces.get(referenceIndex);
      factory.degrees = args.angleDegrees;
      ${commandEnd}
    }`, ["DraftFaceFactory"], [{ id, faceIds, referenceFace, angleDegrees }]);
    return await this.state();
  }

  async offsetFaces(id: number, faceIds: string[], distanceMm: number, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("OffsetFaceCommand")}
      const view = find(args.id);
      const faces = view.high.faces;
      factory.faces = args.faceIds.map(id => {
        const index = faces.versionIds.indexOf(id);
        if (index < 0) throw new Error('Stale or unknown face: ' + id);
        return faces.get(index);
      });
      factory.distance = args.distance;
      ${commandEnd}
    }`, ["OffsetFaceFactory"], [{ id, faceIds, distance: millimetersToMeters(distanceMm) }]);
    return await this.state();
  }

  async moveFaces(references: FaceReference[], deltaMm: Vector3, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "face");
    if (deltaMm.some((value) => !Number.isFinite(value)) || Math.hypot(...deltaMm) === 0) {
      throw new Error("Face move delta must be a finite nonzero vector");
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findFaceViews}
      ${commandStart("MoveFaceCommand")}
      factory.faces = selectedFaces;
      factory.move.fromArray(args.delta);
      ${commandEnd}
    }`, ["MultiMoveFaceFactory"], [{ faces: references, delta: toMeters(deltaMm) }]);
    return await this.state();
  }

  async rotateFaces(
    references: FaceReference[],
    pivotMm: Vector3,
    axis: Vector3,
    degrees: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "face");
    if (pivotMm.some((value) => !Number.isFinite(value))) throw new Error("Face rotation pivot must be finite");
    if (!Number.isFinite(degrees) || degrees === 0) throw new Error("Face rotation angle must be finite and nonzero");
    const unitAxis = normalize(axis, "Face rotation axis");
    await this.runtime.mutate(nativeFunction`async function (Factory, Vector, Quaternion, args) {
      ${findFaceViews}
      ${commandStart("RotateFaceCommand")}
      factory.faces = selectedFaces;
      factory.pivot.fromArray(args.pivot);
      factory.rotation.copy(new Quaternion().setFromAxisAngle(new Vector(...args.axis), args.radians));
      ${commandEnd}
    }`, ["MultiRotateFaceFactory", "Vector3", "Quaternion"], [{
      faces: references,
      pivot: toMeters(pivotMm),
      axis: unitAxis,
      radians: degreesToRadians(degrees),
    }]);
    return await this.state();
  }

  async scaleFaces(
    references: FaceReference[],
    pivotMm: Vector3,
    factors: Vector3,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "face");
    if (pivotMm.some((value) => !Number.isFinite(value))) throw new Error("Face scale pivot must be finite");
    if (factors.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error("Face scale factors must be finite and positive");
    }
    if (factors.every((value) => value === 1)) throw new Error("Face scale must change at least one factor");
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findFaceViews}
      ${commandStart("ScaleFaceCommand")}
      factory.faces = selectedFaces;
      factory.pivot.fromArray(args.pivot);
      factory.scale.fromArray(args.factors);
      ${commandEnd}
    }`, ["MultiPlanarizingBasicScaleFaceFactory"], [{ faces: references, pivot: toMeters(pivotMm), factors }]);
    return await this.state();
  }

  async thickenFaces(
    references: FaceReference[],
    frontMm: number,
    backMm: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "face");
    requireSingleTopologyBody(references, "Thickened faces");
    const body = state.bodies.find((candidate) => candidate.id === references[0]!.bodyId)!;
    if (body.type !== "Solid" && body.type !== "Sheet") throw new Error("Native face thickening requires a Solid or Sheet body");
    if (!Number.isFinite(frontMm) || frontMm < 0 || !Number.isFinite(backMm) || backMm < 0) {
      throw new Error("Face-thickening front and back distances must be finite and nonnegative");
    }
    if (frontMm === 0 && backMm === 0) throw new Error("Face thickening requires a positive front or back distance");
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      ${findFaceViews}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.faces = selectedFaces;
          factory.front = args.front;
          factory.back = args.back;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["ThickenFaceFactory", "ThickenFaceCommand"], [{
      faces: references,
      front: millimetersToMeters(frontMm),
      back: millimetersToMeters(backMm),
    }]);
    return await this.state();
  }

  async offsetFaceLoops(
    references: FaceReference[],
    distanceMm: number,
    individual: boolean,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "face");
    requireSingleTopologyBody(references, "Offset face loops");
    const body = state.bodies.find((candidate) => candidate.id === references[0]!.bodyId)!;
    if (body.type !== "Solid" && body.type !== "Sheet") throw new Error("Native face-loop offset requires a Solid or Sheet body");
    if (!Number.isFinite(distanceMm) || distanceMm === 0) throw new Error("Face-loop offset distance must be finite and nonzero");
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      ${findFaceViews}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.faces = selectedFaces;
          factory.distance = args.distance;
          factory.isIndividual = args.individual;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["OffsetFaceLoopFactory", "OffsetFaceLoopCommand"], [{
      faces: references,
      distance: millimetersToMeters(distanceMm),
      individual,
    }]);
    return await this.state();
  }

  async patchSolidEdgeLoops(references: EdgeReference[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "edge");
    requireSingleTopologyBody(references, "Patched Solid edge loops");
    const body = state.bodies.find((candidate) => candidate.id === references[0]!.bodyId)!;
    if (body.type !== "Solid") throw new Error("Native Solid edge-loop patching requires a Solid body");
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      ${findEdgeViews}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.edges = selectedEdges;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["PatchHoleInSolidFactory", "PatchHoleInSolidCommand"], [{ edges: references }]);
    return await this.state();
  }

  async moveEdges(references: EdgeReference[], deltaMm: Vector3, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "edge");
    requireSingleTopologyBody(references, "Moved edges");
    if (deltaMm.some((value) => !Number.isFinite(value)) || Math.hypot(...deltaMm) === 0) {
      throw new Error("Edge move delta must be a finite nonzero vector");
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      ${findEdgeViews}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.shell = view;
          factory.edges = selectedEdges;
          factory.move.fromArray(args.delta);
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["MoveEdgeFactory", "MoveEdgeCommand"], [{ edges: references, delta: toMeters(deltaMm) }]);
    return await this.state();
  }

  async offsetEdges(references: EdgeReference[], distanceMm: number, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "edge");
    requireSingleTopologyBody(references, "Offset edges");
    if (!Number.isFinite(distanceMm) || distanceMm === 0) throw new Error("Edge offset distance must be finite and nonzero");
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      ${findEdgeViews}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.shell = view;
          factory.edges = selectedEdges;
          factory.distance = args.distance;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["OffsetEdgeFactory", "OffsetEdgeCommand"], [{ edges: references, distance: millimetersToMeters(distanceMm) }]);
    return await this.state();
  }

  async deleteEdges(references: EdgeReference[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "edge");
    requireSingleTopologyBody(references, "Deleted edges");
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      ${findEdgeViews}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.shell = view;
          factory.edges = selectedEdges;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["DeleteEdgeFactory", "DeleteEdgeCommand"], [{ edges: references }]);
    return await this.state();
  }

  async offsetVertices(references: VertexReference[], distanceMm: number, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (references.length === 0) throw new Error("At least one shell vertex reference is required");
    const keys = references.map(({ bodyId, vertexId }) => `${bodyId}:${vertexId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Shell vertex references must be unique");
    if (new Set(references.map(({ bodyId }) => bodyId)).size !== 1) {
      throw new Error("Offset shell vertices must belong to one body");
    }
    for (const [index, reference] of references.entries()) requireVertexReference(state, reference, `vertices[${index}]`);
    const body = state.bodies.find((candidate) => candidate.id === references[0]!.bodyId)!;
    if (body.type !== "Solid" && body.type !== "Sheet") {
      throw new Error("Native shell-vertex offset requires a Solid or Sheet body");
    }
    if (!Number.isFinite(distanceMm) || distanceMm <= 0) {
      throw new Error("Shell-vertex offset distance must be finite and positive");
    }
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, pk_default, args) {
      const wanted = new Set(args.vertices.map(reference => reference.bodyId + ':' + reference.vertexId));
      const selectedByKey = new Map();
      for (const entry of nativeApi.pointSnapEntries()) {
        for (let index = 0; index < (entry.positions?.length ?? 0) / 3; index += 1) {
          const snap = entry.lookup(index);
          if (!['Snaps_ShellVertexSnap', 'ShellVertexSnap'].includes(snap?.constructor?.name)) continue;
          const bodyId = nativeApi.db.lookupStableId(snap.item?.versionId);
          const vertexId = snap.model?.Id?.();
          const key = bodyId + ':' + vertexId;
          if (wanted.has(key)) selectedByKey.set(key, snap);
        }
      }
      const missing = Array.from(wanted).filter(key => !selectedByKey.has(key));
      if (missing.length > 0) throw new Error('Stale or unavailable shell vertices: ' + missing.join(', '));
      const selectedSnaps = args.vertices.map(reference => selectedByKey.get(reference.bodyId + ':' + reference.vertexId));
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          nativeApi.configureOffsetVertices(factory, selectedSnaps, pk_default.a);
          factory.distance = args.distance;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["OffsetVertexFactory", "OffsetVertexCommand", "pk_default"], [{ vertices: references, distance: millimetersToMeters(distanceMm) }]);
    return await this.state();
  }

  async rectangularFacePattern(
    references: FaceReference[],
    direction1: Vector3,
    count1: number,
    spacing1Mm: number,
    direction2: Vector3,
    count2: number,
    spacing2Mm: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "face");
    requireSingleTopologyBody(references, "Patterned faces");
    const body = state.bodies.find((candidate) => candidate.id === references[0]!.bodyId)!;
    if (body.type !== "Solid" && body.type !== "Sheet") throw new Error("Native face patterns require a Solid or Sheet body");
    const unitDirection1 = normalize(direction1, "Rectangular face pattern direction1");
    const unitDirection2 = normalize(direction2, "Rectangular face pattern direction2");
    if (!Number.isInteger(count1) || count1 < 2 || count1 > 1000) throw new Error("Rectangular face pattern count1 must be an integer between 2 and 1000");
    if (!Number.isInteger(count2) || count2 < 1 || count2 > 1000) throw new Error("Rectangular face pattern count2 must be an integer between 1 and 1000");
    if (!Number.isFinite(spacing1Mm) || spacing1Mm <= 0) throw new Error("Rectangular face pattern spacing1 must be positive");
    if (!Number.isFinite(spacing2Mm) || spacing2Mm < 0 || (count2 > 1 && spacing2Mm === 0)) throw new Error("Rectangular face pattern spacing2 must be positive when count2 is greater than one");
    if (count2 > 1 && nearlyParallel(unitDirection1, unitDirection2)) throw new Error("Rectangular face pattern directions must not be parallel");
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, Vector, args) {
      ${findFaceViews}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const view = find(args.faces[0].bodyId);
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.shell = view;
          factory.faces = selectedFaces;
          factory.dir1 = new Vector(...args.direction1);
          factory.dir2 = new Vector(...args.direction2);
          factory.mode = 'spacing';
          factory.num1 = args.count1;
          factory.num2 = args.count2;
          factory.distance1 = args.spacing1;
          factory.distance2 = args.spacing2;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["RectangularArrayFacesFactory", "RectangularArrayFacesCommand", "Vector3"], [{
      faces: references,
      direction1: unitDirection1,
      count1,
      spacing1: millimetersToMeters(spacing1Mm),
      direction2: unitDirection2,
      count2,
      spacing2: millimetersToMeters(spacing2Mm),
    }]);
    return await this.state();
  }

  async radialFacePattern(
    references: FaceReference[],
    centerMm: Vector3,
    axis: Vector3,
    count: number,
    sweepDegrees: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "face");
    requireSingleTopologyBody(references, "Patterned faces");
    const body = state.bodies.find((candidate) => candidate.id === references[0]!.bodyId)!;
    if (body.type !== "Solid" && body.type !== "Sheet") throw new Error("Native face patterns require a Solid or Sheet body");
    if (centerMm.some((value) => !Number.isFinite(value))) throw new Error("Radial face pattern center must be finite");
    const unitAxis = normalize(axis, "Radial face pattern axis");
    if (!Number.isInteger(count) || count < 2 || count > 1000) throw new Error("Radial face pattern count must be an integer between 2 and 1000");
    if (!Number.isFinite(sweepDegrees) || sweepDegrees <= 0 || sweepDegrees > 360) throw new Error("Radial face pattern sweep must be greater than zero and at most 360 degrees");
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, Vector, args) {
      ${findFaceViews}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const view = find(args.faces[0].bodyId);
      const axis = new Vector(...args.axis);
      const reference = Math.abs(axis.z) < 0.9 ? new Vector(0, 0, 1) : new Vector(0, 1, 0);
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.shell = view;
          factory.faces = selectedFaces;
          factory.center = new Vector(...args.center);
          factory.dir1 = reference.cross(axis).normalize();
          factory.dir2 = axis;
          factory.mode = 'total';
          factory.num1 = 1;
          factory.num2 = args.count;
          factory.angle = args.radians;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["RadialArrayFacesFactory", "RadialArrayFacesCommand", "Vector3"], [{
      faces: references,
      center: toMeters(centerMm),
      axis: unitAxis,
      count,
      radians: degreesToRadians(sweepDegrees),
    }]);
    return await this.state();
  }

  async hollowFaces(
    id: number,
    faceIds: string[],
    wallThicknessMm: number,
    direction: "inward" | "outward",
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    const signedThickness = direction === "inward" ? -wallThicknessMm : wallThicknessMm;
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("HollowFacesCommand")}
      const view = find(args.id);
      const faces = view.high.faces;
      factory.faces = args.faceIds.map(id => {
        const index = faces.versionIds.indexOf(id);
        if (index < 0) throw new Error('Stale or unknown face: ' + id);
        return faces.get(index);
      });
      factory.thickness = args.thickness;
      ${commandEnd}
    }`, ["HollowFacesFactory"], [{ id, faceIds, thickness: millimetersToMeters(signedThickness) }]);
    return await this.state();
  }

  async hollowSolids(
    ids: number[],
    wallThicknessMm: number,
    direction: "inward" | "outward",
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one Solid is required for closed hollowing");
    if (new Set(ids).size !== ids.length) throw new Error("Closed-hollow Solid IDs must be unique");
    if (!Number.isFinite(wallThicknessMm) || wallThicknessMm <= 0) {
      throw new Error("Closed-hollow wall thickness must be positive");
    }
    if (direction !== "inward" && direction !== "outward") {
      throw new Error(`Unsupported closed-hollow direction: ${String(direction)}`);
    }
    const currentSolids = new Set(state.bodies.filter((body) => body.type === "Solid").map((body) => body.id));
    const invalid = ids.filter((id) => !currentSolids.has(id));
    if (invalid.length > 0) throw new Error(`Closed hollowing requires current Solids: ${invalid.join(", ")}`);
    const signedThickness = direction === "inward" ? -wallThicknessMm : wallThicknessMm;
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("HollowSolidsCommand")}
      const solids = args.ids.map(find);
      for (const view of solids) {
        if (view.constructor.name !== 'Solid') throw new Error('Closed hollowing inputs must be Solids');
      }
      factory.solids = solids;
      factory.thickness = args.thickness;
      factory.local = false;
      ${commandEnd}
    }`, ["HollowSolidsFactory"], [{ ids, thickness: millimetersToMeters(signedThickness) }]);
    return await this.state();
  }

  async mirror(
    ids: number[],
    planeOriginMm: Vector3,
    planeNormal: Vector3,
    keepOriginal: boolean,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (new Set(ids).size !== ids.length) throw new Error("Mirror body IDs must be unique");
    await this.runtime.mutate(nativeFunction`async function (Factory, args) {
      ${findView}
      ${commandStart("MirrorCommand")}
      const originals = args.ids.map(find);
      const beforeIds = new Set(Array.from(nativeApi.geo.geometryModel.keys(), versionId => nativeApi.db.lookupStableId(versionId)));
      factory.shells = originals;
      factory.origin.fromArray(args.origin);
      factory.normal.fromArray(args.normal);
      // Native move is a mirror-offset distance, not a copy/replace flag.
      factory.move = 0;
      // MirrorFactory defaults to shouldCut = true (Plasticity's symmetry mode, which may trim sources that cross
      // the plane). This tool is a plain mirror, so it never cuts or unions.
      factory.shouldCut = false;
      factory.shouldUnion = false;
      const result = await factory.commit();
      if (!args.keepOriginal) {
        const reflected = Array.from(nativeApi.geo.geometryModel).filter(([versionId, item]) => {
          const id = nativeApi.db.lookupStableId(versionId);
          return Number.isInteger(id) && !beforeIds.has(id)
            && originals.some(original => original.constructor.name === item.view?.constructor?.name);
        });
        if (reflected.length !== originals.length) throw new Error('Mirror did not create one reflected body per source; originals were not deleted');
        const transaction = nativeApi.db.makeTransaction();
        for (const original of originals) transaction.delete(original);
        await nativeApi.db.commit(transaction);
      }
      return result;
    } catch (error) { failure = error; throw error; }
    };
    await this.exec(command);
    if (failure) throw failure;
    }`, ["MirrorFactory"], [{ ids, origin: toMeters(planeOriginMm), normal: planeNormal, keepOriginal }]);
    return await this.state();
  }

  async rectangularPattern(
    ids: number[],
    direction1: Vector3,
    count1: number,
    spacing1Mm: number,
    direction2: Vector3,
    count2: number,
    spacing2Mm: number,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (count2 > 1 && nearlyParallel(direction1, direction2)) throw new Error("Rectangular pattern directions must not be parallel");
    await this.runtime.mutate(nativeFunction`async function (Factory, Vector, args) {
      ${findView}
      ${commandStart("RectangularArrayCommand")}
      factory.items = args.ids.map(find);
      factory.dir1 = new Vector(...args.direction1).normalize();
      factory.dir2 = new Vector(...args.direction2).normalize();
      factory.mode = 'spacing';
      factory.num1 = args.count1;
      factory.num2 = args.count2;
      factory.distance1 = args.spacing1;
      factory.distance2 = args.spacing2;
      ${commandEnd}
    }`, ["RectangularArrayFactory", "Vector3"], [{
      ids,
      direction1,
      count1,
      spacing1: millimetersToMeters(spacing1Mm),
      direction2,
      count2,
      spacing2: millimetersToMeters(spacing2Mm),
    }]);
    return await this.state();
  }

  async radialPattern(
    ids: number[],
    centerMm: Vector3,
    axis: Vector3,
    count: number,
    sweepDegrees: number,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(nativeFunction`async function (Factory, Vector, args) {
      ${findView}
      ${commandStart("RadialArrayCommand")}
      const axis = new Vector(...args.axis).normalize();
      const reference = Math.abs(axis.z) < 0.9 ? new Vector(0, 0, 1) : new Vector(0, 1, 0);
      factory.items = args.ids.map(find);
      factory.center = new Vector(...args.center);
      factory.dir1 = reference.cross(axis).normalize();
      factory.dir2 = axis;
      factory.mode = 'total';
      factory.num1 = 1;
      factory.num2 = args.count;
      factory.angle = args.radians;
      ${commandEnd}
    }`, ["RadialArrayFactory", "Vector3"], [{
      ids,
      center: toMeters(centerMm),
      axis,
      count,
      radians: degreesToRadians(sweepDegrees),
    }]);
    return await this.state();
  }

  async rename(id: number, name: string, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(nativeFunction`async function (args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const view = find(args.id);
      this.selection.selected.removeAll();
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try { nativeApi.db.nodes.setName(nativeApi.db.nodes.item2key(view), args.name); }
        catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, [], [{ id, name }]);
    return await this.state();
  }

  async remove(ids: number[], revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(nativeFunction`async function (args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      this.selection.selected.removeAll();
      for (const view of args.ids.map(find)) this.selection.selected.add(view);
      const command = new this.commands.DeleteCommand(this);
      command.remember = false;
      let failure;
      const execute = command.execute.bind(command);
      command.execute = async function () {
        try { return await execute(); }
        catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, [], [{ ids }]);
    return await this.state();
  }

  // Plasticity's undo()/redo() promise can stay pending after the history step has already been
  // applied (seen live, with the window focused or hidden). Treat the step as done once the stack
  // shrinks and the executor is idle, instead of waiting on the promise.
  private async stepHistory(direction: "undo" | "redo"): Promise<void> {
    await this.runtime.mutate(`async function (args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const stack = () => args.direction === 'undo' ? this.history.undoStack : this.history.redoStack;
      const before = stack().length;
      if (before === 0) return 'empty';
      let settled = false;
      let failure = null;
      this[args.direction]().then(() => { settled = true; }, (error) => { failure = error; });
      const deadline = Date.now() + args.timeoutMs;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        if (settled) return 'resolved';
        if (stack().length < before && !this.executor.isBusy) return 'applied';
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error(args.direction + ' did not complete within ' + args.timeoutMs + ' ms');
    }`, [], [{ direction, timeoutMs: 10_000 }]);
  }

  async undo(revision?: string): Promise<RuntimeState> {
    if (revision) await this.assertRevision(revision);
    await this.stepHistory("undo");
    return await this.state();
  }

  async redo(revision?: string): Promise<RuntimeState> {
    if (revision) await this.assertRevision(revision);
    await this.stepHistory("redo");
    return await this.state();
  }

  async exportStep(ids: number[], outputPath: string, revision?: string): Promise<{ path: string; bytes: number }> {
    if (revision) await this.assertRevision(revision);
    const output = resolve(outputPath);
    if (![".step", ".stp"].includes(extname(output).toLowerCase())) throw new Error("STEP output must end in .step or .stp");
    await assertAbsent(output);
    await mkdir(dirname(output), { recursive: true });
    const staging = await mkdtemp(join(dirname(output), ".plasticity-step-"));
    const temporary = join(staging, "geometry.step");
    try {
      await this.runtime.mutate(nativeFunction`async function (Factory, args) {
        ${findView}
        if (this.executor.isBusy) throw new Error('Plasticity is busy');
        const factory = new Factory(this);
        factory.items = args.ids.map(find);
        factory.filePath = args.path;
        await factory.commit();
      }`, ["ExportCadFactory"], [{ ids, path: temporary }]);
      await sanitizeCadExport(temporary, staging, "step", basename(output));
      const text = await readFile(temporary, "utf8");
      if (!text.startsWith("ISO-10303-21;") || !text.includes("END-ISO-10303-21;")) throw new Error("Plasticity produced an invalid STEP file");
      await copyFile(temporary, output, constants.COPYFILE_EXCL);
      return { path: output, bytes: (await stat(output)).size };
    } finally {
      if (!this.runtime.isUncertain()) {
        await rm(temporary, { force: true }).catch(() => undefined);
        await rmdir(staging).catch(() => undefined);
      }
    }
  }

  async exportParasolid(
    ids: number[],
    outputPath: string,
    revision: string,
  ): Promise<{ path: string; bytes: number; format: "parasolid-text" | "parasolid-binary" }> {
    const state = await this.assertRevision(revision);
    requireCadExportBodies(state, ids, "Parasolid");
    const output = resolve(outputPath);
    const extension = extname(output).toLowerCase();
    if (extension !== ".x_t" && extension !== ".x_b") throw new Error("Parasolid output must end in .x_t or .x_b");
    await assertAbsent(output);
    await mkdir(dirname(output), { recursive: true });
    const staging = await mkdtemp(join(dirname(output), ".plasticity-parasolid-"));
    const temporary = join(staging, `geometry${extension}`);
    try {
      await this.runtime.mutate(nativeFunction`async function (Factory, args) {
        ${findView}
        if (this.executor.isBusy) throw new Error('Plasticity is busy');
        const factory = new Factory(this);
        factory.items = args.ids.map(find);
        factory.filePath = args.path;
        await factory.commit();
      }`, ["ExportCadFactory"], [{ ids, path: temporary }]);
      await sanitizeCadExport(temporary, staging, "parasolid", basename(output));
      const bytes = await validateParasolidPath(temporary, "Plasticity Parasolid output");
      await copyFile(temporary, output, constants.COPYFILE_EXCL);
      return {
        path: output,
        bytes,
        format: extension === ".x_t" ? "parasolid-text" : "parasolid-binary",
      };
    } finally {
      if (!this.runtime.isUncertain()) {
        await rm(temporary, { force: true }).catch(() => undefined);
        await rmdir(staging).catch(() => undefined);
      }
    }
  }

  async exportIges(ids: number[], outputPath: string, revision: string): Promise<{ path: string; bytes: number }> {
    const state = await this.assertRevision(revision);
    requireCadExportBodies(state, ids, "IGES");
    const output = resolve(outputPath);
    const extension = extname(output).toLowerCase();
    if (extension !== ".igs" && extension !== ".iges") throw new Error("IGES output must end in .igs or .iges");
    await assertAbsent(output);
    await mkdir(dirname(output), { recursive: true });
    const staging = await mkdtemp(join(dirname(output), ".plasticity-iges-"));
    const temporary = join(staging, "geometry.igs");
    try {
      await this.runtime.mutate(nativeFunction`async function (Factory, args) {
        ${findView}
        if (this.executor.isBusy) throw new Error('Plasticity is busy');
        const factory = new Factory(this);
        factory.items = args.ids.map(find);
        factory.filePath = args.path;
        await factory.commit();
      }`, ["ExportCadFactory"], [{ ids, path: temporary }]);
      await sanitizeCadExport(temporary, staging, "iges", basename(output));
      const bytes = await validateIgesPath(temporary, "Plasticity IGES output");
      await copyFile(temporary, output, constants.COPYFILE_EXCL);
      return { path: output, bytes };
    } finally {
      if (!this.runtime.isUncertain()) {
        await rm(temporary, { force: true }).catch(() => undefined);
        await rmdir(staging).catch(() => undefined);
      }
    }
  }

  async exportSat(ids: number[], outputPath: string, revision: string): Promise<{ path: string; bytes: number }> {
    const state = await this.assertRevision(revision);
    requireCadExportBodies(state, ids, "SAT");
    const output = resolve(outputPath);
    const extension = extname(output).toLowerCase();
    if (extension !== ".sat") throw new Error("SAT output must end in .sat");
    await assertAbsent(output);
    await mkdir(dirname(output), { recursive: true });
    const staging = await mkdtemp(join(dirname(output), ".plasticity-sat-"));
    const temporary = join(staging, `geometry${extension}`);
    try {
      await this.runtime.mutate(nativeFunction`async function (Factory, args) {
        ${findView}
        if (this.executor.isBusy) throw new Error('Plasticity is busy');
        const factory = new Factory(this);
        factory.items = args.ids.map(find);
        factory.filePath = args.path;
        await factory.commit();
      }`, ["ExportCadFactory"], [{ ids, path: temporary }]);
      const bytes = await validateSatPath(temporary, "Plasticity SAT output");
      await copyFile(temporary, output, constants.COPYFILE_EXCL);
      return { path: output, bytes };
    } finally {
      if (!this.runtime.isUncertain()) {
        await rm(temporary, { force: true }).catch(() => undefined);
        await rmdir(staging).catch(() => undefined);
      }
    }
  }

  async exportStl(
    ids: number[],
    outputPath: string,
    revision: string,
    chordToleranceMm: number,
    angleToleranceDegrees: number,
  ): Promise<{ path: string; bytes: number; triangles: number; chordToleranceMm: number; angleToleranceDegrees: number }> {
    await this.assertRevision(revision);
    const output = resolve(outputPath);
    if (extname(output).toLowerCase() !== ".stl") throw new Error("STL output must end in .stl");
    await assertAbsent(output);
    await mkdir(dirname(output), { recursive: true });
    const staging = await mkdtemp(join(dirname(output), ".plasticity-stl-"));
    const temporary = join(staging, "geometry.stl");
    try {
      await this.runtime.mutate(nativeFunction`async function (Factory, args) {
        ${findView}
        if (this.executor.isBusy) throw new Error('Plasticity is busy');
        const factory = new Factory(this);
        factory.shells = args.ids.map(find);
        factory.filePath = args.path;
        factory.unit = 'millimeter';
        factory.curveChordTolerance = args.chordTolerance;
        factory.surfacePlaneTolerance = args.chordTolerance;
        factory.curveChordAngleDegrees = args.angleToleranceDegrees;
        factory.surfacePlaneAngleDegrees = args.angleToleranceDegrees;
        await factory.commit();
      }`, ["STLExportFactory"], [{
        ids,
        path: temporary,
        chordTolerance: millimetersToMeters(chordToleranceMm),
        angleToleranceDegrees,
      }]);
      const temporarySize = (await stat(temporary)).size;
      if (temporarySize === 0 || temporarySize > MAX_THREE_MF_ARCHIVE_BYTES) throw new Error("Plasticity produced an empty or excessively large 3MF archive");
      const data = await readFile(temporary);
      const triangles = validateBinaryStl(data);
      await copyFile(temporary, output, constants.COPYFILE_EXCL);
      return { path: output, bytes: data.length, triangles, chordToleranceMm, angleToleranceDegrees };
    } finally {
      if (!this.runtime.isUncertain()) {
        await rm(temporary, { force: true }).catch(() => undefined);
        await rmdir(staging).catch(() => undefined);
      }
    }
  }

  async export3mf(
    ids: number[],
    outputPath: string,
    revision: string,
    chordToleranceMm: number,
    angleToleranceDegrees: number,
  ): Promise<ThreeMfValidation & {
    path: string;
    bytes: number;
    sourceUnits: "millimeter";
    chordToleranceMm: number;
    angleToleranceDegrees: number;
  }> {
    const state = await this.assertRevision(revision);
    requireMeshExportBodies(state, ids);
    if (!Number.isFinite(chordToleranceMm) || chordToleranceMm <= 0) throw new Error("3MF chord tolerance must be a positive finite millimeter value");
    if (!Number.isFinite(angleToleranceDegrees) || angleToleranceDegrees <= 0 || angleToleranceDegrees > 90) throw new Error("3MF angle tolerance must be within (0, 90] degrees");
    const output = resolve(outputPath);
    if (extname(output).toLowerCase() !== ".3mf") throw new Error("3MF output must end in .3mf");
    await assertAbsent(output);
    await mkdir(dirname(output), { recursive: true });
    const staging = await mkdtemp(join(dirname(output), ".plasticity-3mf-"));
    const temporary = join(staging, "geometry.3mf");
    try {
      await this.runtime.mutate(nativeFunction`async function (Factory, args) {
        ${findView}
        if (this.executor.isBusy) throw new Error('Plasticity is busy');
        const factory = new Factory(this);
        factory.shells = args.ids.map(find);
        factory.filePath = args.path;
        factory.scale = args.scale;
        factory.curveChordTolerance = args.chordTolerance;
        factory.surfacePlaneTolerance = args.chordTolerance;
        factory.curveChordAngleDegrees = args.angleToleranceDegrees;
        factory.surfacePlaneAngleDegrees = args.angleToleranceDegrees;
        await factory.commit();
      }`, ["ThreeMfExportFactory"], [{
        ids,
        path: temporary,
        scale: 0.001,
        chordTolerance: millimetersToMeters(chordToleranceMm),
        angleToleranceDegrees,
      }]);
      const data = await readFile(temporary);
      const validation = validateThreeMfArchive(data);
      await copyFile(temporary, output, constants.COPYFILE_EXCL);
      return {
        path: output,
        bytes: data.length,
        sourceUnits: "millimeter",
        ...validation,
        chordToleranceMm,
        angleToleranceDegrees,
      };
    } finally {
      if (!this.runtime.isUncertain()) {
        await rm(temporary, { force: true }).catch(() => undefined);
        await rmdir(staging).catch(() => undefined);
      }
    }
  }

  async exportObj(
    ids: number[],
    outputPath: string,
    revision: string,
    chordToleranceMm: number,
    angleToleranceDegrees: number,
  ): Promise<ObjValidation & {
    path: string;
    bytes: number;
    sourceUnits: "millimeter";
    upAxis: "z";
    chordToleranceMm: number;
    angleToleranceDegrees: number;
  }> {
    const state = await this.assertRevision(revision);
    requireMeshExportBodies(state, ids, "OBJ");
    if (!Number.isFinite(chordToleranceMm) || chordToleranceMm <= 0) throw new Error("OBJ chord tolerance must be a positive finite millimeter value");
    if (!Number.isFinite(angleToleranceDegrees) || angleToleranceDegrees <= 0 || angleToleranceDegrees > 90) throw new Error("OBJ angle tolerance must be within (0, 90] degrees");
    const output = resolve(outputPath);
    if (extname(output).toLowerCase() !== ".obj") throw new Error("OBJ output must end in .obj");
    await assertAbsent(output);
    await mkdir(dirname(output), { recursive: true });
    const staging = await mkdtemp(join(dirname(output), ".plasticity-obj-"));
    const temporary = join(staging, "geometry.obj");
    try {
      await this.runtime.mutate(nativeFunction`async function (Factory, args) {
        ${findView}
        if (this.executor.isBusy) throw new Error('Plasticity is busy');
        const factory = new Factory(this);
        factory.shells = args.ids.map(find);
        factory.filePath = args.path;
        factory.unit = 'millimeter';
        factory.scale = 1;
        factory.upAxis = 'z';
        factory.showWireframe = false;
        factory.simplify = false;
        factory.curveChordTolerance = args.chordTolerance;
        factory.surfacePlaneTolerance = args.chordTolerance;
        factory.curveChordAngleDegrees = args.angleToleranceDegrees;
        factory.surfacePlaneAngleDegrees = args.angleToleranceDegrees;
        await factory.commit();
      }`, ["OBJExportFactory"], [{
        ids,
        path: temporary,
        chordTolerance: millimetersToMeters(chordToleranceMm),
        angleToleranceDegrees,
      }]);
      const temporarySize = (await stat(temporary)).size;
      if (temporarySize === 0 || temporarySize > MAX_OBJ_BYTES) throw new Error("Plasticity produced an empty or excessively large OBJ file");
      const data = await readFile(temporary);
      const validation = validateObj(data);
      await copyFile(temporary, output, constants.COPYFILE_EXCL);
      return {
        path: output,
        bytes: data.length,
        sourceUnits: "millimeter",
        upAxis: "z",
        ...validation,
        chordToleranceMm,
        angleToleranceDegrees,
      };
    } finally {
      if (!this.runtime.isUncertain()) {
        await rm(temporary, { force: true }).catch(() => undefined);
        await rmdir(staging).catch(() => undefined);
      }
    }
  }

  async exportSvg(ids: number[], outputPath: string, revision: string, curveChordToleranceMm = 0.05, curveChordAngleDegrees = 5): Promise<{
    path: string;
    bytes: number;
    bodies: number;
    lineSegments: number;
    circularSegments: number;
    fullCircles: number;
    fullEllipses: number;
    ellipticalArcs: number;
    cubicBezierSegments: number;
    approximatedSegments: number;
    maxChordDeviationMm: number;
    curveChordToleranceMm: number;
    curveChordAngleDegrees: number;
    sourceUnits: "millimeter";
    boundsMm: { min: [number, number]; max: [number, number]; size: [number, number] };
    pageSizeMm: [number, number];
  }> {
    const before = await this.assertRevision(revision);
    requireWireBodyIds(before, ids);
    if (!Number.isFinite(curveChordToleranceMm) || curveChordToleranceMm <= 0 || curveChordToleranceMm > 5) {
      throw new Error("SVG curve chord tolerance must be within (0, 5] mm");
    }
    if (!Number.isFinite(curveChordAngleDegrees) || curveChordAngleDegrees <= 0 || curveChordAngleDegrees > 30) {
      throw new Error("SVG curve angle tolerance must be within (0, 30] degrees");
    }
    const output = resolve(outputPath);
    if (extname(output).toLowerCase() !== ".svg") throw new Error("SVG output must end in .svg");
    await assertAbsent(output);
    const curves = await this.runtime.readNative<Array<{
      id: number;
      closed: boolean;
      plane: { originMm: Vector3; normal: Vector3 } | null;
      segments: Array<{
        curveType: string;
        startMm: Vector3;
        endMm: Vector3;
        lengthMm: number;
        circle: { centerMm: Vector3; radiusMm: number; normal: Vector3; samplesMm: Vector3[] } | null;
        ellipse: {
          carrierSamplesMm: Vector3[];
          parameterStart: number;
          parameterEnd: number;
          parameterPeriod: number;
          startTangent: Vector3;
        } | null;
        cubicBezierSpans: Array<{
          samplesMm: Vector3[];
          validationSamples: Array<{ parameter: number; positionMm: Vector3 }>;
        }> | null;
        rationalConic: { fitSamplesMm: Vector3[]; validationSamplesMm: Vector3[]; startTangent: Vector3 } | null;
        approximation: { pointsMm: Vector3[]; maxChordDeviationMm: number } | null;
      }>;
    }>>(nativeFunction`function (args) {
      const tessellateCurve = (${tessellateCurve.toString()});
      const isExactSvgCubicPolynomialDegree = (${isExactSvgCubicPolynomialDegree.toString()});
      const mm = value => value * 1000;
      const vector = value => [mm(value.x), mm(value.y), mm(value.z)];
      const directionVector = value => [value.x, value.y, value.z];
      const direction = value => {
        const length = Math.hypot(value.x, value.y, value.z);
        if (!(length > 0)) throw new Error('Native circular curve has a zero plane normal');
        return [value.x / length, value.y / length, value.z / length];
      };
      const result = [];
      let totalApproximationPoints = 0;
      for (const wantedId of args.ids) {
        let found;
        for (const [versionId, item] of nativeApi.geo.geometryModel) {
          if (nativeApi.db.lookupStableId(versionId) === wantedId) { found = [versionId, item]; break; }
        }
        if (!found) throw new Error('Unknown current Wire ID: ' + wantedId);
        const [versionId, item] = found;
        if (item.view?.constructor?.name !== 'Wire') throw new Error('SVG export requires a Wire: ' + wantedId);
        const basis = item.model?.FindPlanarBasis?.();
        const edges = item.model?.GetEdges?.();
        if (!basis || !edges) throw new Error('SVG export requires a planar native Wire: ' + wantedId);
        let closed = true;
        for (const vertex of Array.from(item.view.vertices ?? [])) {
          if (nativeApi.db.lookupTopologyItem(vertex).IsSpur()) { closed = false; break; }
        }
        const segments = [];
        for (let index = 0; index < edges.Size(); index++) {
          const edge = edges.Get(index);
          const wrapped = edge.GetCurve();
          const curve = wrapped?.curve ?? wrapped;
          const curveType = String(curve?.constructor?.name ?? 'Unknown');
          const startEvaluation = edge.GetPointAndTangent(0);
          const endEvaluation = edge.GetPointAndTangent(1);
          let circle = null;
          let ellipse = null;
          let cubicBezierSpans = null;
          let rationalConic = null;
          let approximation = null;
          if (curveType === 'Circle') {
            const info = curve.GetInfo?.();
            const circleBasis = info?.basis;
            if (!circleBasis || !Number.isFinite(info?.radius) || !(info.radius > 0)) {
              throw new Error('Plasticity returned incomplete analytic data for a circular Wire segment');
            }
            circle = {
              centerMm: vector(circleBasis.Location),
              radiusMm: mm(info.radius),
              normal: direction(circleBasis.Axis),
              samplesMm: [0, 0.25, 0.5, 0.75, 1].map(parameter => vector(edge.GetPointAndTangent(parameter).position)),
            };
          } else if (curveType === 'Ellipse') {
            const carrierInterval = curve.GetInterval?.();
            const uMin = Number(wrapped?.uMin);
            const uMax = Number(wrapped?.uMax);
            const carrierMin = Number(carrierInterval?.tmin);
            const carrierMax = Number(carrierInterval?.tmax);
            if ([uMin, uMax, carrierMin, carrierMax].every(Number.isFinite) && uMax !== uMin && carrierMax > carrierMin) {
              const fromMin = curve.GetPoint(uMin);
              const fromMax = curve.GetPoint(uMax);
              const minMatchesStart = Math.hypot(fromMin.x - startEvaluation.position.x, fromMin.y - startEvaluation.position.y, fromMin.z - startEvaluation.position.z) <= 1e-9;
              const maxMatchesStart = Math.hypot(fromMax.x - startEvaluation.position.x, fromMax.y - startEvaluation.position.y, fromMax.z - startEvaluation.position.z) <= 1e-9;
              const minMatchesEnd = Math.hypot(fromMin.x - endEvaluation.position.x, fromMin.y - endEvaluation.position.y, fromMin.z - endEvaluation.position.z) <= 1e-9;
              const maxMatchesEnd = Math.hypot(fromMax.x - endEvaluation.position.x, fromMax.y - endEvaluation.position.y, fromMax.z - endEvaluation.position.z) <= 1e-9;
              let parameterStart = NaN;
              let parameterEnd = NaN;
              if (minMatchesStart && maxMatchesEnd) { parameterStart = uMin; parameterEnd = uMax; }
              else if (maxMatchesStart && minMatchesEnd) { parameterStart = uMax; parameterEnd = uMin; }
              if (Number.isFinite(parameterStart) && Number.isFinite(parameterEnd)) {
                ellipse = {
                  carrierSamplesMm: [0, 0.25, 0.5, 0.75, 1].map(fraction => vector(curve.GetPoint(carrierMin + (carrierMax - carrierMin) * fraction))),
                  parameterStart,
                  parameterEnd,
                  parameterPeriod: carrierMax - carrierMin,
                  startTangent: directionVector(startEvaluation.tangent),
                };
              }
            }
            if (!ellipse) {
              const tessellation = tessellateCurve(parameter => {
                const evaluated = edge.GetPointAndTangent(parameter);
                return { point: vector(evaluated.position), tangent: directionVector(evaluated.tangent) };
              }, args.curveChordToleranceMm, args.curveChordAngleDegrees);
              totalApproximationPoints += tessellation.points.length;
              if (totalApproximationPoints > 200_000) throw new Error('SVG export exceeds the total adaptive-curve point limit');
              approximation = { pointsMm: tessellation.points, maxChordDeviationMm: tessellation.maxChordDeviationMm };
            }
          } else if (curveType === 'BCurve') {
            try {
              const info = curve.GetInfo?.();
              if (info?.isRational === true) {
                const sample = parameter => vector(edge.GetPointAndTangent(parameter).position);
                rationalConic = {
                  fitSamplesMm: [0.1, 0.3, 0.5, 0.7, 0.9].map(sample),
                  validationSamplesMm: Array.from({ length: 65 }, (_, index) => sample(index / 64)),
                  startTangent: directionVector(startEvaluation.tangent),
                };
              }
              // Each non-rational B-spline knot span of degree 1-3 is polynomial
              // and can be represented exactly by an SVG cubic, including periodic
              // curves. The per-span native sample checks below remain the gate.
              if (isExactSvgCubicPolynomialDegree(info?.degree, info?.isRational) && Number.isInteger(info?.numDistinctKnots) && info.numDistinctKnots >= 2 && info.knotVals) {
              const knotParameters = [];
              for (let knotIndex = 0; knotIndex < info.numDistinctKnots; knotIndex++) {
                const parameter = Number(edge.Normalize(Number(info.knotVals[knotIndex])));
                if (Number.isFinite(parameter) && parameter >= -1e-10 && parameter <= 1 + 1e-10) knotParameters.push(Math.max(0, Math.min(1, parameter)));
              }
              knotParameters.push(0, 1);
              const breaks = Array.from(new Set(knotParameters.sort((left, right) => left - right).map(parameter => Number(parameter.toPrecision(14)))));
              if (breaks[0] === 0 && breaks.at(-1) === 1 && breaks.length >= 2 && breaks.length <= 1_025) {
                const sample = parameter => vector(edge.GetPointAndTangent(parameter).position);
                const spans = [];
                for (let spanIndex = 0; spanIndex < breaks.length - 1; spanIndex++) {
                  const start = breaks[spanIndex];
                  const end = breaks[spanIndex + 1];
                  if (!(end > start)) continue;
                  const at = fraction => start + (end - start) * fraction;
                  spans.push({
                    samplesMm: [0, 1 / 3, 2 / 3, 1].map(fraction => sample(at(fraction))),
                    validationSamples: [1 / 8, 1 / 4, 1 / 2, 3 / 4, 7 / 8].map(fraction => ({ parameter: fraction, positionMm: sample(at(fraction)) })),
                  });
                }
                if (spans.length === breaks.length - 1) cubicBezierSpans = spans;
              }
              }
            } catch { cubicBezierSpans = null; }
            if (!cubicBezierSpans) {
              const tessellation = tessellateCurve(parameter => {
                const evaluated = edge.GetPointAndTangent(parameter);
                return { point: vector(evaluated.position), tangent: directionVector(evaluated.tangent) };
              }, args.curveChordToleranceMm, args.curveChordAngleDegrees);
              totalApproximationPoints += tessellation.points.length;
              if (totalApproximationPoints > 200_000) throw new Error('SVG export exceeds the total adaptive-curve point limit');
              approximation = { pointsMm: tessellation.points, maxChordDeviationMm: tessellation.maxChordDeviationMm };
            }
          } else if (curveType !== 'Line') {
            const tessellation = tessellateCurve(parameter => {
              const evaluated = edge.GetPointAndTangent(parameter);
              return { point: vector(evaluated.position), tangent: directionVector(evaluated.tangent) };
            }, args.curveChordToleranceMm, args.curveChordAngleDegrees);
            totalApproximationPoints += tessellation.points.length;
            if (totalApproximationPoints > 200_000) throw new Error('SVG export exceeds the total adaptive-curve point limit');
            approximation = { pointsMm: tessellation.points, maxChordDeviationMm: tessellation.maxChordDeviationMm };
          }
          segments.push({
            curveType,
            startMm: vector(startEvaluation.position),
            endMm: vector(endEvaluation.position),
            lengthMm: mm(edge.FindLength().length),
            circle,
            ellipse,
            cubicBezierSpans,
            rationalConic,
            approximation,
          });
        }
        result.push({ id: wantedId, versionId: Number(versionId), closed, plane: { originMm: vector(basis.Location), normal: direction(basis.Axis) }, segments });
      }
      return result;
    }`, [], [{ ids, curveChordToleranceMm, curveChordAngleDegrees }]);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while SVG geometry was being read");
    }
    if (curves.length !== ids.length || curves.some((curve, index) => curve.id !== ids[index])) {
      throw new Error("Plasticity returned an incomplete or reordered SVG Wire set");
    }
    const referencePlane = curves[0]?.plane;
    if (!referencePlane) throw new Error("SVG export requires a planar native Wire");
    const normalLength = Math.hypot(...referencePlane.normal);
    if (!Number.isFinite(normalLength) || normalLength <= 0) throw new Error("SVG Wire has an invalid native plane normal");
    const normal = referencePlane.normal.map((value) => value / normalLength) as Vector3;
    const worldX: Vector3 = [1, 0, 0];
    const worldY: Vector3 = [0, 1, 0];
    const candidate = Math.abs(dot(normal, worldX)) < 0.9 ? worldX : worldY;
    const xProjection = subtract(candidate, scale(normal, dot(candidate, normal)));
    const xAxis = normalize(xProjection);
    const yAxis = cross(normal, xAxis);
    const project = (point: Vector3): [number, number] => {
      if (Math.abs(dot(subtract(point, referencePlane.originMm), normal)) > 1e-6) {
        throw new Error("All exported Wire segments must lie in one common plane");
      }
      const relative = subtract(point, referencePlane.originMm);
      const x = dot(relative, xAxis);
      const y = -dot(relative, yAxis);
      return [Object.is(x, -0) ? 0 : x, Object.is(y, -0) ? 0 : y];
    };
    const paths: string[] = [];
    const points: Array<[number, number]> = [];
    let lineSegments = 0;
    let circularSegments = 0;
    let fullCircles = 0;
    let fullEllipses = 0;
    let ellipticalArcs = 0;
    let cubicBezierSegments = 0;
    let approximatedSegments = 0;
    let maxChordDeviationMm = 0;
    let totalPolylinePoints = 0;
    const angle2d = (point: [number, number], center: [number, number]) => Math.atan2(point[1] - center[1], point[0] - center[0]);
    const positiveAngle = (angle: number) => (angle % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    for (const curve of curves) {
      if (!curve.plane) throw new Error(`SVG export requires a planar native Wire: ${curve.id}`);
      const curveNormalLength = Math.hypot(...curve.plane.normal);
      if (!Number.isFinite(curveNormalLength) || curveNormalLength <= 0) throw new Error(`SVG Wire has an invalid plane normal: ${curve.id}`);
      const curveNormal = curve.plane.normal.map((value) => value / curveNormalLength) as Vector3;
      if (Math.abs(Math.abs(dot(normal, curveNormal)) - 1) > 1e-9 || Math.abs(dot(subtract(curve.plane.originMm, referencePlane.originMm), normal)) > 1e-6) {
        throw new Error("All exported Wires must be coplanar");
      }
      for (const segment of curve.segments) {
        const start = project(segment.startMm);
        const end = project(segment.endMm);
        let exactCubicBezier: { commands: string[]; boundsPoints: [number, number][] } | null = null;
        let exactRationalConic: { ellipse: ReturnType<typeof fitSvgConicEllipse>; arc: { largeArcFlag: 0 | 1; sweepFlag: 0 | 1 } | null; boundsPoints: [number, number][]; full: boolean } | null = null;
        if (segment.curveType === "BCurve" && segment.rationalConic) {
          try {
            const conic = segment.rationalConic;
            if (conic.fitSamplesMm.length === 5 && conic.validationSamplesMm.length >= 9) {
              const ellipse = fitSvgConicEllipse(conic.fitSamplesMm.map(project));
              const validationTolerance = Math.max(1e-7, ellipse.majorRadius * 1e-9);
              const validationPoints = conic.validationSamplesMm.map(project);
              for (const point of validationPoints) {
                const x = (point[0] - ellipse.center[0]) * ellipse.majorAxis[0] + (point[1] - ellipse.center[1]) * ellipse.majorAxis[1];
                const y = (point[0] - ellipse.center[0]) * ellipse.minorAxis[0] + (point[1] - ellipse.center[1]) * ellipse.minorAxis[1];
                if (Math.abs(Math.hypot(x / ellipse.majorRadius, y / ellipse.minorRadius) - 1) * ellipse.majorRadius > validationTolerance) {
                  throw new Error("Rational BCurve validation samples do not lie on one ellipse");
                }
              }
              const parameterAngle = (point: [number, number]): number => Math.atan2(
                ((point[0] - ellipse.center[0]) * ellipse.minorAxis[0] + (point[1] - ellipse.center[1]) * ellipse.minorAxis[1]) / ellipse.minorRadius,
                ((point[0] - ellipse.center[0]) * ellipse.majorAxis[0] + (point[1] - ellipse.center[1]) * ellipse.majorAxis[1]) / ellipse.majorRadius,
              );
              let sweep = 0;
              let direction = 0;
              for (let index = 1; index < validationPoints.length; index++) {
                const difference = parameterAngle(validationPoints[index]!) - parameterAngle(validationPoints[index - 1]!);
                const delta = Math.atan2(Math.sin(difference), Math.cos(difference));
                if (Math.abs(delta) >= Math.PI / 2) throw new Error("Rational BCurve ellipse sweep is under-sampled or ambiguous");
                if (Math.abs(delta) > 1e-10) {
                  const nextDirection = Math.sign(delta);
                  if (direction !== 0 && direction !== nextDirection) throw new Error("Rational BCurve reverses direction on its fitted ellipse");
                  direction = nextDirection;
                }
                sweep += delta;
              }
              const full = Math.abs(Math.abs(sweep) - 2 * Math.PI) <= 1e-6;
              if (!(Math.abs(sweep) > 1e-8) || Math.abs(sweep) > 2 * Math.PI + 1e-6) throw new Error("Rational BCurve ellipse sweep is degenerate or exceeds one turn");
              if (full && (!curve.closed || Math.hypot(end[0] - start[0], end[1] - start[1]) > validationTolerance)) {
                throw new Error("A full rational conic must be a closed native Wire");
              }
              const boundsPoints: [number, number][] = [];
              if (full) {
                const xExtent = Math.hypot(ellipse.majorRadius * ellipse.majorAxis[0], ellipse.minorRadius * ellipse.minorAxis[0]);
                const yExtent = Math.hypot(ellipse.majorRadius * ellipse.majorAxis[1], ellipse.minorRadius * ellipse.minorAxis[1]);
                boundsPoints.push([ellipse.center[0] - xExtent, ellipse.center[1]], [ellipse.center[0] + xExtent, ellipse.center[1]], [ellipse.center[0], ellipse.center[1] - yExtent], [ellipse.center[0], ellipse.center[1] + yExtent]);
              } else {
                const tangent: [number, number] = [dot(conic.startTangent, xAxis), -dot(conic.startTangent, yAxis)];
                const arc = analyzeSvgEllipseArc(ellipse, start, end, tangent, 0, sweep / (2 * Math.PI), 1);
                boundsPoints.push(...arc.boundsPoints);
                exactRationalConic = { ellipse, arc, boundsPoints, full };
              }
              if (full) exactRationalConic = { ellipse, arc: null, boundsPoints, full };
            }
          } catch { exactRationalConic = null; }
        }
        if (segment.curveType === "BCurve" && segment.cubicBezierSpans) {
          const commands: string[] = [];
          const boundsPoints: [number, number][] = [];
          let currentStart: [number, number] | null = null;
          let valid = true;
          for (const span of segment.cubicBezierSpans) {
            if (span.samplesMm.length !== 4 || span.validationSamples.length !== 5) { valid = false; break; }
            const samples = span.samplesMm.map(project);
            const controls = fitSvgCubicBezier(samples);
            const validationScale = Math.max(1, ...controls.flat().map(Math.abs));
            for (const validation of span.validationSamples) {
              const actual = project(validation.positionMm);
              const expected = evaluateSvgCubicBezier(controls, validation.parameter);
              if (Math.hypot(actual[0] - expected[0], actual[1] - expected[1]) > validationScale * 1e-10) {
                valid = false;
                break;
              }
            }
            if (!valid) break;
            const spanStart = controls[0];
            if (currentStart && Math.hypot(currentStart[0] - spanStart[0], currentStart[1] - spanStart[1]) > validationScale * 1e-10) {
              valid = false;
              break;
            }
            if (!currentStart && Math.hypot(start[0] - spanStart[0], start[1] - spanStart[1]) > validationScale * 1e-10) {
              valid = false;
              break;
            }
            if (!currentStart) currentStart = spanStart;
            commands.push(`C ${formatSvgNumber(controls[1][0])} ${formatSvgNumber(controls[1][1])} ${formatSvgNumber(controls[2][0])} ${formatSvgNumber(controls[2][1])} ${formatSvgNumber(controls[3][0])} ${formatSvgNumber(controls[3][1])}`);
            boundsPoints.push(...svgCubicBezierBoundsPoints(controls));
            currentStart = controls[3];
          }
          if (valid && commands.length > 0 && currentStart && Math.hypot(currentStart[0] - end[0], currentStart[1] - end[1]) <= Math.max(1e-8, Math.hypot(...end) * 1e-10)) {
            exactCubicBezier = { commands, boundsPoints };
          }
        }
        if (segment.curveType === "Line") {
          if (Math.hypot(end[0] - start[0], end[1] - start[1]) <= 1e-12) throw new Error("SVG export cannot include zero-length native lines");
          points.push(start, end);
          paths.push(`<path d="M ${formatSvgNumber(start[0])} ${formatSvgNumber(start[1])} L ${formatSvgNumber(end[0])} ${formatSvgNumber(end[1])}"/>`);
          lineSegments += 1;
        } else if (segment.curveType === "Circle" && segment.circle) {
          const circle = segment.circle;
          if (!Number.isFinite(circle.radiusMm) || circle.radiusMm <= 0) throw new Error("SVG circular Wire radius must be positive and finite");
          const circleNormalLength = Math.hypot(...circle.normal);
          if (!Number.isFinite(circleNormalLength) || circleNormalLength <= 0) throw new Error("SVG circular Wire has an invalid plane normal");
          const circleNormal = circle.normal.map((value) => value / circleNormalLength) as Vector3;
          if (Math.abs(Math.abs(dot(normal, circleNormal)) - 1) > 1e-9) throw new Error("SVG circular Wire axis must match its planar profile");
          const center = project(circle.centerMm);
          if (circle.samplesMm.length !== 5) throw new Error("SVG circular Wire requires five exact native curve samples");
          const samples = circle.samplesMm.map(project);
          for (const sample of samples) {
            const distance = Math.hypot(sample[0] - center[0], sample[1] - center[1]);
            if (Math.abs(distance - circle.radiusMm) > Math.max(1e-6, circle.radiusMm * 1e-8)) {
              throw new Error("Native Circle sample does not match its reported exact radius");
            }
          }
          const endpointGap = Math.hypot(end[0] - start[0], end[1] - start[1]);
          if (endpointGap <= Math.max(1e-8, circle.radiusMm * 1e-9)) {
            if (!curve.closed) throw new Error("A full circular SVG element requires a closed native Wire");
            if (Math.abs(segment.lengthMm - 2 * Math.PI * circle.radiusMm) > Math.max(1e-6, segment.lengthMm * 1e-8)) {
              throw new Error("Closed native Circle length does not match its exact radius");
            }
            points.push([center[0] - circle.radiusMm, center[1]], [center[0] + circle.radiusMm, center[1]], [center[0], center[1] - circle.radiusMm], [center[0], center[1] + circle.radiusMm]);
            paths.push(`<circle cx="${formatSvgNumber(center[0])}" cy="${formatSvgNumber(center[1])}" r="${formatSvgNumber(circle.radiusMm)}"/>`);
            circularSegments += 1;
            fullCircles += 1;
            continue;
          }
          if (Math.hypot(samples[0]![0] - start[0], samples[0]![1] - start[1]) > 1e-8 || Math.hypot(samples[4]![0] - end[0], samples[4]![1] - end[1]) > 1e-8) {
            throw new Error("Native circular Wire samples do not match its B-Rep endpoints");
          }
          const startAngle = angle2d(start, center);
          const endAngle = angle2d(end, center);
          const middleAngle = angle2d(samples[2]!, center);
          const ccwSweep = positiveAngle(endAngle - startAngle);
          const middleCcwSweep = positiveAngle(middleAngle - startAngle);
          const sweepFlag = middleCcwSweep < ccwSweep ? 1 : 0;
          const sweep = sweepFlag === 1 ? ccwSweep : 2 * Math.PI - ccwSweep;
          if (!(sweep > 1e-10 && sweep < 2 * Math.PI - 1e-10)) throw new Error("Native circular Wire sweep is degenerate or ambiguous");
          if (Math.abs(segment.lengthMm - circle.radiusMm * sweep) > Math.max(1e-6, segment.lengthMm * 1e-8)) {
            throw new Error("Native circular Wire length does not match its exact SVG arc sweep");
          }
          const largeArcFlag = sweep > Math.PI + 1e-10 ? 1 : 0;
          points.push(start, end);
          for (let quadrant = 0; quadrant < 4; quadrant++) {
            const angle = quadrant * Math.PI / 2;
            const delta = sweepFlag === 1 ? positiveAngle(angle - startAngle) : positiveAngle(startAngle - angle);
            if (delta <= sweep + 1e-10) points.push([center[0] + circle.radiusMm * Math.cos(angle), center[1] + circle.radiusMm * Math.sin(angle)]);
          }
          paths.push(`<path d="M ${formatSvgNumber(start[0])} ${formatSvgNumber(start[1])} A ${formatSvgNumber(circle.radiusMm)} ${formatSvgNumber(circle.radiusMm)} 0 ${largeArcFlag} ${sweepFlag} ${formatSvgNumber(end[0])} ${formatSvgNumber(end[1])}"/>`);
          circularSegments += 1;
        } else if (exactRationalConic) {
          const conic = exactRationalConic;
          points.push(...conic.boundsPoints);
          if (conic.full) {
            paths.push(`<ellipse cx="${formatSvgNumber(conic.ellipse.center[0])}" cy="${formatSvgNumber(conic.ellipse.center[1])}" rx="${formatSvgNumber(conic.ellipse.majorRadius)}" ry="${formatSvgNumber(conic.ellipse.minorRadius)}" transform="rotate(${formatSvgNumber(conic.ellipse.rotationDegrees)} ${formatSvgNumber(conic.ellipse.center[0])} ${formatSvgNumber(conic.ellipse.center[1])})" data-curve-type="BCurve" data-representation="ellipse-fit" data-validation="65-native-brep-samples"/>`);
            fullEllipses += 1;
          } else {
            if (!conic.arc) throw new Error("Validated rational conic arc lost its SVG sweep data");
            paths.push(`<path d="M ${formatSvgNumber(start[0])} ${formatSvgNumber(start[1])} A ${formatSvgNumber(conic.ellipse.majorRadius)} ${formatSvgNumber(conic.ellipse.minorRadius)} ${formatSvgNumber(conic.ellipse.rotationDegrees)} ${conic.arc.largeArcFlag} ${conic.arc.sweepFlag} ${formatSvgNumber(end[0])} ${formatSvgNumber(end[1])}" data-curve-type="BCurve" data-representation="ellipse-fit" data-validation="65-native-brep-samples"/>`);
            ellipticalArcs += 1;
          }
        } else if (exactCubicBezier) {
          points.push(...exactCubicBezier.boundsPoints);
          paths.push(`<path d="M ${formatSvgNumber(start[0])} ${formatSvgNumber(start[1])} ${exactCubicBezier.commands.join(" ")}" data-curve-type="BCurve"/>`);
          cubicBezierSegments += 1;
        } else if (segment.approximation) {
          const { pointsMm, maxChordDeviationMm: segmentDeviation } = segment.approximation;
          if (pointsMm.length < 2 || pointsMm.length > 16_384 || !Number.isFinite(segmentDeviation) || segmentDeviation < 0 || segmentDeviation > curveChordToleranceMm) {
            throw new Error(`SVG approximation for ${segment.curveType} did not meet its point-count or chord-tolerance contract`);
          }
          totalPolylinePoints += pointsMm.length;
          if (totalPolylinePoints > 200_000) throw new Error("SVG export exceeds the total polyline point limit");
          const polyline = pointsMm.map(project);
          if (Math.hypot(polyline[0]![0] - start[0], polyline[0]![1] - start[1]) > 1e-8 || Math.hypot(polyline.at(-1)![0] - end[0], polyline.at(-1)![1] - end[1]) > 1e-8) {
            throw new Error(`SVG approximation endpoints do not match native ${segment.curveType} B-Rep endpoints`);
          }
          if (polyline.some((point, index) => index > 0 && Math.hypot(point[0] - polyline[index - 1]![0], point[1] - polyline[index - 1]![1]) <= 1e-12)) {
            throw new Error(`SVG approximation for ${segment.curveType} contains a zero-length span`);
          }
          const pathData = polyline.map((point, index) => `${index === 0 ? "M" : "L"} ${formatSvgNumber(point[0])} ${formatSvgNumber(point[1])}`).join(" ");
          points.push(...polyline);
          paths.push(`<path d="${pathData}" data-curve-type="${escapeSvgAttribute(segment.curveType)}" data-approximation="adaptive-chord"/>`);
          approximatedSegments += 1;
          maxChordDeviationMm = Math.max(maxChordDeviationMm, segmentDeviation);
        } else if (segment.curveType === "Ellipse" && segment.ellipse) {
          const ellipse = fitSvgEllipse(segment.ellipse.carrierSamplesMm.map(project));
          const parameterSpan = Math.abs(segment.ellipse.parameterEnd - segment.ellipse.parameterStart);
          const isSingleClosedEllipse = curve.closed && curve.segments.length === 1 &&
            Math.abs(parameterSpan - segment.ellipse.parameterPeriod) <= segment.ellipse.parameterPeriod * 1e-8;
          if (isSingleClosedEllipse) {
            if (Math.hypot(end[0] - start[0], end[1] - start[1]) > Math.max(1e-7, ellipse.majorRadius * 1e-8)) {
              throw new Error("Closed native Ellipse endpoints do not meet");
            }
            const xExtent = Math.hypot(ellipse.majorRadius * ellipse.majorAxis[0], ellipse.minorRadius * ellipse.minorAxis[0]);
            const yExtent = Math.hypot(ellipse.majorRadius * ellipse.majorAxis[1], ellipse.minorRadius * ellipse.minorAxis[1]);
            points.push(
              [ellipse.center[0] - xExtent, ellipse.center[1]], [ellipse.center[0] + xExtent, ellipse.center[1]],
              [ellipse.center[0], ellipse.center[1] - yExtent], [ellipse.center[0], ellipse.center[1] + yExtent],
            );
            paths.push(`<ellipse cx="${formatSvgNumber(ellipse.center[0])}" cy="${formatSvgNumber(ellipse.center[1])}" rx="${formatSvgNumber(ellipse.majorRadius)}" ry="${formatSvgNumber(ellipse.minorRadius)}" transform="rotate(${formatSvgNumber(ellipse.rotationDegrees)} ${formatSvgNumber(ellipse.center[0])} ${formatSvgNumber(ellipse.center[1])})"/>`);
            fullEllipses += 1;
          } else {
            const startTangent: [number, number] = [
              dot(segment.ellipse.startTangent, xAxis),
              -dot(segment.ellipse.startTangent, yAxis),
            ];
            const arc = analyzeSvgEllipseArc(
              ellipse, start, end, startTangent,
              segment.ellipse.parameterStart, segment.ellipse.parameterEnd, segment.ellipse.parameterPeriod,
            );
            points.push(...arc.boundsPoints);
            paths.push(`<path d="M ${formatSvgNumber(start[0])} ${formatSvgNumber(start[1])} A ${formatSvgNumber(ellipse.majorRadius)} ${formatSvgNumber(ellipse.minorRadius)} ${formatSvgNumber(ellipse.rotationDegrees)} ${arc.largeArcFlag} ${arc.sweepFlag} ${formatSvgNumber(end[0])} ${formatSvgNumber(end[1])}" data-curve-type="Ellipse"/>`);
            ellipticalArcs += 1;
          }
        } else {
          throw new Error(`SVG export encountered an unsupported native curve: ${segment.curveType}`);
        }
      }
    }
    if (paths.length === 0 || paths.length > 100_000) throw new Error("SVG export requires between 1 and 100000 native curve segments");
    const min: [number, number] = [Infinity, Infinity];
    const max: [number, number] = [-Infinity, -Infinity];
    for (const [x, y] of points) {
      min[0] = Math.min(min[0], x);
      min[1] = Math.min(min[1], y);
      max[0] = Math.max(max[0], x);
      max[1] = Math.max(max[1], y);
    }
    const size: [number, number] = [max[0] - min[0], max[1] - min[1]];
    if (size[0] <= 0 || size[1] <= 0) throw new Error("SVG export requires nonzero width and height");
    const strokeWidthMm = 0.2;
    const paddingMm = strokeWidthMm / 2;
    const pageSizeMm: [number, number] = [size[0] + strokeWidthMm, size[1] + strokeWidthMm];
    const viewBox = [min[0] - paddingMm, min[1] - paddingMm, pageSizeMm[0], pageSizeMm[1]].map(formatSvgNumber).join(" ");
    const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${formatSvgNumber(pageSizeMm[0])}mm" height="${formatSvgNumber(pageSizeMm[1])}mm" viewBox="${viewBox}">\n<g fill="none" stroke="#000000" stroke-width="${formatSvgNumber(strokeWidthMm)}" stroke-linecap="round" stroke-linejoin="round">\n${paths.join("\n")}\n</g>\n</svg>\n`;
    if (Buffer.byteLength(svg) > 16 * 1024 * 1024) throw new Error("SVG export exceeds the 16 MiB output limit");
    await mkdir(dirname(output), { recursive: true });
    const staging = await mkdtemp(join(dirname(output), ".plasticity-svg-"));
    const temporary = join(staging, "geometry.svg");
    try {
      await writeFile(temporary, svg, { flag: "wx" });
      await copyFile(temporary, output, constants.COPYFILE_EXCL);
      return { path: output, bytes: Buffer.byteLength(svg), bodies: curves.length, lineSegments, circularSegments, fullCircles, fullEllipses, ellipticalArcs, cubicBezierSegments, approximatedSegments, maxChordDeviationMm, curveChordToleranceMm, curveChordAngleDegrees, sourceUnits: "millimeter", boundsMm: { min, max, size }, pageSizeMm };
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
      await rmdir(staging).catch(() => undefined);
    }
  }

  async exportHiddenLineSvg(
    ids: number[],
    outputPath: string,
    revision: string,
    curveChordToleranceMm = 0.05,
    curveChordAngleDegrees = 5,
    marginMm = 1,
  ): Promise<{
    path: string;
    bytes: number;
    bodies: number;
    segments: number;
    visibleSegments: number;
    hiddenSegments: number;
    sourceUnits: "millimeter";
    projection: "native-orthographic";
    projectedBoundsMm: { min: [number, number]; max: [number, number]; size: [number, number] };
    curveChordToleranceMm: number;
    curveChordAngleDegrees: number;
  }> {
    const before = await this.assertRevision(revision);
    requireHiddenLineBodies(before, ids);
    if (!Number.isFinite(curveChordToleranceMm) || curveChordToleranceMm <= 0 || curveChordToleranceMm > 5) {
      throw new Error("Hidden-line curve chord tolerance must be within (0, 5] mm");
    }
    if (!Number.isFinite(curveChordAngleDegrees) || curveChordAngleDegrees <= 0 || curveChordAngleDegrees > 30) {
      throw new Error("Hidden-line curve chord angle must be within (0, 30] degrees");
    }
    if (!Number.isFinite(marginMm) || marginMm < 0 || marginMm > 1_000) {
      throw new Error("Hidden-line SVG margin must be between 0 and 1000 mm");
    }
    const output = resolve(outputPath);
    if (extname(output).toLowerCase() !== ".svg") throw new Error("Hidden-line SVG output must end in .svg");
    await assertAbsent(output);

    const projection = await this.runtime.readNative<{
      positions: number[];
      segments: HiddenLineProjectionSegment[];
      scaleXmmPerPixel: number;
      scaleYmmPerPixel: number;
      cameraType: string;
    }>(nativeFunction`async function (Factory, Vector2, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const views = args.ids.map(wantedId => {
        for (const [versionId, item] of nativeApi.geo.geometryModel) {
          if (nativeApi.db.lookupStableId(versionId) !== wantedId) continue;
          if (item.view?.constructor?.name !== 'Solid') throw new Error('Hidden-line SVG export requires native Solid bodies: ' + wantedId);
          return item.view;
        }
        throw new Error('Unknown current Solid ID: ' + wantedId);
      });
      const factory = new Factory(this);
      try {
        factory.items = views;
        factory.includeBackgroundImage = false;
        factory.useMaterialColors = false;
        factory.curveChordTolerance = args.curveChordTolerance;
        factory.curveChordAngleDegrees = args.curveChordAngleDegrees;
        const bodyData = factory.collectBodyData();
        const viewport = Array.from(this.viewports)[0];
        if (!viewport?.camera) throw new Error('Plasticity viewport camera is unavailable');
        const camera = viewport.camera.clone();
        if (!camera.isOrthographicCamera) throw new Error('Native hidden-line SVG export requires an orthographic Plasticity view');
        camera.updateMatrixWorld(true);
        camera.updateProjectionMatrix();
        const horizontalSpan = camera.right - camera.left;
        const verticalSpan = camera.top - camera.bottom;
        if (!(horizontalSpan > 0) || !(verticalSpan > 0)) throw new Error('Plasticity orthographic camera has invalid bounds');
        const resolutionX = 2048;
        const resolutionY = Math.max(1, Math.round(resolutionX * verticalSpan / horizontalSpan));
        const resolution = new Vector2(resolutionX, resolutionY);
        const projected = await factory.generator.generate(camera, resolution, bodyData.bodyIds, factory, bodyData.transforms);
        if (!projected?.geo || !ArrayBuffer.isView(projected.geo) || !Array.isArray(projected.segments)) {
          throw new Error('Plasticity returned an invalid native hidden-line projection');
        }
        if (projected.geo.length > 600_000 || projected.segments.length > 100_000) {
          throw new Error('Native hidden-line projection exceeds the MCP output limit');
        }
        const matrix = camera.projectionMatrix.elements;
        const p00 = Math.abs(matrix[0]);
        const p11 = Math.abs(matrix[5]);
        if (!(p00 > 0) || !(p11 > 0)) throw new Error('Plasticity orthographic projection matrix is degenerate');
        return {
          positions: Array.from(projected.geo),
          segments: projected.segments.map(segment => ({
            bodyIndex: Number(segment.bodyIndex),
            category: String(segment.category),
            offset: Number(segment.offset),
            count: Number(segment.count),
          })),
          scaleXmmPerPixel: 2000 / (p00 * resolutionX),
          scaleYmmPerPixel: 2000 / (p11 * resolutionY),
          cameraType: camera.isOrthographicCamera ? 'OrthographicCamera' : camera.constructor.name,
        };
      } finally {
        factory.dispose?.();
      }
    }`, ["ExportHiddenLineFactory", "Vector2"], [{
      ids,
      curveChordTolerance: millimetersToMeters(curveChordToleranceMm),
      curveChordAngleDegrees,
    }], NATIVE_STATE_READ_TIMEOUT_MS);

    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while its hidden-line projection was being generated");
    }
    if (projection.cameraType !== "OrthographicCamera") throw new Error("Plasticity did not return an orthographic hidden-line projection");
    const svg = serializeHiddenLineSvg({
      positions: projection.positions,
      segments: projection.segments,
      scaleXmmPerPixel: projection.scaleXmmPerPixel,
      scaleYmmPerPixel: projection.scaleYmmPerPixel,
      marginMm,
    });
    const minimum: [number, number] = [Infinity, Infinity];
    const maximum: [number, number] = [-Infinity, -Infinity];
    for (const segment of projection.segments) {
      for (let point = 0; point < segment.count; point += 1) {
        const index = segment.offset + point * 2;
        const x = projection.positions[index]! * projection.scaleXmmPerPixel;
        const y = -projection.positions[index + 1]! * projection.scaleYmmPerPixel;
        minimum[0] = Math.min(minimum[0], x);
        minimum[1] = Math.min(minimum[1], y);
        maximum[0] = Math.max(maximum[0], x);
        maximum[1] = Math.max(maximum[1], y);
      }
    }
    const size: [number, number] = [maximum[0] - minimum[0], maximum[1] - minimum[1]];
    await mkdir(dirname(output), { recursive: true });
    const staging = await mkdtemp(join(dirname(output), ".plasticity-hidden-line-svg-"));
    const temporary = join(staging, "projection.svg");
    try {
      await writeFile(temporary, svg, { flag: "wx" });
      await copyFile(temporary, output, constants.COPYFILE_EXCL);
      return {
        path: output,
        bytes: Buffer.byteLength(svg),
        bodies: ids.length,
        segments: projection.segments.length,
        visibleSegments: projection.segments.filter(segment => !segment.category.includes("Hidden")).length,
        hiddenSegments: projection.segments.filter(segment => segment.category.includes("Hidden")).length,
        sourceUnits: "millimeter",
        projection: "native-orthographic",
        projectedBoundsMm: {
          min: [0, 0],
          max: size,
          size,
        },
        curveChordToleranceMm,
        curveChordAngleDegrees,
      };
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
      await rmdir(staging).catch(() => undefined);
    }
  }

  async importStep(inputPath: string, revision?: string): Promise<RuntimeState> {
    if (revision) await this.assertRevision(revision);
    const input = await realpath(resolve(inputPath));
    if (![".step", ".stp"].includes(extname(input).toLowerCase())) throw new Error("STEP input must end in .step or .stp");
    if (!(await stat(input)).isFile()) throw new Error("STEP input must be a regular file");
    await this.runtime.mutate(`async function (Factory, Command, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.filePath = args.path;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["ExchangeImportFactory", "ImportCommand"], [{ path: input }], LONG_NATIVE_IMPORT_TIMEOUT_MS);
    return await this.state(LONG_NATIVE_IMPORT_TIMEOUT_MS);
  }

  async importSvg(
    inputPath: string,
    sourceUnit: NativeImportUnit,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    const input = await realpath(resolve(inputPath));
    if (extname(input).toLowerCase() !== ".svg") throw new Error("SVG input must end in .svg");
    const metadata = await stat(input);
    if (!metadata.isFile()) throw new Error("SVG input must be a regular file");
    if (metadata.size === 0) throw new Error("SVG input must not be empty");
    await this.runtime.mutate(`async function (Factory, Command, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.filePath = args.path;
          factory.unit = args.sourceUnit;
          const result = await factory.commit();
          const created = Array.isArray(result) ? result : [result].filter(Boolean);
          if (created.length === 0 || !created.every(item => item?.constructor?.name === 'Wire')) {
            throw new Error('Plasticity did not create editable native Wires for the complete SVG import');
          }
          return result;
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["VectorImportFactory", "ImportCommand"], [{ path: input, sourceUnit }]);
    return await this.state();
  }

  async importReferenceMesh(
    inputPath: string,
    sourceUnit: ReferenceMeshUnit,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    const input = await realpath(resolve(inputPath));
    const extension = extname(input).toLowerCase();
    if (extension !== ".stl" && extension !== ".obj") {
      throw new Error("Reference mesh input must end in .stl or .obj");
    }
    const metadata = await stat(input);
    if (!metadata.isFile()) throw new Error("Reference mesh input must be a regular file");
    if (metadata.size === 0) throw new Error("Reference mesh input must not be empty");
    await this.runtime.mutate(nativeFunction`async function (Factory, Command, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.filePath = args.path;
          factory.unit = args.sourceUnit;
          const result = await factory.commit();
          const created = Array.isArray(result) ? result : [result].filter(Boolean);
          if (created.length === 0 || !created.every(item => nativeApi.isReferenceMesh(item))) {
            throw new Error('Plasticity did not create reference mesh objects for the complete import');
          }
          return result;
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["MeshImportFactory", "ImportCommand"], [{ path: input, sourceUnit }]);
    return await this.state();
  }

  async importReference3mf(inputPath: string, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    const input = await realpath(resolve(inputPath));
    if (extname(input).toLowerCase() !== ".3mf") throw new Error("Reference mesh input must end in .3mf");
    const source = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await source.stat();
      if (!metadata.isFile()) throw new Error("Reference 3MF input must be a regular file");
      if (metadata.size === 0) throw new Error("Reference 3MF input must not be empty");
      if (metadata.size > MAX_REFERENCE_THREE_MF_ARCHIVE_BYTES) throw new Error(`Reference 3MF input exceeds ${MAX_REFERENCE_THREE_MF_ARCHIVE_BYTES} bytes`);
      const archive = Buffer.alloc(metadata.size);
      let position = 0;
      while (position < archive.length) {
        const { bytesRead } = await source.read(archive, position, archive.length - position, position);
        if (bytesRead === 0) throw new Error("Reference 3MF input changed while it was being read");
        position += bytesRead;
      }
      const overflow = Buffer.alloc(1);
      if ((await source.read(overflow, 0, 1, position)).bytesRead !== 0) throw new Error("Reference 3MF input grew beyond its validated size");
      validateReferenceThreeMfArchive(archive);
    } finally {
      await source.close();
    }
    await this.runtime.mutate(`async function (ImporterExporter, Command, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try { return await new ImporterExporter(editor).import3mf(args.path); }
        catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["ImporterExporter", "ImportCommand"], [{ path: input }], LONG_NATIVE_IMPORT_TIMEOUT_MS);
    return await this.state(LONG_NATIVE_IMPORT_TIMEOUT_MS);
  }

  async importParasolid(inputPath: string, revision?: string): Promise<RuntimeState> {
    if (revision) await this.assertRevision(revision);
    const input = await realpath(resolve(inputPath));
    const extension = extname(input).toLowerCase();
    if (extension !== ".x_t" && extension !== ".x_b") throw new Error("Parasolid input must end in .x_t or .x_b");
    await validateParasolidPath(input, "Parasolid input");
    await this.runtime.mutate(`async function (Factory, Command, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.filePath = args.path;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["ParasolidImportFactory", "ImportCommand"], [{ path: input }], LONG_NATIVE_IMPORT_TIMEOUT_MS);
    return await this.state(LONG_NATIVE_IMPORT_TIMEOUT_MS);
  }

  async saveCopy(outputPath: string): Promise<{ path: string; bytes: number }> {
    const output = resolve(outputPath);
    if (extname(output).toLowerCase() !== ".plasticity") throw new Error("Output must end in .plasticity");
    await assertAbsent(output);
    await mkdir(dirname(output), { recursive: true });
    const staging = await mkdtemp(join(dirname(output), ".plasticity-save-"));
    const temporary = join(staging, "document.plasticity");
    try {
      await this.runtime.mutate(`async function (path) { if (this.executor.isBusy) throw new Error('Plasticity is busy'); await this.saver.save(path); }`, [], [temporary]);
      const header = await readFile(temporary);
      if (header.length < 24 || header.subarray(0, 10).toString() !== "plasticity") throw new Error("Plasticity produced an invalid document");
      await copyFile(temporary, output, constants.COPYFILE_EXCL);
      return { path: output, bytes: header.length };
    } finally {
      if (!this.runtime.isUncertain()) {
        await rm(temporary, { force: true }).catch(() => undefined);
        await rmdir(staging).catch(() => undefined);
      }
    }
  }

  async openDocument(inputPath: string, backupPath: string, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    const input = await realpath(resolve(inputPath));
    if (extname(input).toLowerCase() !== ".plasticity") throw new Error("Input must end in .plasticity");
    const header = await readFile(input);
    if (header.length < 24 || header.subarray(0, 10).toString() !== "plasticity") throw new Error("Input is not a valid Plasticity document");
    await this.saveCopy(backupPath);
    const opened = await this.runtime.mutate<{ filename: string }>(`async function (args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      // A raw saver copy does not clear the native unsaved-changes prompt.
      // Save through the editor lifecycle at the explicit backup path, never
      // over the previous document. On open failure this remains the saved copy.
      this.document.filename = args.backup;
      await this.save();
      // The native open path also replaces the scene and resets document history.
      // Committing OpenFileFactory directly skips that lifecycle.
      await this.open(args.path);
      return { filename: this.document.filename };
    }`, [], [{ path: input, backup: await realpath(resolve(backupPath)) }], LONG_NATIVE_IMPORT_TIMEOUT_MS);
    if (await realpath(opened.filename) !== input) throw new Error("Plasticity did not open the requested document");
    return await this.state(LONG_NATIVE_IMPORT_TIMEOUT_MS);
  }

  async screenshot(outputPath: string, captureMode: "window" | "viewport" = "window"): Promise<{ path: string; bytes: number; captureMode?: "viewport"; freshFrame?: boolean; rendererHidden?: boolean; width?: number; height?: number }> {
    if (captureMode !== "window" && captureMode !== "viewport") throw new Error("Unsupported screenshot capture mode");
    const output = resolve(outputPath);
    if (extname(output).toLowerCase() !== ".png") throw new Error("Screenshot output must end in .png");
    await assertAbsent(output);
    await mkdir(dirname(output), { recursive: true });
    let viewport: { data: string; width: number; height: number; rendererHidden: boolean; freshFrame: boolean } | undefined;
    let frame: string;
    if (captureMode === "viewport") {
      viewport = await this.runtime.read(NATIVE_VIEWPORT_CAPTURE);
      if (!viewport || viewport.freshFrame !== true || typeof viewport.data !== "string" || typeof viewport.rendererHidden !== "boolean") {
        throw new Error("Native viewport freshness verification failed");
      }
      frame = viewport.data;
    } else {
      await this.runtime.cdp("Page.bringToFront");
      const hidden = await this.runtime.read<boolean>("function () { return document.hidden; }");
      if (hidden) throw new Error("Plasticity renderer is hidden; activate Plasticity and uncover its window, or explicitly use captureMode=viewport for a fresh WebGL frame without HTML overlays");
      frame = await this.runtime.captureScreenshot();
    }
    const data = Buffer.from(frame, "base64");
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (data.length < 24 || !data.subarray(0, 8).equals(pngSignature) || data.toString("ascii", 12, 16) !== "IHDR" ||
      data.readUInt32BE(16) < 1 || data.readUInt32BE(20) < 1) {
      throw new Error("Plasticity returned an invalid PNG screencast frame");
    }
    if (viewport && (data.readUInt32BE(16) !== viewport.width || data.readUInt32BE(20) !== viewport.height)) {
      throw new Error("Native viewport PNG dimensions do not match the rendered canvas");
    }
    await writeFile(output, data, { flag: "wx" });
    return { path: output, bytes: data.length, ...(viewport ? { captureMode: "viewport" as const, freshFrame: true, rendererHidden: viewport.rendererHidden, width: viewport.width, height: viewport.height } : {}) };
  }

  // Undo a shader/camera change an interrupted screenshot call left on the renderer (nothing happens when none is pending).
  async restorePendingScreenshotView() {
    return await this.runtime.readNative<ScreenshotViewRestored>(SCREENSHOT_VIEW_SOURCE, ["name2shader"], [{ op: "restore", tolerance: CAMERA_RESTORE_TOLERANCE }], 15_000);
  }

  // plasticity_screenshot's shader and frame options: set the analysis shader and/or aim the camera, capture, and always
  // restore both (src/plasticity/surfacing.ts). View only: the Undo depth is checked before and after.
  async screenshotView<T extends object>(options: ScreenshotViewOptions, capture: () => Promise<T>) {
    validateScreenshotView(options, options.frame ? await this.state() : undefined);
    return await withScreenshotView(this.runtime, options, capture);
  }

  // A scaled JPEG the agent can see in the same tool response; no file is written.
  async screenshotImage(maxWidth = 1024, quality = 70): Promise<{ data: string; mimeType: "image/jpeg"; width: number; height: number; bytes: number }> {
    await this.runtime.cdp("Page.bringToFront");
    const hidden = await this.runtime.read<boolean>("function () { return document.hidden; }");
    if (hidden) throw new Error("Plasticity renderer is hidden; activate Plasticity and retry the screenshot; a hidden window can still be captured by passing path with captureMode: \"viewport\"");
    const metrics = await this.runtime.cdp("Page.getLayoutMetrics") as { cssLayoutViewport?: { clientWidth?: number; clientHeight?: number } };
    const viewWidth = metrics.cssLayoutViewport?.clientWidth ?? 0;
    const viewHeight = metrics.cssLayoutViewport?.clientHeight ?? 0;
    if (!(viewWidth > 0 && viewHeight > 0)) throw new Error("Plasticity viewport size is unavailable");
    const scale = Math.min(1, maxWidth / viewWidth);
    const frame = await this.runtime.cdp("Page.captureScreenshot", {
      format: "jpeg",
      quality,
      fromSurface: true,
      clip: { x: 0, y: 0, width: viewWidth, height: viewHeight, scale },
    }) as { data?: unknown };
    if (typeof frame?.data !== "string" || frame.data.length === 0) throw new Error("Plasticity returned no screenshot image data");
    const bytes = Buffer.from(frame.data, "base64");
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Plasticity returned an invalid JPEG frame");
    return { data: frame.data, mimeType: "image/jpeg", width: Math.round(viewWidth * scale), height: Math.round(viewHeight * scale), bytes: bytes.length };
  }

  async setView(view: "front" | "back" | "left" | "right" | "top" | "bottom" | "isometric", fit: boolean): Promise<unknown> {
    return await this.runtime.read(nativeFunction`async function (args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const viewport = Array.from(this.viewports)[0];
      if (!viewport) throw new Error('Plasticity viewport is unavailable');
      if (args.view === 'isometric') {
        const camera = viewport.camera.clone();
        camera.position.copy(viewport.camera.target).add(camera.position.clone().set(1, -1, 1));
        camera.lookAt(viewport.camera.target);
        viewport.orbitControls.setQuaternion(camera.quaternion);
      } else {
        await viewport.navigateToOrientation(({ front: 4, back: 1, left: 3, right: 0, top: 2, bottom: 5 })[args.view]);
      }
      if (args.fit) {
        const bounds = [...nativeApi.geo.geometryModel].map(([, item]) => item.model?.FindBox?.()).filter(Boolean);
        if (bounds.length) {
          const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
          for (const box of bounds) for (let i = 0; i < 3; i++) {
            min[i] = Math.min(min[i], [box.min.x, box.min.y, box.min.z][i]);
            max[i] = Math.max(max[i], [box.max.x, box.max.y, box.max.z][i]);
          }
          const center = viewport.camera.target.clone().fromArray(min.map((value, i) => (value + max[i]) / 2));
          const radius = Math.max(1e-6, Math.hypot(...max.map((value, i) => value - min[i])) / 2);
          const camera = viewport.camera;
          const controls = viewport.orbitControls;
          const halfVerticalFov = camera.perspective.fov * Math.PI / 360;
          const halfHorizontalFov = Math.atan(Math.tan(halfVerticalFov) * camera.aspect);
          const limitingFov = Math.min(halfVerticalFov, halfHorizontalFov);
          const distance = limitingFov > 0 ? radius / Math.sin(limitingFov) * 1.4 : radius * 3;
          controls.target.copy(center);
          controls.targetEnd.copy(center);
          controls.focalOffset.set(0, 0, 0);
          controls.focalOffsetEnd.set(0, 0, 0);
          controls.radius = controls.radiusEnd = distance;
          const width = camera.orthographic.right - camera.orthographic.left;
          const height = camera.orthographic.top - camera.orthographic.bottom;
          const zoom = Math.min(width, height) / (radius * 2 * 1.4);
          controls.zoom = controls.zoomEnd = zoom;
          camera.zoom = zoom;
          controls.setNeedsUpdate();
          controls.update(1 / 60);
          camera.updateProjectionMatrix();
        }
      }
      viewport.setNeedsRender();
      for (const tag of this.__plasticityMcpDistanceOverlays?.values() ?? []) tag.refreshLabels?.();
      return { position: viewport.camera.position.toArray(), target: viewport.camera.target.toArray(), mode: viewport.camera.mode };
    }`, [{ view, fit }]);
  }

  // Point the viewport camera from eye toward target (millimetres) and frame a sphere of frameRadiusMm around the
  // target. View only: no document or history change.
  async setCamera(eyeMm: Vector3, targetMm: Vector3, frameRadiusMm: number): Promise<unknown> {
    if (eyeMm.every((value, index) => Math.abs(value - targetMm[index]!) < 1e-6)) throw new Error("Camera eye and target must differ");
    if (!(frameRadiusMm > 0)) throw new Error("Frame radius must be positive");
    return await this.runtime.read(`async function (args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const viewport = Array.from(this.viewports)[0];
      if (!viewport) throw new Error('Plasticity viewport is unavailable');
      const camera = viewport.camera;
      const controls = viewport.orbitControls;
      const target = camera.target.clone().fromArray(args.target);
      const eye = camera.target.clone().fromArray(args.eye);
      const aim = camera.clone();
      aim.position.copy(eye);
      aim.up.set(0, 0, 1);
      aim.lookAt(target);
      controls.setQuaternion(aim.quaternion);
      controls.target.copy(target);
      controls.targetEnd.copy(target);
      controls.focalOffset.set(0, 0, 0);
      controls.focalOffsetEnd.set(0, 0, 0);
      controls.radius = controls.radiusEnd = eye.distanceTo(target);
      const width = camera.orthographic.right - camera.orthographic.left;
      const height = camera.orthographic.top - camera.orthographic.bottom;
      const zoom = Math.min(width, height) / (args.radius * 2);
      controls.zoom = controls.zoomEnd = zoom;
      camera.zoom = zoom;
      controls.setNeedsUpdate();
      controls.update(1 / 60);
      camera.updateProjectionMatrix();
      viewport.setNeedsRender();
      return { position: camera.position.toArray(), target: camera.target.toArray(), mode: camera.mode };
    }`, [{ eye: toMeters(eyeMm), target: toMeters(targetMm), radius: millimetersToMeters(frameRadiusMm) }]);
  }

  private async assertCurveControlPointReferences(points: CurveControlPointReference[], revision: string): Promise<{
    documentToken: string;
    revision: string;
    curves: CurveControlPointDescriptor[];
  }> {
    await this.assertRevision(revision);
    if (points.length === 0) throw new Error("At least one curve control point is required");
    const keys = points.map((point) => `${point.bodyId}:${point.kind}:${point.pointId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Curve control point references must be unique");
    const bodyIds = [...new Set(points.map((point) => point.bodyId))];
    const inventory = await this.listCurveControlPoints(bodyIds, revision);
    const available = new Set(inventory.curves.flatMap((curve) => [
      ...curve.boundaryVertices.map((point) => `${curve.id}:vertex:${point.reference.pointId}`),
      ...curve.interiorControlPoints.map((point) => `${curve.id}:control-point:${point.reference.pointId}`),
    ]));
    const missing = keys.filter((key) => !available.has(key));
    if (missing.length > 0) throw new Error(`Unknown current curve control point references: ${missing.join(", ")}`);
    return inventory;
  }

  private async assertRevision(expected: string): Promise<RuntimeState> {
    const current = await this.state();
    if (current.revision !== expected) throw new Error(`Stale reference: expected revision ${expected}, current revision is ${current.revision}`);
    return current;
  }
}

// A cached state may stand in for a fresh read only when the probe shows the same revision and the same values for
// every field the revision does not hash. Body topology is immutable per body versionId, which the revision covers.
function probeMatches(probe: RevisionProbe, state: RuntimeState): boolean {
  return probe.documentToken === state.documentToken
    && probe.revision === state.revision
    && probe.viewStateToken === state.construction?.viewStateToken
    && (probe.activePlaneId ?? null) === (state.construction?.activePlaneId ?? null)
    && JSON.stringify(probe.bodyNames) === JSON.stringify(state.bodies.map((body) => [body.id, body.name]))
    && JSON.stringify(probe.regions) === JSON.stringify(state.regions);
}

function toMeters(vector: Vector3): Vector3 {
  return vector.map(millimetersToMeters) as Vector3;
}

function requirePositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number`);
}

function threePointCircleGeometry(
  first: Vector3,
  second: Vector3,
  third: Vector3,
  label: string,
): { center: Vector3; normal: Vector3 } {
  const firstToSecond = subtract(second, first);
  const firstToThird = subtract(third, first);
  const firstSquared = dot(firstToSecond, firstToSecond);
  const secondSquared = dot(firstToThird, firstToThird);
  if (firstSquared <= 1e-18 || secondSquared <= 1e-18 || dot(subtract(third, second), subtract(third, second)) <= 1e-18) {
    throw new Error(`${label} points must be distinct`);
  }
  const planeVector = cross(firstToSecond, firstToThird);
  const planeSquared = dot(planeVector, planeVector);
  if (Math.sqrt(planeSquared) <= 1e-9) throw new Error(`${label} points are collinear or too close to collinear`);
  const centerOffset = scale(add(
    scale(cross(firstToThird, planeVector), firstSquared),
    scale(cross(planeVector, firstToSecond), secondSquared),
  ), 1 / (2 * planeSquared));
  const center = add(first, centerOffset);
  return {
    center,
    normal: normalize(planeVector, `${label} plane normal`),
  };
}

function requireResolution<T>(resolution: Resolution<T>): T {
  if (resolution.status === "resolved") return resolution.value;
  if (resolution.status === "ambiguous") throw new Error(`Geometry reference is ambiguous: ${resolution.matches} matches`);
  throw new Error(resolution.reason);
}

function summarizeFaceDraftSamples(
  entry: NativeFaceDraftSamples,
  pullDirection: Vector3,
  minimumDraftDeg: number,
): FaceDraftAnalysis {
  if (entry.samples.length === 0) throw new Error(`Native face draft samples are empty for ${entry.face.bodyId}:${entry.face.faceId}`);
  const classified = entry.samples.map((sample) => {
    if (sample.positionMm.length !== 3 || !sample.positionMm.every(Number.isFinite)) {
      throw new Error(`Native face draft position is invalid for ${entry.face.bodyId}:${entry.face.faceId}`);
    }
    const normal = normalize(sample.normal, "Native face draft normal");
    const signedDraftDeg = Math.asin(Math.max(-1, Math.min(1, dot(normal, pullDirection)))) * 180 / Math.PI;
    const classification: Exclude<FaceDraftClassification, "mixed"> = signedDraftDeg >= minimumDraftDeg
      ? "positive"
      : signedDraftDeg <= -minimumDraftDeg
        ? "negative"
        : "neutral";
    return { positionMm: sample.positionMm, normal, signedDraftDeg, classification };
  });
  let minimum = classified[0]!;
  let maximum = classified[0]!;
  let minimumAbsoluteDraftDeg = Math.abs(classified[0]!.signedDraftDeg);
  let maximumAbsoluteDraftDeg = minimumAbsoluteDraftDeg;
  const sampleCounts = { positive: 0, negative: 0, neutral: 0 };
  for (const sample of classified) {
    if (sample.signedDraftDeg < minimum.signedDraftDeg) minimum = sample;
    if (sample.signedDraftDeg > maximum.signedDraftDeg) maximum = sample;
    minimumAbsoluteDraftDeg = Math.min(minimumAbsoluteDraftDeg, Math.abs(sample.signedDraftDeg));
    maximumAbsoluteDraftDeg = Math.max(maximumAbsoluteDraftDeg, Math.abs(sample.signedDraftDeg));
    sampleCounts[sample.classification] += 1;
  }
  const occupied = (Object.keys(sampleCounts) as Array<keyof typeof sampleCounts>).filter((key) => sampleCounts[key] > 0);
  const classification: FaceDraftClassification = occupied.length === 1 ? occupied[0]! : "mixed";
  return {
    face: entry.face,
    bodyVersionId: entry.bodyVersionId,
    surfaceType: entry.surfaceType,
    measurementSource: "native-brep-face-normal-grid",
    classification,
    sampleCount: classified.length,
    sampleCounts,
    minimumSignedDraft: { valueDeg: minimum.signedDraftDeg, positionMm: minimum.positionMm, normal: minimum.normal },
    maximumSignedDraft: { valueDeg: maximum.signedDraftDeg, positionMm: maximum.positionMm, normal: maximum.normal },
    minimumAbsoluteDraftDeg,
    maximumAbsoluteDraftDeg,
  };
}

function leastParallelWorldAxis(normal: Vector3): Vector3 {
  const axes: Vector3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  return axes.reduce((best, candidate) => Math.abs(dot(candidate, normal)) < Math.abs(dot(best, normal)) ? candidate : best);
}

function requireVertexReference(state: RuntimeState, reference: VertexReference, name: string): void {
  const body = state.bodies.find((candidate) => candidate.id === reference.bodyId);
  if (!body?.vertices?.some((vertex) => vertex.id === reference.vertexId)) {
    throw new Error(`${name} must reference a current native B-Rep vertex`);
  }
}

function requireInstanceIds(state: RuntimeState, ids: number[]): void {
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error("Instance IDs must be a nonempty unique list");
  }
  const current = new Set((state.instances ?? []).map((instance) => instance.id));
  const missing = ids.filter((id) => !current.has(id));
  if (missing.length > 0) throw new Error(`Unknown current native instance IDs: ${missing.join(", ")}`);
}

function requireReferenceMeshIds(state: RuntimeState, ids: number[]): void {
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error("Reference mesh IDs must be a nonempty unique list");
  }
  const current = new Set((state.referenceMeshes ?? []).map((mesh) => mesh.id));
  const missing = ids.filter((id) => !current.has(id));
  if (missing.length > 0) throw new Error(`Unknown current reference mesh IDs: ${missing.join(", ")}`);
}

function requireGroupIds(state: RuntimeState, ids: number[], allowRoot: boolean): void {
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error("Group IDs must be a nonempty unique list");
  }
  if (!allowRoot && ids.includes(0)) throw new Error("The root Scene group is protected");
  const current = new Set((state.groups ?? []).map((group) => group.id));
  const missing = ids.filter((id) => !current.has(id));
  if (missing.length > 0) throw new Error(`Unknown current group IDs: ${missing.join(", ")}`);
}

function requireGroupSelection(
  state: RuntimeState,
  bodyIds: number[],
  instanceIds: number[],
  referenceMeshIds: number[],
  groupIds: number[],
  allowRoot = false,
): void {
  if (bodyIds.length + instanceIds.length + referenceMeshIds.length + groupIds.length === 0) {
    throw new Error("A group operation requires at least one body, instance, reference mesh, or group ID");
  }
  if (new Set(bodyIds).size !== bodyIds.length) throw new Error("Body IDs must be unique");
  if (new Set(instanceIds).size !== instanceIds.length) throw new Error("Instance IDs must be unique");
  if (new Set(referenceMeshIds).size !== referenceMeshIds.length) throw new Error("Reference mesh IDs must be unique");
  if (new Set(groupIds).size !== groupIds.length) throw new Error("Group IDs must be unique");
  const currentBodies = new Set(state.bodies.map((body) => body.id));
  const missingBodies = bodyIds.filter((id) => !currentBodies.has(id));
  if (missingBodies.length > 0) throw new Error(`Unknown current body IDs: ${missingBodies.join(", ")}`);
  if (instanceIds.length > 0) requireInstanceIds(state, instanceIds);
  if (referenceMeshIds.length > 0) requireReferenceMeshIds(state, referenceMeshIds);
  if (groupIds.length > 0) requireGroupIds(state, groupIds, allowRoot);
}

function requireMeshExportBodies(state: RuntimeState, ids: number[], format = "3MF"): void {
  if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error(`${format} body IDs must be a nonempty unique list`);
  const bodies = new Map(state.bodies.map((body) => [body.id, body]));
  const missing = ids.filter((id) => !bodies.has(id));
  if (missing.length > 0) throw new Error(`Unknown current body IDs: ${missing.join(", ")}`);
  const invalid = ids.filter((id) => {
    const type = bodies.get(id)!.type;
    return type !== "Solid" && type !== "Sheet";
  });
  if (invalid.length > 0) throw new Error(`${format} export requires current Solid or Sheet bodies: ${invalid.join(", ")}`);
}

function formatSvgNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("SVG coordinates must be finite");
  const rounded = Number(value.toFixed(12));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function escapeSvgAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("'", "&apos;");
}

function requireSweepGuides(
  state: RuntimeState,
  guideIds: number[],
  spineId: number,
  profileWireIds: number[],
  guideMethod: SweepGuideMethodName | undefined,
): void {
  if (new Set(guideIds).size !== guideIds.length) throw new Error("Sweep guide IDs must be unique");
  const wires = new Set(state.bodies.filter((body) => body.type === "Wire").map((body) => body.id));
  const invalid = guideIds.filter((id) => !wires.has(id));
  if (invalid.length > 0) throw new Error(`Sweep guides must be current Wire IDs: ${invalid.join(", ")}`);
  if (guideIds.includes(spineId)) throw new Error("Sweep guide must not be the spine");
  if (guideIds.some((id) => profileWireIds.includes(id))) throw new Error("Sweep guide must not be one of the profile curves");
  if (guideMethod !== undefined && !(guideMethod in SWEEP_GUIDE_METHODS)) {
    throw new Error(`Sweep guide method must be one of: ${Object.keys(SWEEP_GUIDE_METHODS).join(", ")}`);
  }
}

function requireWireBodyIds(state: RuntimeState, ids: number[]): void {
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error("Wire IDs must be a nonempty unique list");
  }
  const bodies = new Map(state.bodies.map((body) => [body.id, body]));
  const missing = ids.filter((id) => !bodies.has(id));
  if (missing.length > 0) throw new Error(`Unknown current Wire ID: ${missing.join(", ")}`);
  const invalid = ids.filter((id) => bodies.get(id)!.type !== "Wire");
  if (invalid.length > 0) throw new Error(`Curve selection accepts current Wire IDs only: ${invalid.join(", ")}`);
}

function requireHiddenLineBodies(state: RuntimeState, ids: number[]): void {
  if (ids.length === 0 || ids.length > 128 || new Set(ids).size !== ids.length) {
    throw new Error("Hidden-line body IDs must be a nonempty unique list of at most 128 bodies");
  }
  const bodies = new Map(state.bodies.map((body) => [body.id, body]));
  const missing = ids.filter((id) => !bodies.has(id));
  if (missing.length > 0) throw new Error(`Unknown current body IDs: ${missing.join(", ")}`);
  const invalid = ids.filter((id) => bodies.get(id)!.type !== "Solid");
  if (invalid.length > 0) throw new Error(`Hidden-line export requires current native Solid bodies: ${invalid.join(", ")}`);
}

function requireCadExportBodies(state: RuntimeState, ids: number[], format: string): void {
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error(`${format} body IDs must be a nonempty unique list`);
  }
  const current = new Set(state.bodies.map((body) => body.id));
  const missing = ids.filter((id) => !current.has(id));
  if (missing.length > 0) throw new Error(`Unknown current body IDs: ${missing.join(", ")}`);
}

async function validateParasolidPath(path: string, label: string): Promise<number> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const file = await handle.stat();
    if (!file.isFile()) throw new Error(`${label} must be a regular file`);
    const bytes = Buffer.alloc(Math.min(file.size, 512));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const header = bytes.subarray(0, bytesRead).toString("latin1");
    if (file.size < 96 || !header.startsWith("**") || !header.includes("PARASOLID")) {
      throw new Error("Plasticity produced or received an invalid Parasolid file");
    }
    return file.size;
  } finally {
    await handle.close();
  }
}

async function readFirstLine(path: string, label: string, format: string): Promise<{ bytes: number; line: string }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`Plasticity wrote no ${format} file`);
    throw error;
  });
  try {
    const file = await handle.stat();
    if (!file.isFile()) throw new Error(`${label} must be a regular file`);
    const buffer = Buffer.alloc(Math.min(file.size, 512));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { bytes: file.size, line: buffer.subarray(0, bytesRead).toString("latin1").split(/\r?\n/u, 1)[0]! };
  } finally {
    await handle.close();
  }
}

// ---- Chamfer read-back.

/** What CHAMFER_SOURCE returns: the factory's chamfered edge chain and [faceId, entityId] of every face before and after. */
export interface ChamferNativeEvidence {
  chain: string[] | null;
  chainError?: string | null;
  facesBefore: Array<[string, number]>;
  facesAfter: Array<[string, number]>;
}

export interface ChamferFaceCheck {
  /** The distinct edge IDs the caller selected. */
  selected: string[];
  /** Every edge the factory chamfered: the selection plus its tangent chain (only the selection when the factory gave no chain). */
  chained: string[];
  chainSource: "factory" | "selection";
  /** Faces of the result with a topology identity (entityId) the body did not have before. */
  newFaces: string[];
  /** Chained edge -> the distinct new face assigned to it. */
  matched: Array<{ edgeId: string; faceId: string }>;
  /** Chained edges no distinct new face could be assigned to. Empty means the check found nothing wrong. */
  missing: string[];
  /** Set when the evidence does not cover the bodies' faces; then nothing is claimed and missing is empty. */
  noClaim?: string;
}

type CheckedBody = RuntimeState["bodies"][number];

/**
 * Proves, for a chamfer Plasticity answered OK: every edge the factory chamfered (the selection plus the tangent chain
 * it adds) has its own new face (a face whose topology identity the body did not have before) that shares an edge with
 * one of the edge's original faces that survived, or any new face when neither survived. The assignment is a maximum
 * matching, so N chained edges need N distinct new faces. It does not prove the distance or the shape of a face: a
 * chamfer whose faces all exist but sit at the wrong distance passes, and so would a missing chamfer face whose place a
 * face the chamfer split off an old face happened to take (not seen live). A new face on the plane of an older face is
 * still new (a second chamfer in line with an earlier one is on the same plane).
 */
export function chamferFaceCheck(beforeBody: CheckedBody, afterBody: CheckedBody, evidence: ChamferNativeEvidence, selectedIds: string[]): ChamferFaceCheck {
  const selected = [...new Set(selectedIds)];
  const factoryChain = Array.isArray(evidence.chain) && evidence.chain.length > 0 ? evidence.chain.map(String) : null;
  const chained = [...new Set([...selected, ...(factoryChain ?? [])])];
  const base = { selected, chained, chainSource: factoryChain ? "factory" as const : "selection" as const };
  const identityBefore = new Map(evidence.facesBefore ?? []);
  const identityAfter = new Map(evidence.facesAfter ?? []);
  const uncovered = [...beforeBody.faces.filter((face) => !identityBefore.has(face.id)), ...afterBody.faces.filter((face) => !identityAfter.has(face.id))];
  if (uncovered.length > 0 || beforeBody.faces.length === 0 || afterBody.faces.length === 0) {
    return { ...base, newFaces: [], matched: [], missing: [], noClaim: "the native face identities do not cover the bodies' faces" };
  }
  const oldEntities = new Set(beforeBody.faces.map((face) => identityBefore.get(face.id)!));
  const newFaces = afterBody.faces.filter((face) => !oldEntities.has(identityAfter.get(face.id)!));
  const newIds = new Set(newFaces.map((face) => face.id));
  const neighbours = new Map<string, Set<string>>();
  for (const edge of afterBody.edges) {
    for (const faceId of edge.faceIds) {
      const set = neighbours.get(faceId) ?? new Set<string>();
      for (const other of edge.faceIds) if (other !== faceId) set.add(other);
      neighbours.set(faceId, set);
    }
  }
  const afterByEntity = new Map(afterBody.faces.map((face) => [identityAfter.get(face.id)!, face.id]));
  const candidates = new Map<string, { strong: string[]; weak: string[] }>();
  for (const edgeId of chained) {
    const original = beforeBody.edges.find((edge) => edge.id === edgeId)?.faceIds ?? [];
    const survivors = original.flatMap((faceId) => { const after = afterByEntity.get(identityBefore.get(faceId)!); return after === undefined ? [] : [after]; });
    const all = newFaces.map((face) => face.id);
    if (survivors.length === 0) { candidates.set(edgeId, { strong: all, weak: all }); continue; }
    const touches = (faceId: string, survivor: string) => neighbours.get(faceId)?.has(survivor) === true;
    candidates.set(edgeId, {
      strong: all.filter((faceId) => survivors.every((survivor) => touches(faceId, survivor))),
      weak: all.filter((faceId) => survivors.some((survivor) => touches(faceId, survivor))),
    });
  }
  // Kuhn's augmenting paths: first over faces touching every surviving original face, then over faces touching one.
  const owner = new Map<string, string>();
  const assign = (edgeId: string, pool: "strong" | "weak", seen: Set<string>): boolean => {
    for (const faceId of candidates.get(edgeId)![pool]) {
      if (seen.has(faceId)) continue;
      seen.add(faceId);
      const holder = owner.get(faceId);
      if (holder === undefined || assign(holder, pool, seen)) { owner.set(faceId, edgeId); return true; }
    }
    return false;
  };
  const order = [...chained].sort((a, b) => candidates.get(a)!.strong.length - candidates.get(b)!.strong.length);
  const placed = new Set<string>();
  for (const pool of ["strong", "weak"] as const) {
    for (const edgeId of order) if (!placed.has(edgeId) && assign(edgeId, pool, new Set())) placed.add(edgeId);
  }
  const matched = [...owner.entries()].map(([faceId, edgeId]) => ({ edgeId, faceId }));
  return { ...base, newFaces: [...newIds], matched, missing: chained.filter((edgeId) => !placed.has(edgeId)) };
}

// Same bodies, each at the same native version with the same faces and edges.
function sameBodies(a: RuntimeState, b: RuntimeState): boolean {
  if (a.bodies.length !== b.bodies.length) return false;
  const key = (body: CheckedBody) => JSON.stringify([body.id, body.versionId, [...body.faceIds].sort(), [...body.edgeIds].sort()]);
  const left = new Set(a.bodies.map(key));
  return b.bodies.every((body) => left.has(key(body)));
}

// ---- CAD export header privacy. The native exporters stamp the staging path and the OS user name into the file
// header. Each rewrite below touches the header only; the model data after it stays byte-identical.

// A STEP string literal: ' doubles to '', \ doubles to \\, characters outside ASCII use \X2\....\X0\.
function stepString(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "'") out += "''";
    else if (char === "\\") out += "\\\\";
    else if (code >= 0x20 && code < 0x7f) out += char;
    else if (code <= 0xffff) out += `\\X2\\${code.toString(16).toUpperCase().padStart(4, "0")}\\X0\\`;
    else out += `\\X4\\${code.toString(16).toUpperCase().padStart(8, "0")}\\X0\\`;
  }
  return `'${out}'`;
}

// Rewrites FILE_NAME(name, time, (author), (organisation), ...) in the STEP header: the name becomes the output
// file's base name; author and organisation become empty strings. Text from DATA; on is returned unchanged.
export function sanitizeStepHeader(text: string, outputBaseName: string): string {
  const headerStart = text.indexOf("HEADER;");
  const headerEnd = text.indexOf("ENDSEC;", headerStart < 0 ? 0 : headerStart);
  if (headerStart < 0 || headerEnd < 0) return text;
  const header = text.slice(headerStart, headerEnd);
  const open = /\bFILE_NAME\s*\(/u.exec(header);
  if (!open) return text;
  const argsStart = open.index + open[0].length;
  const args: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let quoted = false;
  let from = argsStart;
  let close = -1;
  for (let index = argsStart; index < header.length; index += 1) {
    const char = header[index]!;
    if (quoted) { if (char === "'") quoted = false; continue; }
    if (char === "'") quoted = true;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      if (depth === 0) { args.push({ start: from, end: index }); close = index; break; }
      depth -= 1;
    } else if (char === "," && depth === 0) { args.push({ start: from, end: index }); from = index + 1; }
  }
  if (close < 0 || args.length < 4) return text; // not a FILE_NAME this can rewrite; sanitizeCadExport still refuses a leaked staging path
  const replacements = new Map([[0, stepString(outputBaseName)], [2, "('')"], [3, "('')"]]);
  let rewritten = "";
  let cursor = argsStart;
  args.forEach((arg, index) => {
    const replacement = replacements.get(index);
    if (replacement === undefined) return;
    const raw = header.slice(arg.start, arg.end);
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    rewritten += header.slice(cursor, arg.start + lead) + replacement;
    cursor = arg.end - trail;
  });
  rewritten += header.slice(cursor);
  return text.slice(0, headerStart) + header.slice(0, argsStart) + rewritten + text.slice(headerEnd);
}

// IGES: the Global section's parameter 4 is the file name Plasticity filled with the staging path. It is replaced by
// the output file's base name, the Global section is wrapped again by the IGES 5.3 rules (sections 2.2.2 and 2.2.3)
// and the Terminate record's G count is updated. Start, Directory and Parameter lines are returned unchanged.
export function sanitizeIgesGlobal(text: string, outputBaseName: string): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(newline);
  const globalIndexes = lines.flatMap((line, index) => line.length >= 73 && line[72] === "G" ? [index] : []);
  if (globalIndexes.length === 0) return text;
  const first = globalIndexes[0]!;
  const last = globalIndexes[globalIndexes.length - 1]!;
  if (last - first + 1 !== globalIndexes.length) return text;
  // Columns 1-72 of every Global line in order. A string that crosses a line runs to column 72, so joining the data
  // columns gives the parameter text back; blanks a writer padded a line with only sit between parameters.
  const stream = globalIndexes.map((index) => lines[index]!.slice(0, 72).padEnd(72, " ")).join("");
  // Parameters 1 and 2 are the delimiters; Plasticity writes the defaults (1H, and 1H;). Other delimiters are left alone
  // (the staging-path guard still applies).
  if (!stream.startsWith("1H,,1H;,")) return text;
  const fields: Array<{ text: string; string: boolean }> = [{ text: "1H,", string: true }, { text: "1H;", string: true }];
  let position = "1H,,1H;,".length;
  for (;;) {
    while (stream[position] === " ") position += 1; // blanks only count inside strings
    const hollerith = /^(\d+)H/u.exec(stream.slice(position, position + 16));
    if (hollerith) {
      const end = position + hollerith[0].length + Number(hollerith[1]);
      if (end > stream.length) return text;
      fields.push({ text: stream.slice(position, end), string: true });
      position = end;
      while (stream[position] === " ") position += 1;
    } else {
      let end = position;
      while (end < stream.length && stream[end] !== "," && stream[end] !== ";") end += 1;
      fields.push({ text: stream.slice(position, end).trim(), string: false });
      position = end;
    }
    if (stream[position] === ",") { position += 1; continue; }
    if (stream[position] === ";") break;
    return text; // no record delimiter: not a Global section this can rewrite
  }
  if (fields.length < 4 || stream.slice(position + 1).trim() !== "") return text;
  const name = outputBaseName.replace(/[^\x20-\x7e]/gu, "_");
  fields[3] = { text: `${name.length}H${name}`, string: true };
  if (fields.some((field) => !field.string && field.text.length + 1 > 72)) return text; // cannot be laid out by the rules
  const globalLines = wrapIgesGlobal(fields.map((field, index) => ({ token: `${field.text}${index === fields.length - 1 ? ";" : ","}`, string: field.string })))
    .map((data, index) => `${data.padEnd(72, " ")}G${String(index + 1).padStart(7, " ")}`);
  const terminate = lines.findIndex((line) => line.length >= 73 && line[72] === "T");
  const result = [...lines.slice(0, first), ...globalLines, ...lines.slice(last + 1)];
  if (terminate >= 0) {
    const shifted = terminate - globalIndexes.length + globalLines.length;
    const record = result[shifted]!;
    // The Terminate record is S, G, D and P, each a letter and a 7-column count, in columns 1-32.
    result[shifted] = record[8] === "G"
      ? `${record.slice(0, 8)}G${String(globalLines.length).padStart(7, " ")}${record.slice(16)}`
      : `${record.slice(0, 72).replace(/G\s*\d+/u, `G${String(globalLines.length).padStart(7, " ")}`).slice(0, 72).padEnd(72, " ")}${record.slice(72)}`;
  }
  return result.join(newline);
}

// Lays parameter tokens (a parameter and its delimiter) on 72-column lines. A numeric or empty parameter and its
// delimiter never cross a line (2.2.3: a numeric field ends at least one column before the last data column). A string
// stays whole on one line when it fits on a line; a longer one starts where its count and H fit on the line, runs to
// column 72 and continues in column 1 (2.2.2), and starts on a new line instead when that keeps its delimiter off a line
// of its own.
function wrapIgesGlobal(tokens: Array<{ token: string; string: boolean }>): string[] {
  const out: string[] = [];
  let line = "";
  const flush = () => { out.push(line); line = ""; };
  for (const { token, string } of tokens) {
    if (line.length + token.length <= 72) { line += token; continue; }
    if (!string || token.length <= 72) { flush(); line = token; continue; }
    const head = /^\d+H/u.exec(token)![0].length;
    if (72 - line.length < head + 1 || (line.length > 0 && (line.length + token.length) % 72 === 1)) flush();
    let rest = token;
    while (line.length + rest.length > 72) {
      const room = 72 - line.length;
      line += rest.slice(0, room);
      rest = rest.slice(room);
      flush();
    }
    line += rest;
  }
  if (line.length > 0) flush();
  return out;
}

// Parasolid text and binary files carry a text header ending at **END_OF_HEADER. KEY= and FILE= hold the staging
// path; they become the output name. Everything from **END_OF_HEADER on is returned unchanged.
export function sanitizeParasolidHeader(content: Buffer, outputBaseName: string): Buffer {
  const marker = content.indexOf("**END_OF_HEADER");
  if (marker < 0) return content;
  const header = content.subarray(0, marker).toString("latin1");
  const name = outputBaseName.replace(/[^\x20-\x7e]|;/gu, "_");
  const stem = name.replace(/\.[^.]*$/u, "");
  const rewritten = header
    .replace(/^KEY=[^\r\n]*$/mu, () => `KEY=${stem};`)
    .replace(/^FILE=[^\r\n]*$/mu, () => `FILE=${name};`);
  return Buffer.concat([Buffer.from(rewritten, "latin1"), content.subarray(marker)]);
}

export type CadExportFormat = "step" | "iges" | "parasolid";

// Rewrites the staged file's header in place, then refuses a file that still names the staging folder.
async function sanitizeCadExport(temporary: string, staging: string, format: CadExportFormat, outputBaseName: string): Promise<void> {
  let original: Buffer;
  try {
    original = await readFile(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // the format check that follows names the missing file
    throw error;
  }
  const cleaned = format === "parasolid"
    ? sanitizeParasolidHeader(original, outputBaseName)
    : Buffer.from((format === "step" ? sanitizeStepHeader : sanitizeIgesGlobal)(original.toString("latin1"), outputBaseName), "latin1");
  if (cadExportNamesFolder(cleaned, staging, format)) throw new Error(`The ${format} export still names its staging folder; the export was not written`);
  if (!cleaned.equals(original)) await writeFile(temporary, cleaned);
}

// STEP text with its string escapes decoded (ISO 10303-21: '' and \\, \S\c for a character above 127, \X\hh, \X2\..\X0\
// and \X4\..\X0\ for UTF-16 and UTF-32 code units) and line breaks removed, so a path reads as the folder name it encodes.
function decodeStepText(text: string): string {
  // One left-to-right pass, so an escaped backslash is never read as the start of another escape.
  return text.replace(/\r?\n/gu, "").replace(/\\\\|''|\\X2\\((?:[0-9A-F]{4})+)\\X0\\|\\X4\\((?:[0-9A-F]{8})+)\\X0\\|\\X\\([0-9A-F]{2})|\\S\\(.)|\\P[A-I]\\/giu,
    (match: string, x2?: string, x4?: string, x?: string, s?: string) => {
      if (match === "\\\\") return "\\";
      if (match === "''") return "'";
      if (x2) return String.fromCharCode(...x2.match(/.{4}/gu)!.map((unit) => parseInt(unit, 16)));
      if (x4) return String.fromCodePoint(...x4.match(/.{8}/gu)!.map((unit) => parseInt(unit, 16)));
      if (x) return String.fromCharCode(parseInt(x, 16));
      if (s) return String.fromCharCode(s.charCodeAt(0) + 128);
      return ""; // \P?\ code-page directive
    });
}

/**
 * Whether an export file still names the staging folder, compared as bytes: the folder's UTF-8 bytes anywhere (what
 * Parasolid writes), and the file's own encoding of it. STEP is compared after its string escapes are decoded (the
 * exporter writes \S\ and \X2\ escapes); IGES Global text is compared with lines unwrapped at column 72 and every
 * non-ASCII byte as a blank (the IGES exporter writes each byte of a non-ASCII character as a space).
 */
export function cadExportNamesFolder(content: Buffer, folder: string, format: CadExportFormat): boolean {
  const utf8 = Buffer.from(folder, "utf8");
  if (content.includes(utf8)) return true;
  if (format === "step") return decodeStepText(content.toString("latin1")).includes(folder);
  if (format === "iges") {
    const blanked = Buffer.from(utf8.map((byte) => (byte >= 0x80 ? 0x20 : byte)));
    const lines = content.toString("latin1").split(/\r?\n/u);
    const unwrapped = Buffer.from(lines.map((line) => line.slice(0, 72)).join(""), "latin1");
    return content.includes(blanked) || unwrapped.includes(utf8) || unwrapped.includes(blanked);
  }
  return false;
}

// IGES fixed-format lines are 80 columns wide; column 73 holds the section letter and the first line is in the Start section.
async function validateIgesPath(path: string, label: string): Promise<number> {
  const { bytes, line } = await readFirstLine(path, label, "IGES");
  if (bytes === 0 || line.length < 73 || line[72] !== "S") throw new Error("Plasticity produced an invalid IGES file");
  return bytes;
}

// ACIS SAT files start with four integers: version, record count, entity count, and flags.
async function validateSatPath(path: string, label: string): Promise<number> {
  const { bytes, line } = await readFirstLine(path, label, "SAT");
  if (bytes === 0 || !/^\d+ \d+ \d+ \d+\s*$/u.test(line)) throw new Error("Plasticity produced an invalid SAT file");
  return bytes;
}

function groupContains(state: RuntimeState, ancestorId: number, candidateId: number): boolean {
  const groups = new Map((state.groups ?? []).map((group) => [group.id, group]));
  const pending = [...(groups.get(ancestorId)?.childGroupIds ?? [])];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === candidateId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(groups.get(current)?.childGroupIds ?? []));
  }
  return false;
}

function requireTopologySelection(
  state: RuntimeState,
  references: FaceReference[] | EdgeReference[],
  kind: "face" | "edge",
): void {
  if (references.length === 0) throw new Error(`At least one ${kind} reference is required`);
  const keys = references.map((reference) => `${reference.bodyId}:${kind === "face" ? (reference as FaceReference).faceId : (reference as EdgeReference).edgeId}`);
  if (new Set(keys).size !== keys.length) throw new Error(`${kind === "face" ? "Face" : "Edge"} references must be unique`);
  const missing = references.filter((reference) => {
    const body = state.bodies.find((candidate) => candidate.id === reference.bodyId);
    const id = kind === "face" ? (reference as FaceReference).faceId : (reference as EdgeReference).edgeId;
    return !body || !(kind === "face" ? body.faceIds : body.edgeIds).includes(id);
  });
  if (missing.length > 0) throw new Error(`Unknown current ${kind} references: ${missing.map((reference) => reference.bodyId).join(", ")}`);
}

function requireSingleTopologyBody(references: FaceReference[] | EdgeReference[], label: string): void {
  if (new Set(references.map((reference) => reference.bodyId)).size !== 1) {
    throw new Error(`${label} must belong to one body`);
  }
}

function assertRefreshIdentity(
  record: DatumReference,
  supplied: ReferenceIdentity,
  sessionId: string,
  documentToken: string,
): void {
  if (supplied.sessionId !== sessionId || record.sessionId !== supplied.sessionId) {
    throw new Error("Datum reference belongs to another MCP session");
  }
  if (supplied.documentToken !== documentToken || record.documentToken !== supplied.documentToken) {
    throw new Error("Datum reference belongs to another Plasticity document");
  }
  if (record.id !== supplied.id || record.revision !== supplied.revision) {
    throw new Error(`Stale datum reference identity: ${supplied.id}`);
  }
}

function nearlyParallel(left: Vector3, right: Vector3): boolean {
  const leftLength = Math.hypot(...left);
  const rightLength = Math.hypot(...right);
  const cosine = Math.abs(left.reduce((sum, value, index) => sum + value * right[index]!, 0) / (leftLength * rightLength));
  return cosine > 0.999_999;
}

function vectorsNear(left: Vector3, right: Vector3, tolerance = 1e-12): boolean {
  return left.every((value, index) => Math.abs(value - right[index]!) <= tolerance);
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Refusing to overwrite existing file: ${path}`);
}

function validateBinaryStl(data: Buffer): number {
  if (data.length < 84) throw new Error("Plasticity produced an invalid binary STL file");
  const triangles = data.readUInt32LE(80);
  if (data.length !== 84 + triangles * 50) throw new Error("Plasticity produced a truncated or malformed binary STL file");
  return triangles;
}
