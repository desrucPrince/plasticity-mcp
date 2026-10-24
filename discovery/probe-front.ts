// Asks Chromium to bring the Plasticity page to front, then reports whether it is still hidden.
import { discoverPlasticityTargets } from "../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../src/plasticity/runtime.ts";
const [target] = await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
const runtime = await PlasticityRuntime.connect(target!);
try {
  await runtime.cdp("Page.bringToFront");
  await new Promise((r) => setTimeout(r, 500));
  console.log(JSON.stringify(await runtime.read("function () { return { undo: this.history?.undoStack?.length, hidden: document.hidden }; }")));
} finally { runtime.close(); }
