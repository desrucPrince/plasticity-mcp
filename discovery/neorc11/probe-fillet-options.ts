// Lists FilletShellFactory's own fields and prototype accessors, looking for a G2/conic shape option.
import { discoverPlasticityTargets } from "../../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../../src/plasticity/runtime.ts";
const [target] = await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
const runtime = await PlasticityRuntime.connect(target!);
try {
  console.log(JSON.stringify(await runtime.readNative(`async function (Factory) {
    const out = { own: {}, protos: [] };
    let f; try { f = new Factory(this); } catch (e) { return String(e); }
    for (const k of Object.keys(f)) { const v = f[k]; out.own[k] = v === null ? null : typeof v === 'object' ? (v.constructor?.name ?? 'object') : (typeof v === 'function' ? 'fn' : v); }
    let p = Object.getPrototypeOf(f);
    while (p && p !== Object.prototype) {
      const names = Object.getOwnPropertyNames(p).filter(n => n !== 'constructor');
      out.protos.push({ cls: p.constructor?.name, names: names.map(n => { const d = Object.getOwnPropertyDescriptor(p, n); return (d.get ? 'get ' : '') + (d.set ? 'set ' : '') + n; }) });
      p = Object.getPrototypeOf(p);
    }
    try { out.paramsSrc = String(Object.getPrototypeOf(f).constructor).slice(0, 3000); } catch {}
    return out;
  }`, ["FilletShellFactory"])).slice(0, 9000));
} finally { runtime.close(); }
