// Read-only: describe native classes (prototype chain, fresh-instance fields). usage: node describe.ts A,B,C out.json [instantiateA,B]
import { connect, save, nativeFunction } from "./harness.ts";
import { readFileSync } from "node:fs";
const [list, outName, inst] = process.argv.slice(2);
const names = list!.split(",");
const runtime = await connect();
try {
  const r = await runtime.readNative<any>(nativeFunction([readFileSync(new URL("./js/describe.js", import.meta.url), "utf8")] as any), names, [{ names, instantiate: (inst ?? "").split(",") }], 30000);
  save(outName!, r);
  console.log(JSON.stringify(r, null, 1).slice(0, 60000));
} catch (e) { console.error("ERROR", (e as Error).message.slice(0, 2000)); }
runtime.close(); process.exit(0);
