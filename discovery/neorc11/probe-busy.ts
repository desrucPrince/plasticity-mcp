import { discoverPlasticityTargets } from "../../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../../src/plasticity/runtime.ts";
const [target] = await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
const runtime = await PlasticityRuntime.connect(target!);
try {
  console.log(JSON.stringify(await runtime.read(`async function () {
    return { undo: this.history.undoStack.length, busy: !!this.executor?.isBusy, hidden: document.hidden, focus: document.hasFocus(), scratchKeys: Object.keys(this.db ?? {}).filter(k => /scratch/i.test(k)), dbScratch: String(this.db?.scratch ?? this.db?._scratch ?? "none").slice(0,200), cmd: String(this.executor?.active?.constructor?.name ?? this.commands?.current ?? "") };
  }`)));
} finally { runtime.close(); }
