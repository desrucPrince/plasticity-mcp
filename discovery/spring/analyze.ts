// Read-only print check of the push button: native validity, solid properties and exact sections.
// Usage: PLASTICITY_CDP_URL=... node discovery/spring/analyze.ts <output.json>
import { writeFile } from "node:fs/promises";
import { openSession } from "../mcp-client.ts";

const s = await openSession();
const st = await s.raw("plasticity_status");
const solids = st.bodies.filter((b: { type: string }) => b.type === "Solid");
if (solids.length !== 1) throw new Error(`expected one Solid, found ${solids.length}`);
const body = solids[0];
const revision = st.revision;
const validity = await s.op("plasticity_validate_bodies", { ids: [body.id], revision });
const properties = await s.op("plasticity_measure_solid_properties", { ids: [body.id], revision });
const arm = (Math.PI / 180) * 30;
const planes = {
  verticalThroughAxis: { originMm: [0, 0, 0], normal: [0, 1, 0], xDirection: [1, 0, 0] },
  verticalThroughArm: { originMm: [0, 0, 0], normal: [-Math.sin(arm), Math.cos(arm), 0], xDirection: [Math.cos(arm), Math.sin(arm), 0] },
  horizontalMidSpring: { originMm: [0, 0, Number(process.env.SPRING_MID_Z ?? 0.6)], normal: [0, 0, 1], xDirection: [1, 0, 0] },
  horizontalThroughPlate: { originMm: [0, 0, Number(process.env.PLATE_MID_Z ?? 9.4)], normal: [0, 0, 1], xDirection: [1, 0, 0] },
};
const sections = await s.op("plasticity_inspect_arbitrary_sections", { bodyId: body.id, revision, planes: Object.values(planes) });
const out = { bodyId: body.id, boundsMm: body.boundsMm, validity, properties, planes, sections };
await writeFile(process.argv[2] ?? "discovery/spring/analysis.json", JSON.stringify(out, null, 2));
const summary = (sections.sections ?? sections.results ?? sections).map?.((section: { status: string; loops?: Array<Record<string, unknown>>; properties?: Record<string, unknown>; reasons?: string[] }, i: number) => ({
  plane: Object.keys(planes)[i], status: section.status, loops: section.loops?.length, area: (section.properties as { areaMm2?: number } | undefined)?.areaMm2, reasons: section.reasons?.slice(0, 2),
}));
console.log(JSON.stringify({ bodyId: body.id, validity: JSON.stringify(validity).slice(0, 400), volume: JSON.stringify(properties).slice(0, 200), summary: summary ?? Object.keys(sections) }, null, 1));
await s.close();
