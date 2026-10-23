// Read-only: constructs uncommitted factory instances to list their own fields, then cancels them.
// Nothing is committed to the document. Usage: PLASTICITY_CDP_URL=... node discovery/probe-factory-fields.ts Name ...
import { discoverPlasticityTargets } from "../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../src/plasticity/runtime.ts";
const names = process.argv.slice(2);
const [target] = await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
if (!target) throw new Error("no window");
const runtime = await PlasticityRuntime.connect(target);
try {
  const before = await runtime.read<number>("function () { return this.history?.undoStack?.length ?? -1; }");
  const out = await runtime.readNative(`function (...classes) {
    const names = ${JSON.stringify(names)};
    const show = (v) => v === null || v === undefined ? String(v) : typeof v === "object" ? (v.constructor?.name ?? "object") : typeof v === "function" ? "fn" : v;
    return Object.fromEntries(names.map((name, i) => {
      let factory;
      try {
        factory = new classes[i](this);
        const fields = {};
        for (const key of Object.keys(factory)) fields[key] = show(factory[key]);
        return [name, fields];
      } catch (error) { return [name, "error: " + error.message]; }
      finally { try { factory?.cancel?.(); } catch {} }
    }));
  }`, names);
  const after = await runtime.read<number>("function () { return this.history?.undoStack?.length ?? -1; }");
  console.log(JSON.stringify({ undoBefore: before, undoAfter: after, out }, null, 1));
} finally { runtime.close(); }
