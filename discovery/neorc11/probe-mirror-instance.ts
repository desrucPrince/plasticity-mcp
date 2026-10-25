// Probe: can a native linked instance carry a mirror (negative-scale) transform? Creates one instance of body 6,
// scales it by (-1,1,1) about X=0 with the native ProjectingScaleItemAndEmptyFactory, and prints its matrix.
import { discoverPlasticityTargets } from "../../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../../src/plasticity/runtime.ts";
import { PlasticityOperations } from "../../src/plasticity/operations.ts";
const [target] = await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
const runtime = await PlasticityRuntime.connect(target!);
const ops = new PlasticityOperations(runtime);
try {
  let st = await ops.state();
  st = await ops.createInstance(6, [0, 0, 0], st.revision);
  const inst = st.instances!.at(-1)!;
  console.log("created", JSON.stringify(inst).slice(0, 600));
  const r = await runtime.mutate(`async function (Factory, args) {
    const store = this.db.empties.write;
    const original = store.id2empty.get(args.id);
    const copy = original.clone(false); copy.versionId = original.versionId; copy.targetKey = original.targetKey; copy.kind = original.kind;
    store.id2empty.set(args.id, copy);
    if (this.executor.isBusy) throw new Error('busy');
    const editor = this; let failure;
    const command = new this.commands.ScaleItemCommand(this); command.remember = false;
    command.execute = async function () { try {
      const factory = new Factory(editor).resource(this);
      factory.empties = [copy]; factory.pivot.fromArray([0,0,0]); factory.scale.fromArray([-1,1,1]);
      return await factory.commit();
    } catch (e) { failure = e; throw e; } };
    await this.exec(command); if (failure) throw failure; return 'ok';
  }`, ["ProjectingScaleItemAndEmptyFactory"], [{ id: inst.id }]);
  console.log("scale", r);
  st = await ops.state();
  console.log("after", JSON.stringify(st.instances).slice(0, 1500));
} finally { runtime.close(); }
