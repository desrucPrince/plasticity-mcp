// Read-only: lists prototype members of selected native factories and enum values. Edits nothing.
// Usage: PLASTICITY_CDP_URL=http://127.0.0.1:<port> node discovery/probe-factories.ts Name1 Name2 ...
import { discoverPlasticityTargets } from "../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../src/plasticity/runtime.ts";
const names = process.argv.slice(2);
const [target] = await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
if (!target) throw new Error("no window");
const runtime = await PlasticityRuntime.connect(target);
try {
  const out = await runtime.readNative(`function (...classes) {
    const names = ${JSON.stringify(names)};
    const describe = (value) => {
      if (value === null || value === undefined) return String(value);
      if (typeof value !== "function") return typeof value === "object" ? Object.fromEntries(Object.entries(value).slice(0, 80).map(([k, v]) => [k, typeof v === "object" ? "[object]" : v])) : value;
      const chain = [];
      for (let proto = value.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
        chain.push({ class: proto.constructor?.name, members: Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor").map((n) => {
          const d = Object.getOwnPropertyDescriptor(proto, n);
          return d.get || d.set ? n + (d.set ? "{set}" : "{get}") : n;
        }) });
        if (chain.length > 4) break;
      }
      return chain;
    };
    return Object.fromEntries(names.map((name, i) => [name, describe(classes[i])]));
  }`, names);
  console.log(JSON.stringify(out, null, 1));
} finally { runtime.close(); }
