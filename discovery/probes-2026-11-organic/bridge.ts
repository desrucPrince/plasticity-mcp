// Probe BridgeCurveFactory tension/sense/parameter fields on two Wires (no commit unless COMMIT=1). Isolated only.
import { discoverPlasticityTargets } from "../../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../../src/plasticity/runtime.ts";
import { nativeFunction } from "../../src/plasticity/native-function.ts";
const CDP = process.env.PLASTICITY_CDP_URL ?? "";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(CDP) || CDP.endsWith(":9223")) throw new Error("isolated CDP only");
const [a, ea, b, eb, mode] = process.argv.slice(2);
const [target] = await discoverPlasticityTargets(CDP);
const runtime = await PlasticityRuntime.connect(target!);
try {
  const out = await runtime.mutate(nativeFunction`async function (Factory, Continuity, args) {
    const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item.view; throw new Error('no ' + id); };
    const segment = (id, ent) => { for (const c of Array.from(find(id).segments)) if (Number(nativeApi.db.lookupTopologyItem(c)?.Id?.()) === ent) return c; throw new Error('seg'); };
    const editor = this; const log = {}; globalThis.__probe = log;
    const command = new editor.commands.BridgeCurveCommand(editor); command.remember = false;
    command.execute = async function () { try {
      const f = new Factory(editor).resource(this);
      f.start = segment(args.a, args.ea); f.t1 = 1; f.end = segment(args.b, args.eb); f.t2 = 1;
      f.startCurvature = Continuity.G2; f.endCurvature = Continuity.G2; f.trim = false; f.pickClosestSenses();
      log.preUpdate = true; await f.update();
      const snap = () => ({ t1: f.t1, t2: f.t2, s1: f.sense1, s2: f.sense2, ten1: Array.from(f.tensions1 ?? []), ten2: Array.from(f.tensions2 ?? []), lock: f.lockDistances, analysis: Object.keys(f.analysis ?? {}), start: f.startPosition && [f.startPosition.x, f.startPosition.y, f.startPosition.z] });
      log.updated = true; log.after = snap();
      if (args.mode?.startsWith('{')) { const o = JSON.parse(args.mode); for (const [k, v] of Object.entries(o)) f[k] = v; await f.update(); log.set = snap(); }
      if (args.mode === 'tension') { f.tensions1 = [0.03, 0.0]; f.tensions2 = [0.03, 0.0]; await f.update(); log.set = snap(); }
      if (args.mode === 'mid') { f.t1 = 0.5; await f.update(); log.set = snap(); }
      if (args.mode === 'flip') { f.sense1 = !f.sense1; await f.update(); log.set = snap(); }
      if (args.commit) return await f.commit();
      log.done = true; f.cancel(); throw new Error('PROBE_CANCEL');
    } catch (e) { log.error = String(e?.message ?? e); log.stack = String(e?.stack ?? '').slice(0, 400); throw e; } };
    try { await editor.exec(command); } catch (e) { return String(e.message ?? e); }
    return JSON.stringify(log);
  }`, ["BridgeCurveFactory", "ContinuityType"], [{ a: +a, ea: +ea, b: +b, eb: +eb, mode, commit: process.env.COMMIT === "1" }]);
  console.log(out, JSON.stringify(await runtime.read("function () { return globalThis.__probe; }")));
} finally { runtime.close(); }
