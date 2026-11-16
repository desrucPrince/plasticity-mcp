// Fastener values that carry a recorded source and confidence (researched 2026-11-16). Nothing here is a guess: a value
// that is not in these tables is refused with a message that says it is not sourced, and the caller must supply it.
// The clearance holes follow the ISO 273 pattern as two chart pages cite it; they are not read from the standard.

export type ScrewSize = "M2" | "M2.5" | "M3";
export type ClearanceFit = "close" | "medium" | "free";
export type PresetConfidence = "medium";

export const SCREW_SIZES: readonly ScrewSize[] = ["M2", "M2.5", "M3"];
export const CLEARANCE_FITS: readonly ClearanceFit[] = ["close", "medium", "free"];

export const CLEARANCE_HOLE_SOURCE = "ISO 273 clearance holes (close, medium, free) following the ISO 273 pattern as cited by two chart pages, not the standard itself: amesweb.info/screws/Metric-Clearance-Hole-Chart.aspx (ASME B18.2.8-based chart) and fmcarbide.com/pages/clearance-hole-chart (cites ISO 273 / ASME B18.2.8) (researched 2026-11-16)";
export const HEAT_SET_INSERT_SOURCE = "CNC Kitchen, Heat-Set Insert Dimensions and Design Guidelines, cnckitchen.com/s/CNCKitchen_Heat-Set-Insert-Dimensions-and-Design-Guidelines.pdf (CNC Kitchen inserts only; researched 2026-11-16)";
export const COUNTERSUNK_HEAD_SOURCE = "ISO 10642 hexagon socket countersunk head screws, engineersedge.com/hardware/bs_en_iso_10642_14583.htm (researched 2026-11-16)";
// Notes returned with the preset table.
export const COUNTERSUNK_HEAD_NOTE = "6.72 mm is the theoretical sharp-corner head diameter (dk theoretical max. in ISO 10642), not a measured head; the countersink is cut to it.";
export const HEAT_SET_INSERT_NOTE = "The CNC Kitchen sheet lists three M3 inserts; this table holds two of them (M3 x 5.7 and M3 x 3). M3 x 5 x 4 VORON (length 4, hole 4.4) is not in the table.";
export const CALLER_SOURCE = "caller-supplied (not sourced by this server)";

const CLEARANCE_HOLES_MM: Record<ScrewSize, Record<ClearanceFit, number>> = {
  "M2": { close: 2.2, medium: 2.4, free: 2.6 },
  "M2.5": { close: 2.7, medium: 2.9, free: 3.1 },
  "M3": { close: 3.2, medium: 3.4, free: 3.6 },
};

interface InsertRow { screw: ScrewSize; insertLengthMm: number; holeDiameterMm: number; minWallMm: number }
// The CNC Kitchen sheet lists three M3 inserts; this table holds two of them (M3 x 5.7 and M3 x 3). The third,
// M3 x 5 x 4 VORON (length 4, hole 4.4), is not in the table, so it is refused as not sourced here.
const HEAT_SET_INSERTS: readonly InsertRow[] = [
  { screw: "M2", insertLengthMm: 3, holeDiameterMm: 3.2, minWallMm: 1.3 },
  { screw: "M2.5", insertLengthMm: 4, holeDiameterMm: 4.0, minWallMm: 1.6 },
  { screw: "M3", insertLengthMm: 5.7, holeDiameterMm: 4.0, minWallMm: 1.6 },
  { screw: "M3", insertLengthMm: 3, holeDiameterMm: 4.0, minWallMm: 1.6 },
];
// CNC Kitchen: the blind hole is the insert length plus 1 mm.
const INSERT_BLIND_HOLE_EXTRA_MM = 1;

const COUNTERSUNK_HEADS: Partial<Record<ScrewSize, { headDiameterMaxMm: number; includedAngleDeg: number }>> = {
  "M3": { headDiameterMaxMm: 6.72, includedAngleDeg: 90 },
};

export class UnsourcedFastenerValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsourcedFastenerValueError";
  }
}

export interface SourcedClearanceHole {
  screw: ScrewSize;
  fit: ClearanceFit;
  diameterMm: number;
  source: string;
  confidence: PresetConfidence;
}

export interface SourcedHeatSetInsert {
  screw: ScrewSize;
  insert: string;
  insertLengthMm: number;
  holeDiameterMm: number;
  minWallMm: number;
  blindHoleDepthMm: number;
  source: string;
  confidence: PresetConfidence;
}

export interface SourcedCountersunkHead {
  screw: ScrewSize;
  headDiameterMaxMm: number;
  includedAngleDeg: number;
  source: string;
  confidence: PresetConfidence;
}

export function clearanceHole(screw: ScrewSize, fit: ClearanceFit = "medium"): SourcedClearanceHole {
  const row = CLEARANCE_HOLES_MM[screw];
  if (!row) throw new UnsourcedFastenerValueError(`No sourced clearance hole for ${String(screw)}; sourced sizes: ${SCREW_SIZES.join(", ")}`);
  return { screw, fit, diameterMm: row[fit], source: CLEARANCE_HOLE_SOURCE, confidence: "medium" };
}

