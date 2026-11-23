// Read-only: names of enum values used by the patch factory. Isolated instance only.
import { discoverPlasticityTargets } from "../../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../../src/plasticity/runtime.ts";
const CDP = process.env.PLASTICITY_CDP_URL ?? "";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(CDP) || CDP.endsWith(":9223")) throw new Error("isolated CDP only");
const [target] = await discoverPlasticityTargets(CDP);
const runtime = await PlasticityRuntime.connect(target!);
try {
  const out = await runtime.readNative(`function (ContinuityType, pk) {
    const want = [22740, 23156, 24910, 23154];
    const hits = {};
    for (const [name, en] of Object.entries(pk.a ?? {})) {
      if (!en || typeof en !== 'object') continue;
      let vals; try { vals = Object.entries(en); } catch { continue; }
      for (const [k, v] of vals) if (want.includes(v)) (hits[v] ??= []).push(name + '.' + k);
    }
    const full = {};
    for (const v of want) for (const h of (hits[v] ?? [])) { const en = h.split('.')[0]; full[en] = Object.fromEntries(Object.entries(pk.a[en]).filter(([k, x]) => typeof x === 'number')); }
    return { continuityType: Object.fromEntries(Object.entries(ContinuityType)), hits, full };
  }`, ["ContinuityType", "pk_default"]);
  console.log(JSON.stringify(out, null, 1));
} finally { runtime.close(); }
