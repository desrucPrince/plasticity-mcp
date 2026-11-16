// Proof item 3 discovery: what do other dimension commands await once selection + seeded click hit are given?
// Instrumented (instrument.js + instrument2.js); every run is cancelled; nothing is committed here.
import { connect, depth, mcp, save, errText, nativeFunction, HERE } from "./harness.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const js = (n: string) => nativeFunction([readFileSync(join(HERE, "js", n), "utf8")] as any);
const runtime = await connect();
const session = await mcp();
const geo = JSON.parse(readFileSync(join(HERE, "general-geometry.json"), "utf8"));
const log: any = { start: await depth(runtime), cases: {} };
const B4 = ["DimensionDistanceCommand", "DimensionDistanceFactory", "DimensionDistanceSpaceDialog", "PointPicker"];
const mm = (v: number[]) => v.map((x) => x / 1000);
try {
  log.instrument = await runtime.mutate(js("instrument.js"), B4, [{}]);
  log.instrument2 = await runtime.mutate(js("instrument2.js"), ["DimensionDistanceCommand"], [{}]);
  const st = await session.raw("plasticity_status", { bodyLimit: 200 });
  const box = st.bodies.find((b: any) => b.type === "Solid" && b.boundsMm.min[0] > 1980 && b.boundsMm.max[0] < 2050);
  const cyl = geo.cylinder[0], wire = geo.polylineOpen[0], tri = geo.triangle[0];
  const ci = (await session.raw("plasticity_body_info", { id: cyl.id })).body;
  const bi = (await session.raw("plasticity_body_info", { id: box.id })).body;
  const cTop = ci.faces.find((f: any) => f.normal?.[2] === 1), cBot = ci.faces.find((f: any) => f.normal?.[2] === -1);
  const bXp = bi.faces.find((f: any) => f.normal?.[0] === 1);
  log.ids = { box: box.id, cyl: cyl.id, wire: wire.id, tri: tri.id, cTop: cTop?.id, cBot: cBot?.id, bXp: bXp?.id, cylFaces: ci.faces.map((f: any) => ({ id: f.id, surfaceType: f.surfaceType, normal: f.normal, centerMm: f.centerMm })) };
  const cases: Record<string, any> = {
    polyline_body_hitSeg0: { command: "DimensionPolylineCommand", binding: "DimensionPolylineCommand", select: [{ kind: "body", bodyId: wire.id }], hit: { kind: "segment", bodyId: wire.id, index: 0, point: mm([2110, 0, 0]) } },
    polyline_seg0_hitSeg0: { command: "DimensionPolylineCommand", binding: "DimensionPolylineCommand", select: [{ kind: "segment", bodyId: wire.id, index: 0 }], hit: { kind: "segment", bodyId: wire.id, index: 0, point: mm([2110, 0, 0]) } },
    polyline_body_noHit: { command: "DimensionPolylineCommand", binding: "DimensionPolylineCommand", select: [{ kind: "body", bodyId: wire.id }], hit: null },
    triangle_body_hitSeg0: { command: "DimensionPolylineCommand", binding: "DimensionPolylineCommand", select: [{ kind: "body", bodyId: tri.id }], hit: { kind: "segment", bodyId: tri.id, index: 0, point: mm([2165, 0, 0]) } },
    polyline_vertex1_hitVertex1: { command: "DimensionPolylineCommand", binding: "DimensionPolylineCommand", select: [{ kind: "curveVertex", bodyId: wire.id, index: 1 }], hit: { kind: "curveVertex", bodyId: wire.id, index: 1, point: mm([2120, 0, 0]) } },
    polyline_twoVertices_hitVertex1: { command: "DimensionPolylineCommand", binding: "DimensionPolylineCommand", select: [{ kind: "curveVertex", bodyId: wire.id, index: 0 }, { kind: "curveVertex", bodyId: wire.id, index: 1 }], hit: { kind: "curveVertex", bodyId: wire.id, index: 1, point: mm([2120, 0, 0]) } },
    polyline_body_plus_seg_hitSeg0: { command: "DimensionPolylineCommand", binding: "DimensionPolylineCommand", select: [{ kind: "body", bodyId: wire.id }, { kind: "segment", bodyId: wire.id, index: 0 }], hit: { kind: "segment", bodyId: wire.id, index: 0, point: mm([2110, 0, 0]) } },
    generic_polyline_hitSeg0: { command: "DimensionCommand", select: [{ kind: "body", bodyId: wire.id }], hit: { kind: "segment", bodyId: wire.id, index: 0, point: mm([2110, 0, 0]) } },
    generic_seg0_hitSeg0: { command: "DimensionCommand", select: [{ kind: "segment", bodyId: wire.id, index: 0 }], hit: { kind: "segment", bodyId: wire.id, index: 0, point: mm([2110, 0, 0]) } },
    ddc_cylinder_caps_hitTop: { command: "DimensionDistanceCommand", select: [{ kind: "face", bodyId: cyl.id, id: cBot.id }, { kind: "face", bodyId: cyl.id, id: cTop.id }], hit: { kind: "face", bodyId: cyl.id, id: cTop.id, point: mm([2200, 0, 10]), normal: [0, 0, 1] } },
    ddc_cylinder_topOnly_hitTop: { command: "DimensionDistanceCommand", select: [{ kind: "face", bodyId: cyl.id, id: cTop.id }], hit: { kind: "face", bodyId: cyl.id, id: cTop.id, point: mm([2200, 0, 10]), normal: [0, 0, 1] } },
    ddc_box_oneFace_hit: { command: "DimensionDistanceCommand", select: [{ kind: "face", bodyId: box.id, id: bXp.id }], hit: { kind: "face", bodyId: box.id, id: bXp.id, point: mm([2020, 5, 2.5]), normal: [1, 0, 0] } },
    generic_box_oneFace_hit: { command: "DimensionCommand", select: [{ kind: "face", bodyId: box.id, id: bXp.id }], hit: { kind: "face", bodyId: box.id, id: bXp.id, point: mm([2020, 5, 2.5]), normal: [1, 0, 0] } },
  };
  for (const [label, args] of Object.entries(cases).filter(([k]) => !process.env.ONLY || new RegExp(process.env.ONLY).test(k))) {
    const entry: any = { args };
    try {
      entry.trace = await runtime.mutate(js("trace-start.js"), ["DimensionDistanceCommand", args.binding ?? "DimensionDistanceCommand"], [{ ...args, waitMs: 700 }], 20000);
      entry.cancel = await runtime.mutate(nativeFunction`async function (args) {
        const ed = this; const g = globalThis; const run = g.__pickRun; const ex = ed.executor;
        const out = { activeBefore: ex.active?.command?.constructor?.name ?? null };
        if (ex.active) ex.cancelActiveCommand();
        const d = Date.now() + 3000; while (run && run.state === 'running' && Date.now() < d) await new Promise(r => setTimeout(r, 20));
        ed.selection.selected.removeAll(); ed.selection.hits.clear(); delete g.__pickRun;
        return { ...out, runState: run?.state, active: ex.active?.command?.constructor?.name ?? null, undo: ed.history.undoStack.length, input: !!document.querySelector('input.z-space-input-focused') };
      }`, [], [{}], 10000);
    } catch (error) { entry.error = errText(error); }
    entry.depth = await depth(runtime);
    log.cases[label] = entry;
    console.log(label, JSON.stringify({ dialog: entry.trace?.dialog, factoryClass: entry.trace?.factoryClass, state: entry.trace?.state, err: entry.trace?.error, cmd: entry.trace?.cmdState, active: entry.trace?.active, input: entry.trace?.input, cancel: entry.cancel, error: entry.error }));
  }
} catch (error) { log.fatal = errText(error); console.error(error); }
finally {
  try { log.uninstrument = await runtime.mutate(js("uninstrument.js"), [], [{}]); } catch (e) { log.uninstrumentError = errText(e); }
  log.end = await depth(runtime);
  save(process.env.TRACE_OUT ?? "trace-general.json", log);
  await session.close(); runtime.close(); process.exit(0);
}
