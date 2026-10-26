import { discoverPlasticityTargets } from "../../../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../../../src/plasticity/runtime.ts";
const [target] = await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
const rt = await PlasticityRuntime.connect(target!);
try {
  console.log(JSON.stringify(await rt.read(`async function () {
    const sh = this.shading;
    const mats = sh.materials;
    const keys = Object.keys(mats ?? {});
    const inner = {}; for (const k of keys) { const v = mats[k]; inner[k] = v instanceof Map ? [...v.keys()].slice(0, 40) : (v && typeof v === "object" ? Object.keys(v).slice(0, 40) : String(v)); }
    let p = Object.getPrototypeOf(mats); const protos = []; while (p && p !== Object.prototype) { protos.push(Object.getOwnPropertyNames(p).join(",")); p = Object.getPrototypeOf(p); }
    return { keys, inner, protos };
  }`)).slice(0, 3000));
} finally { rt.close(); }
