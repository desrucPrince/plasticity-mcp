// Runs one native undo with a time limit and reports what happened, including renderer errors.
import { discoverPlasticityTargets } from "../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../src/plasticity/runtime.ts";
const [target] = await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
const runtime = await PlasticityRuntime.connect(target!);
try {
  console.log(JSON.stringify(await runtime.read(`async function () {
    const before = this.history.undoStack.length;
    let error = null;
    const done = this.undo().then(() => 'resolved', (e) => { error = String(e?.message ?? e); return 'rejected'; });
    const outcome = await Promise.race([done, new Promise((r) => setTimeout(() => r('timeout-5s'), 5000))]);
    return { outcome, error, before, after: this.history.undoStack.length, busy: !!this.executor?.isBusy };
  }`)));
} finally { runtime.close(); }
