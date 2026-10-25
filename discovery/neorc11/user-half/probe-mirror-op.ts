// Runs PlasticityOperations.mirror on a scratch box, then on a named detail body; reports and deletes copies.
import { discoverPlasticityTargets } from "../../../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../../../src/plasticity/runtime.ts";
import { PlasticityOperations } from "../../../src/plasticity/operations.ts";
const [target] = await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
const runtime = await PlasticityRuntime.connect(target!);
const ops = new PlasticityOperations(runtime);
try {
  let st = await ops.state();
  const before0 = new Set(st.bodies.map((b) => b.id));
  st = await ops.createBox([20000, 0, 0], [100, 100, 100], "mirror-probe", st.revision);
  const box = st.bodies.find((b) => !before0.has(b.id))!;
  for (const id of [box.id, st.bodies.find((b) => b.name === process.argv[2])!.id]) {
    st = await ops.state();
    const before = new Set(st.bodies.map((b) => b.id));
    const err = await ops.mirror([id], [0, 0, 0], [1, 0, 0], true, st.revision).then(() => "ok", (e) => String(e).slice(0, 200));
    st = await ops.state();
    const added = st.bodies.filter((b) => !before.has(b.id));
    const src = st.bodies.find((b) => b.id === id);
    console.log("mirror", id, err, "source", src ? "kept" : "GONE", "added", added.map((b) => `${b.name}#${b.id} X ${Math.round(b.boundsMm.min[0])}`).join(" ") || "none", "undo", st.undoDepth);
    const drop = added.filter((b) => b.boundsMm.max[0] < 0).map((b) => b.id);
    if (drop.length) await ops.remove(drop, st.revision);
  }
  st = await ops.state();
  if (st.bodies.some((b) => b.id === box.id)) await ops.remove([box.id], st.revision);
} finally { runtime.close(); }
