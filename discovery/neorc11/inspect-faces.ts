import { openSession } from "../mcp-client.ts";
const s = await openSession();
try {
  for (const id of [6, 7]) {
    const b = (await s.raw("plasticity_body_info", { id })).body;
    console.log("body", id);
    for (const f of b.faces) console.log("  ", f.surfaceType.padEnd(9), "n", f.normal.map((v: number) => v.toFixed(2)).join(","), f.boundsMm.min.map(Math.round).join(","), "→", f.boundsMm.max.map(Math.round).join(","));
  }
} finally { await s.close(); }
