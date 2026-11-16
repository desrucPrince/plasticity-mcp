// Part 1.4: byte breakdown of a batch reply (part-a1.json) and a direct edit reply (part-a3.json, the fillet step),
// plus what an agent needs for its next step. Offline: reads the saved JSON only. Writes anatomy.json.
import { readFileSync } from "node:fs";
import { OUT_DIR, save } from "./lib.ts";

const load = (n: string) => JSON.parse(readFileSync(`${OUT_DIR}/${n}`, "utf8"));
const b = (v: unknown) => Buffer.byteLength(JSON.stringify(v) ?? "");
const fields = (obj: Record<string, unknown>) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, b(v)]).sort((x, y) => (y[1] as number) - (x[1] as number)));

const a1 = load("part-a1.json");
const batch = a1.responses[0] as Record<string, any>;
const steps = batch.steps as Array<Record<string, any>>;
const readSteps = steps.filter((s) => "result" in s);
const editSteps = steps.filter((s) => !("result" in s));
const stepField = (k: string) => editSteps.reduce((t, s) => t + (k in s ? b(s[k]) : 0), 0);
const batchAnatomy = {
  totalBytes: b(batch),
  topLevel: fields(batch),
  change: fields(batch.change),
  steps: {
    count: steps.length,
    readSteps: readSteps.length,
    readStepResultBytes: readSteps.reduce((t, s) => t + b(s.result), 0),
    editStepBytes: editSteps.reduce((t, s) => t + b(s), 0),
    editStepAddedBodiesBytes: stepField("addedBodies"),
    editStepCreatedEdgesBytes: stepField("createdEdges"),
    editStepEmptyListsBytes: editSteps.reduce((t, s) => t + ["added", "removed", "regionsAdded"].reduce((u, k) => u + (Array.isArray(s[k]) && s[k].length === 0 ? b(s[k]) + k.length + 3 : 0), 0), 0),
    largestReadResult: Math.max(...readSteps.map((s) => b(s.result))),
  },
};
// What the agent needs after a successful build: the new body id, its bounds/counts and the revision.
const needed = { revision: batch.revision, added: batch.change.added.map((x: any) => ({ id: x.id, boundsMm: x.boundsMm, faceCount: x.faceCount, edgeCount: x.edgeCount })) };
const neededRounded = JSON.parse(JSON.stringify(needed, (_k, v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v)));

const a3 = load("part-a3.json");
const calls = a3.calls as Array<{ tool: string; respBytes: number; reqBytes: number; serverTiming?: Record<string, number>; ops: Record<string, number> }>;
const filletIndex = calls.findIndex((c) => c.tool === "plasticity_fillet");
const fillet = a3.responses[filletIndex] as Record<string, any>;
const directNeeded = { revision: fillet.revision, change: { modified: fillet.change.modified.map((m: any) => ({ id: m.id, faceCount: m.after.faceCount, edgeCount: m.after.edgeCount, boundsMm: m.after.boundsMm })) } };
const findIndex = calls.findIndex((c) => c.tool === "plasticity_find_edges");
const find = a3.responses[findIndex] as Record<string, any>;
const findNeeded = { revision: find.revision, ids: find.matches.map((m: any) => m.id) };
const floatChars = (v: unknown) => (JSON.stringify(v).match(/\d+\.\d{4,}/g) ?? []).reduce((t, s) => t + s.length - (s.indexOf(".") + 4), 0);

const out = {
  batchReply: { ...batchAnatomy, neededBytes: b(needed), neededRoundedBytes: b(neededRounded), neededFraction: +(b(needed) / b(batch)).toFixed(3), excessFloatDigitsBytes: floatChars(batch) },
  directEditReply: {
    tool: "plasticity_fillet", totalBytes: b(fillet), topLevel: fields(fillet), change: fields(fillet.change),
    bodiesListed: Array.isArray(fillet.bodies) ? fillet.bodies.length : null,
    neededBytes: b(directNeeded), neededFraction: +(b(directNeeded) / b(fillet)).toFixed(3), excessFloatDigitsBytes: floatChars(fillet),
  },
  findEdgesReply: { totalBytes: b(find), count: find.count, perMatchBytes: Math.round(b(find.matches) / Math.max(1, find.count)), neededBytes: b(findNeeded), neededFraction: +(b(findNeeded) / b(find)).toFixed(3), matchFields: fields(find.matches[0]) },
  directCallsAll: calls.map((c, i) => ({ i, tool: c.tool, respBytes: c.respBytes, serverTiming: c.serverTiming, ops: c.ops })),
};
save("anatomy.json", out);
console.log(JSON.stringify({ batchReply: out.batchReply, directEditReply: { ...out.directEditReply }, findEdgesReply: out.findEdgesReply }, null, 1));
