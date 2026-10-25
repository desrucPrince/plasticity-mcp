// Saves the editable instanced state as a new file (refuses to overwrite).
import { openSession } from "../../mcp-client.ts";
const s = await openSession();
try { console.log(JSON.stringify(await s.raw("plasticity_call", { toolName: "plasticity_save_copy", arguments: { path: process.argv[2] } })).slice(0, 400)); }
finally { await s.close(); }
