// Read-only: names the newest undo/redo entries and reports focus/visibility state.
import { discoverPlasticityTargets } from "../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../src/plasticity/runtime.ts";
const [target] = await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
const runtime = await PlasticityRuntime.connect(target!);
try {
  console.log(JSON.stringify(await runtime.read(`function () {
    const name = (entry) => entry?.name ?? entry?.constructor?.name ?? typeof entry;
    const undo = this.history?.undoStack ?? [], redo = this.history?.redoStack ?? [];
    return { undoTop: undo.slice(-4).map(name), redoTop: redo.slice(-3).map(name), hidden: document.hidden, focused: document.hasFocus(), visibility: document.visibilityState };
  }`)));
} finally { runtime.close(); }
