import { discoverPlasticityTargets } from "../../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../../src/plasticity/runtime.ts";
const [target] = await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
const runtime = await PlasticityRuntime.connect(target!);
try {
  console.log(JSON.stringify(await runtime.read(`async function () {
    return { undo: this.history.undoStack.length, busy: !!this.executor?.isBusy, hidden: document.hidden, vis: document.visibilityState, focus: document.hasFocus() };
  }`)));
} finally { runtime.close(); }
