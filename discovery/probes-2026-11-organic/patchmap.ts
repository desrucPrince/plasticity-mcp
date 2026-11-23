// Probe PatchHoleInSheetFactory per-edge continuity bookkeeping (cancels; no commit). Isolated only.
import { discoverPlasticityTargets } from "../../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../../src/plasticity/runtime.ts";
import { nativeFunction } from "../../src/plasticity/native-function.ts";
const CDP = process.env.PLASTICITY_CDP_URL ?? "";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(CDP) || CDP.endsWith(":9223")) throw new Error("isolated CDP only");
const [id, a, b] = process.argv.slice(2);
const [target] = await discoverPlasticityTargets(CDP);
const runtime = await PlasticityRuntime.connect(target!);
try {
  await runtime.mutate(nativeFunction`async function (Factory, Continuity, args) {
    const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item.view; throw new Error('no ' + id); };
    const editor = this; const log = {}; globalThis.__probe = log;
    const command = new editor.commands.PatchCommand(editor); command.remember = false;
    command.execute = async function () { try {
      const f = new Factory(editor).resource(this);
      const view = find(args.id); f.sheet = view;
      const edge = e => view.high.edges.get(view.high.edges.versionIds.indexOf(e));
      const ea = edge(args.a), eb = edge(args.b);
      f.edges = [ea, eb];
      f.setContinuityForEdge(ea, Continuity.G1);
      const m = f.edge2continuity;
      log.mapType = m?.constructor?.name; log.size = m?.size;
      log.entries = m ? Array.from(m.entries()).map(([k, v]) => [k?.constructor?.name, typeof k === 'string' ? k : (k?.versionId ?? k?.simpleName ?? Object.keys(k ?? {}).slice(0, 5).join(',')), v]) : null;
      log.getA = f.getContinuityForEdge(ea); log.getB = f.getContinuityForEdge(eb); log.global = f.continuity;
      log.edgeA = { ctor: ea.constructor.name, versionId: ea.versionId, simpleName: ea.simpleName };
      f.cancel(); throw new Error('PROBE_CANCEL');
    } catch (e) { log.error = String(e?.message ?? e); throw e; } };
    try { await editor.exec(command); } catch {}
  }`, ["PatchHoleInSheetFactory", "ContinuityType"], [{ id: +id, a, b }]);
  console.log(JSON.stringify(await runtime.read("function () { return globalThis.__probe; }")));
} finally { runtime.close(); }