// insertLengthMm picks among the CNC Kitchen inserts of that thread. M3 has two (5.7 and 3 mm), so it must be named.
export function heatSetInsert(screw: ScrewSize, insertLengthMm?: number): SourcedHeatSetInsert {
  const rows = HEAT_SET_INSERTS.filter((row) => row.screw === screw);
  if (rows.length === 0) throw new UnsourcedFastenerValueError(`No sourced heat-set insert for ${String(screw)}`);
  const lengths = rows.map((row) => row.insertLengthMm).join(" or ");
  let row: InsertRow | undefined;
  if (insertLengthMm === undefined) {
    if (rows.length > 1) throw new UnsourcedFastenerValueError(`${screw} has ${rows.length} sourced CNC Kitchen inserts; pass insertLengthMm ${lengths}`);
    row = rows[0];
  } else {
    row = rows.find((candidate) => Math.abs(candidate.insertLengthMm - insertLengthMm) < 1e-9);
    if (!row) throw new UnsourcedFastenerValueError(`No sourced CNC Kitchen ${screw} insert ${insertLengthMm} mm long; sourced lengths: ${lengths}`);
  }
  return {
    screw,
    insert: `${screw}x${row!.insertLengthMm}`,
    insertLengthMm: row!.insertLengthMm,
    holeDiameterMm: row!.holeDiameterMm,
    minWallMm: row!.minWallMm,
    blindHoleDepthMm: round(row!.insertLengthMm + INSERT_BLIND_HOLE_EXTRA_MM),
    source: HEAT_SET_INSERT_SOURCE,
    confidence: "medium",
  };
}

export function countersunkHead(screw: ScrewSize): SourcedCountersunkHead {
  const row = COUNTERSUNK_HEADS[screw];
  if (!row) {
    throw new UnsourcedFastenerValueError(`The countersunk head diameter for ${screw} is not sourced (ISO 10642 starts at M3); pass headDiameterMm with its source, or set countersunk: false`);
  }
  return { screw, headDiameterMaxMm: row.headDiameterMaxMm, includedAngleDeg: row.includedAngleDeg, source: COUNTERSUNK_HEAD_SOURCE, confidence: "medium" };
}

// Self-tapping pilot diameters for plastic have no source here, so there is never a default.
export function requirePilotDiameter(screw: ScrewSize, pilotDiameterMm: number | undefined, where: string): number {
  if (pilotDiameterMm === undefined) {
    throw new UnsourcedFastenerValueError(`${where}: a self-tapping pilot diameter for ${screw} in plastic is not sourced; pass pilotDiameterMm`);
  }
  return pilotDiameterMm;
}

export function fastenerPresetTable(screw?: ScrewSize) {
  const screws = screw ? [screw] : [...SCREW_SIZES];
  return {
    units: "mm",
    researched: "2026-11-16",
    clearanceHoles: {
      source: CLEARANCE_HOLE_SOURCE,
      confidence: "medium" as const,
      rows: screws.map((size) => ({ screw: size, closeMm: CLEARANCE_HOLES_MM[size].close, mediumMm: CLEARANCE_HOLES_MM[size].medium, freeMm: CLEARANCE_HOLES_MM[size].free })),
    },
    heatSetInserts: {
      source: HEAT_SET_INSERT_SOURCE,
      confidence: "medium" as const,
      note: HEAT_SET_INSERT_NOTE,
      blindHoleDepthRule: "insert length + 1 mm",
      rows: HEAT_SET_INSERTS.filter((row) => screws.includes(row.screw)).map((row) => ({
        screw: row.screw,
        insert: `${row.screw}x${row.insertLengthMm}`,
        insertLengthMm: row.insertLengthMm,
        holeDiameterMm: row.holeDiameterMm,
        minWallMm: row.minWallMm,
        blindHoleDepthMm: round(row.insertLengthMm + INSERT_BLIND_HOLE_EXTRA_MM),
      })),
    },
    countersunkHeads: {
      source: COUNTERSUNK_HEAD_SOURCE,
      confidence: "medium" as const,
      note: COUNTERSUNK_HEAD_NOTE,
      rows: screws.flatMap((size) => {
        const row = COUNTERSUNK_HEADS[size];
        return row ? [{ screw: size, headDiameterMaxMm: row.headDiameterMaxMm, includedAngleDeg: row.includedAngleDeg }] : [];
      }),
    },
    notSourced: [
      ...screws.filter((size) => !COUNTERSUNK_HEADS[size]).map((size) => ({ value: `${size} countersunk head diameter`, reason: "ISO 10642 starts at M3", supply: "headDiameterMm" })),
      { value: "self-tapping pilot diameter for plastic", reason: "no source recorded", supply: "pilotDiameterMm" },
    ],
  };
}

function round(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}
