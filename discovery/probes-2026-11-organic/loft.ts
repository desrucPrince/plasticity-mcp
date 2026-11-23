// Probe CurveLoftFactory with Sheet-edge profiles and each LoftCurvatureType (commits; caller undoes). Isolated only.
import { discoverPlasticityTargets } from "../../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../../src/plasticity/runtime.ts";
import { nativeFunction } from "../../src/plasticity/native-function.ts";
const CDP = process.env.PLASTICITY_CDP_URL ?? "";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(CDP) || CDP.endsWith(":9223")) throw new Error("isolated CDP only");
const [a, ea, b, eb, curvature, mags] = process.argv.slice(2);
const [target] = await discoverPlasticityTargets(CDP);
const runtime = await PlasticityRuntime.connect(target!);
try {
  await runtime.mutate(nativeFunction`async function (Factory, Command, Curvature, args) {
    const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item.view; throw new Error('no ' + id); };
    const edge = (id, e) => { const v = find(id); const i = v.high.edges.versionIds.indexOf(e); if (i < 0) throw new Error('edge ' + e); return v.high.edges.get(i); };
    const editor = this; const log = { curvatureKeys: Object.keys(Curvature).filter(k => isNaN(+k)) }; globalThis.__probe = log;
    const command = new Command(editor); command.remember = false;
    command.execute = async function () { try {
      const f = new Factory(editor).resource(this);
      f.profiles = [edge(args.a, args.ea), edge(args.b, args.eb)];
      log.hasClampsBefore = f.hasClamps;
      if (args.curvature) f.curvature = Curvature[args.curvature];
      if (args.mags) { f.startMagnitude = args.mags[0]; f.endMagnitude = args.mags[1]; }
      f.join = false;
      log.hasClamps = f.hasClamps;
      const r = await f.commit(); log.ok = true; return r;
    } catch (e) { log.error = String(e?.message ?? e); throw e; } };
    try { await editor.exec(command); } catch (e) { log.execError = String(e?.message ?? e); }
  }`, ["CurveLoftFactory", "LoftEdgeCommand", "LoftCurvatureType"], [{ a: +a, ea, b: +b, eb, curvature, mags: mags ? JSON.parse(mags) : undefined }]);
  console.log(JSON.stringify(await runtime.read("function () { return globalThis.__probe; }")));
} finally { runtime.close(); }
