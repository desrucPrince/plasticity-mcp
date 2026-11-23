// Read-only: lists own fields and prototype accessors/methods of uncommitted factory instances. Isolated instance only.
import { discoverPlasticityTargets } from "../../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../../src/plasticity/runtime.ts";
const CDP = process.env.PLASTICITY_CDP_URL ?? "";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(CDP) || CDP.endsWith(":9223")) throw new Error("isolated CDP only");
const names = process.argv.slice(2);
const [target] = await discoverPlasticityTargets(CDP);
const runtime = await PlasticityRuntime.connect(target!);
try {
  const out = await runtime.readNative(`function (...classes) {
    const names = ${JSON.stringify(names)};
    const show = (v) => v === null || v === undefined ? String(v) : Array.isArray(v) ? 'Array(' + v.length + ')' : typeof v === "object" ? (v.constructor?.name ?? "object") : typeof v === "function" ? "fn" : v;
    return Object.fromEntries(names.map((name, i) => {
      let factory;
      try {
        const proto = [];
        let p = classes[i].prototype;
        while (p && p !== Object.prototype) {
          const entries = Object.getOwnPropertyNames(p).filter(k => k !== 'constructor').map(k => { const d = Object.getOwnPropertyDescriptor(p, k); return k + (d.get||d.set ? '{' + (d.get?'g':'') + (d.set?'s':'') + '}' : '()'); });
          proto.push((p.constructor?.name ?? '?') + ': ' + entries.join(' '));
          p = Object.getPrototypeOf(p);
        }
        let fields = {};
        try { factory = new classes[i](this); for (const key of Object.keys(factory)) fields[key] = show(factory[key]); } catch (e) { fields = 'ctor error: ' + e.message; }
        return [name, { fields, proto }];
      } catch (error) { return [name, "error: " + error.message]; }
      finally { try { factory?.cancel?.(); } catch {} }
    }));
  }`, names);
  console.log(JSON.stringify(out, null, 1));
} finally { runtime.close(); }
