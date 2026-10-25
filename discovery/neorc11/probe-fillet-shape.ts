// Fillets one edge of a scratch box (far from the model) with each candidate native FilletShellFactory.shape
// value, measures G1/G2 at the fillet's tangent edges with Plasticity's continuity evaluator, then deletes it.
import { discoverPlasticityTargets } from "../../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../../src/plasticity/runtime.ts";
import { PlasticityOperations } from "../../src/plasticity/operations.ts";
const [target] = await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
const runtime = await PlasticityRuntime.connect(target!);
const ops = new PlasticityOperations(runtime);
const shapes = (process.argv[2] ?? "22200,22201,22202,22203,22204,22205,22206").split(",").map(Number);
try {
  for (const shape of shapes) {
    let st = await ops.state();
    st = await ops.createBox([30000, 0, 0], [1000, 1000, 1000], "fillet-probe", st.revision);
    const box = st.bodies.find((b) => b.name === "fillet-probe")!;
    const edge = box.edges.find((e: any) => e.boundsMm && Math.abs(e.boundsMm.min[0] - 31000) < 1e-3 && Math.abs(e.boundsMm.min[2] - 1000) < 1e-3 && Math.abs(e.boundsMm.max[0] - 31000) < 1e-3)!;
    let note = "";
    try {
      await runtime.mutate(`async function (Factory, args) {
        const find = id => { for (const [versionId, item] of this.geo.geometryModel) { if (this.db.lookupStableId(versionId) === id) return item.view; } throw new Error('Unknown body ' + id); };
        const view = find(args.bodyId);
        const editor = this; let failure;
        const command = new this.commands.FilletShellCommand(this); command.remember = false;
        command.execute = async function () { try {
          const factory = new Factory(editor).resource(this);
          factory.shell = view;
          const edges = view.high.edges;
          factory.edges = [edges.get(edges.versionIds.indexOf(args.edgeId))];
          factory.shape = args.shape;
          factory.distance = 0.2;
          return await factory.commit();
        } catch (e) { failure = e; throw e; } };
        await this.exec(command); if (failure) throw failure;
      }`, ["FilletShellFactory"], [{ bodyId: box.id, edgeId: edge.id, shape }]);
    } catch (e) { note = String(e).slice(0, 160); }
    st = await ops.state();
    const b = st.bodies.find((x) => x.name === "fillet-probe" || x.id === box.id)!;
    let summary: any = note;
    if (!note) {
      const res: any = await ops.analyzeSurfaceContinuity(b.edges.map((e: any) => ({ bodyId: b.id, edgeId: e.id })), st.revision, 0.01, 0.1, 0.05);
      const rows = (res.analyses ?? []).filter((r: any) => r.maximumNormalAngleDeviationDeg < 1);
      summary = { faces: b.faceCount, tangentEdges: rows.length, g1: rows.map((r: any) => +r.maximumNormalAngleDeviationDeg.toFixed(4)), g2: rows.map((r: any) => +Number(r.maximumRelativeCurvatureDeviation).toFixed(3)) };
    }
    console.log(shape, JSON.stringify(summary));
    st = await ops.state();
    await ops.remove([b.id], st.revision);
  }
} finally { runtime.close(); }
