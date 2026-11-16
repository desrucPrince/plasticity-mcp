// Read-only: list native bindings matching the surfacing keywords.
import { connect, save } from "./harness.ts";
const runtime = await connect();
try {
  const all = runtime.getCapabilities();
  const re = /shader|zebra|isophote|stripe|curvature|draft|continuity|boundary|laminar|align|square|matcap|topograph|facedir|facedirection|analysis|shading|render|array|vertex|measure|xnurbs|constraint|comb/i;
  save("list-bindings.json", { total: all.length, matches: all.filter((n) => re.test(n)).sort() });
} finally { runtime.close(); }
process.exit(0);
