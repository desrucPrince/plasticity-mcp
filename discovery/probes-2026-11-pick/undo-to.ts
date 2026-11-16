// Undo the isolated instance down to a given undo depth (native editor.undo()).
import { connect, depth, undoTo } from "./harness.ts";
const runtime = await connect();
const target = Number(process.argv[2] ?? 0);
console.log("before", JSON.stringify(await depth(runtime)));
console.log("after", JSON.stringify(await undoTo(runtime, target)));
runtime.close(); process.exit(0);
