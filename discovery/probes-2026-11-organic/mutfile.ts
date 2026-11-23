// Run a mutating JS function file in an isolated Plasticity renderer (probe helper; commits when the file does). Isolated only.
// Usage: node mutfile.ts <file.js> '<json args>' [binding,binding]
import { readFileSync } from "node:fs";
import { discoverPlasticityTargets } from "../../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../../src/plasticity/runtime.ts";
import { nativeFunction } from "../../src/plasticity/native-function.ts";
const CDP = process.env.PLASTICITY_CDP_URL ?? "";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(CDP) || CDP.endsWith(":9223")) throw new Error("isolated CDP only");
const [file, json, bindings] = process.argv.slice(2);
const body = readFileSync(file!, "utf8");
const [target] = await discoverPlasticityTargets(CDP);
const runtime = await PlasticityRuntime.connect(target!);
try {
  const source = nativeFunction([body] as unknown as TemplateStringsArray);
  const out = await runtime.mutate(source, bindings ? bindings.split(",") : [], [JSON.parse(json ?? "{}")]);
  console.log(JSON.stringify(out, null, 1));
} catch (e) { console.log("ERROR", String((e as Error)?.message ?? e).slice(0, 3000)); }
finally { runtime.close(); }
