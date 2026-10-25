// Camera-only: saves top/front/side/iso screenshots into the folder given as argv[2]. Restores nothing (views only).
import { openSession } from "../mcp-client.ts";
const dir = process.argv[2]!;
const s = await openSession();
try {
  const call = (toolName: string, args: Record<string, unknown> = {}) => s.raw("plasticity_call", { toolName, arguments: args });
  const st = await s.raw("plasticity_status", { bodyLimit: 200 });
  console.log("undo", st.undoDepth, "visible", st.bodies.map((b: any) => `${b.id}:${b.visible ?? "?"}`).join(" "));
  for (const [view, label] of [["isometric", "perspective"], ["top", "top"], ["front", "front-end"], ["right", "side"], ["back", "rear"], ["bottom", "bottom"]]) {
    await call("plasticity_set_view", { view, fit: true });
    await new Promise((r) => setTimeout(r, 900));
    await s.raw("plasticity_screenshot", { path: `${dir}/${label}-${Date.now()}.png` });
  }
  console.log("undo after", (await s.raw("plasticity_status", { bodyLimit: 200 })).undoDepth);
} finally { await s.close(); }
