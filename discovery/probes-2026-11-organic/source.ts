// Read-only: dumps class source text (minified) of named bindings. Isolated instance only.
import { discoverPlasticityTargets } from "../../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../../src/plasticity/runtime.ts";
import { writeFileSync, mkdirSync } from "node:fs";
const CDP = process.env.PLASTICITY_CDP_URL ?? "";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(CDP) || CDP.endsWith(":9223")) throw new Error("isolated CDP only");
const names = process.argv.slice(2);
const [target] = await discoverPlasticityTargets(CDP);
const runtime = await PlasticityRuntime.connect(target!);
mkdirSync(new URL("./src/", import.meta.url), { recursive: true });
try {
  const out = await runtime.readNative<string[]>(`function (...classes) { return classes.map(c => { try { return String(c); } catch (e) { return 'ERR ' + e.message; } }); }`, names);
  names.forEach((n, i) => writeFileSync(new URL(`./src/${n}.js`, import.meta.url), out[i]));
  console.log(names.map((n, i) => n + ' ' + out[i].length).join('\n'));
} finally { runtime.close(); }
