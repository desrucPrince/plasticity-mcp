// Ad-hoc runner: run a renderer function from a .js file against the isolated instance (this = editor).
// usage: node run.ts file.js [jsonArgs] [bindingA,bindingB] [outName]
import { connect, save, nativeFunction } from "./harness.ts";
import { readFileSync } from "node:fs";
const [file, argJson, bindingList, outName] = process.argv.slice(2);
const runtime = await connect();
const src = readFileSync(file!, "utf8");
const bindings = bindingList ? bindingList.split(",").filter(Boolean) : [];
try {
  const r = await runtime.mutate<unknown>(nativeFunction([src] as any), bindings, [argJson ? JSON.parse(argJson) : {}], 60000);
  console.log(JSON.stringify(r, null, 1).slice(0, 20000));
  if (outName) save(outName, r);
} catch (e) { console.error(String((e as Error).message).slice(0, 4000)); }
runtime.close();
process.exit(0);
