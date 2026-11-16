// Gap 4 (part): MoveMeasurementFactory - move a distance measurement's label/offset.
import { connect, depth, undoTo, save, mcp, newBodies, errText, nativeFunction, TRACE, TRACED_COMMIT, lastReads } from "./harness.ts";
const runtime = await connect();
const start = await depth(runtime);
const log: any = { start, variants: {} };
let session: Awaited<ReturnType<typeof mcp>> | undefined;
try {
  session = await mcp();
  const baseIds = new Set<number>((await session.raw("plasticity_status", { bodyLimit: 200 })).bodies.map((b: any) => b.id));
  let st = await newBodies(session, baseIds);
  await session.raw("plasticity_create_box", { originMm: [2800, 0, 0], sizeMm: [20, 10, 5], revision: st.revision });
  st = await newBodies(session, baseIds);
  const box = st.bodies[0];
  const info = (await session.raw("plasticity_body_info", { id: box.id })).body;
  const v0 = info.vertices.find((v: any) => v.positionMm[0] === 2800 && v.positionMm[1] === 0 && v.positionMm[2] === 0);
  const v1 = info.vertices.find((v: any) => Math.round(v.positionMm[0]) === 2820 && v.positionMm[1] === 0 && v.positionMm[2] === 0);
  await session.raw("plasticity_create_vertex_distance_measurement", { first: { bodyId: box.id, vertexId: v0.id }, second: { bodyId: box.id, vertexId: v1.id }, name: "probe-m", revision: st.revision });
  const m0 = (await session.raw("plasticity_list_measurements")).measurements.find((m: any) => m.name === "probe-m");
  log.measurementBefore = m0;
  const geoDepth = (await depth(runtime)).undo;
  log.geoDepth = geoDepth;
  const variant = async (label: string, setup: string, commandBinding = "MoveMeasurementCommand") => {
    const entry: any = {};
    try {
      entry.native = await runtime.mutate(nativeFunction`async function (Factory, Command, Vector3, args) {
        if (this.executor.isBusy) throw new Error('Plasticity is busy');
        const editor = this;
        const measurement = this.measurements.lookupByStableId(args.id);
        if (!measurement) throw new Error('no measurement');
        this.selection.selected.removeAll();
        nativeApi.selection.addMeasurement(measurement);
        let failure;
        const out = { measurementKeys: Object.keys(measurement).slice(0, 40) };
        const command = new Command(editor);
        command.remember = false;
        command.execute = async function () {
          try {
            const factory = new Factory(editor).resource(this);
            ${TRACE}
            ${setup}
            out.factory = { start: factory.start.toArray(), end: factory.end.toArray(), offset: factory.offset.toArray(), direction: factory.direction.toArray() };
            return ${TRACED_COMMIT};
          } catch (error) { failure = error; throw error; }
        };
        await this.exec(command);
        this.selection.selected.removeAll();
        if (failure) throw failure;
        out.offsetLocal2dAtEnd = undefined; return out;
      }`, ["MoveMeasurementFactory", commandBinding, "Vector3"], [{ id: m0.id }], 20000);
    } catch (error) { entry.error = errText(error); }
    entry.protoReads = await lastReads(runtime);
    entry.measurementAfter = (await session!.raw("plasticity_list_measurements")).measurements.find((m: any) => m.id === m0.id || m.name === "probe-m");
    entry.depthAfter = await depth(runtime);
    await undoTo(runtime, geoDepth);
    log.variants[label] = entry;
    console.log(label, JSON.stringify(entry).slice(0, 1200));
  };
  await variant("offset_only", `factory.offset.set(0, -0.01, 0);`);
  await variant("start_end_offset", `factory.start.set(2.8, 0, 0); factory.end.set(2.82, 0, 0); factory.direction.set(1, 0, 0); factory.offset.set(0, -0.01, 0);`);
  await variant("measurement_field", `factory.measurement = editor.measurements.lookupByStableId(args.id); factory.measurements = [factory.measurement]; factory.offset.set(0, -0.01, 0);`);
  // offsetLocal2d is derived from start/end/direction/orientation/offset; fill them as world points (meters).
  await variant("measurement_field_full_frame", `factory.measurement = editor.measurements.lookupByStableId(args.id); factory.start.set(2.8, 0, 0); factory.end.set(2.82, 0, 0); factory.direction.set(1, 0, 0); factory.offset.set(2.81, -0.01, 0); out.offsetLocal2d = factory.offsetLocal2d.toArray();`);
  await variant("measurement_field_full_frame_y5", `factory.measurement = editor.measurements.lookupByStableId(args.id); factory.start.set(2.8, 0, 0); factory.end.set(2.82, 0, 0); factory.direction.set(1, 0, 0); factory.offset.set(2.8, 0.005, 0); out.offsetLocal2d = factory.offsetLocal2d.toArray();`);
} catch (error) { log.fatal = errText(error); console.error(error); }
finally {
  try { await session?.close(); } catch {}
  log.end = await undoTo(runtime, start.undo);
  log.endOk = log.end.undo === start.undo && log.end.bodies === start.bodies;
  save("probe-move-measurement.json", log);
  runtime.close();
  process.exit(0);
}
