// Read-only: list native bindings matching the gap keywords.
import { connect, depth, save } from "./harness.ts";
const runtime = await connect();
try {
  const all = runtime.getCapabilities();
  const re = /sweep|xsided|x_sided|extend|dimension|measurement|point|xnurbs|polyspline|exportweb|web|nurbs|cv|controlpoint|surface/i;
  save("list-bindings.json", { depth: await depth(runtime), total: all.length, matches: all.filter((n) => re.test(n)) });
} finally { runtime.close(); }
