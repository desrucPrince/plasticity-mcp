// For each MirrorFactory flag combination, mirrors a scratch box at X 20000 across X = 0 and reports what exists
// afterwards; deletes every scratch body it made.
import { discoverPlasticityTargets } from "../../../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../../../src/plasticity/runtime.ts";
import { PlasticityOperations } from "../../../src/plasticity/operations.ts";
const [target] = await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
const runtime = await PlasticityRuntime.connect(target!);
const ops = new PlasticityOperations(runtime);
try {
  for (const flags of [{ move: false, shouldCut: false, shouldUnion: false }, { move: false, shouldCut: true, shouldUnion: false }, { move: true, shouldCut: false, shouldUnion: false }, { move: false }]) {
    let st = await ops.state();
    const before = new Set(st.bodies.map((b) => b.id));
    st = await ops.createBox([20000, 0, 0], [100, 100, 100], "mirror-probe", st.revision);
    const box = st.bodies.find((b) => !before.has(b.id))!;
    let result: unknown = null;
    try {
      result = await runtime.mutate(`async function (Factory, args) {
        const find = id => { for (const [versionId, item] of this.geo.geometryModel) { if (this.db.lookupStableId(versionId) === id) return item.view; } throw new Error('no body'); };
        const editor = this; let failure;
        const command = new this.commands.MirrorCommand(this); command.remember = false;
        command.execute = async function () { try {
          const factory = new Factory(editor).resource(this);
          factory.shells = [find(args.id)];
          factory.origin.fromArray([0, 0, 0]); factory.normal.fromArray([1, 0, 0]);
          for (const [k, v] of Object.entries(args.flags)) factory[k] = v;
          const out = await factory.commit();
          return out;
        } catch (e) { failure = e; throw e; } };
        await this.exec(command); if (failure) throw failure;
        return 'committed';
      }`, ["MirrorFactory"], [{ id: box.id, flags }]);
    } catch (e) { result = String(e).slice(0, 160); }
    st = await ops.state();
    const mine = st.bodies.filter((b) => !before.has(b.id));
    console.log(JSON.stringify(flags), String(result).slice(0, 60), "->", mine.map((b) => `#${b.id} X ${Math.round(b.boundsMm.min[0])}..${Math.round(b.boundsMm.max[0])}`).join(" ") || "nothing");
    if (mine.length) await ops.remove(mine.map((b) => b.id), st.revision);
  }
} finally { runtime.close(); }
