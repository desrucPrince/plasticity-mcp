// Runtime.evaluate (with command-line API, e.g. getEventListeners) on the isolated target. usage: node cdp-eval.ts file.js [outName]
import { connect, save } from "./harness.ts";
import { readFileSync } from "node:fs";
const runtime = await connect();
const expression = readFileSync(process.argv[2]!, "utf8");
const r: any = await runtime.cdp("Runtime.evaluate", { expression, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(r.exceptionDetails ?? r.result?.value, null, 1).slice(0, 15000));
if (process.argv[3]) save(process.argv[3], r.result?.value ?? r.exceptionDetails);
runtime.close(); process.exit(0);
