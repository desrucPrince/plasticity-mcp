// Read-only: prints Plasticity's undo/redo depth and whether the executor is busy.
import { discoverPlasticityTargets } from "../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../src/plasticity/runtime.ts";
const [target] = await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
const runtime = await PlasticityRuntime.connect(target!);
try {
  console.log(JSON.stringify(await runtime.read("function () { return { undo: this.history?.undoStack?.length, redo: this.history?.redoStack?.length, busy: !!this.executor?.isBusy, hidden: document.hidden }; }")));
} finally { runtime.close(); }
