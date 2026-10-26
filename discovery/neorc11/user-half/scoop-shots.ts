// Screenshots of the roof scoops on the isolated roof sheet (camera only; the isolate view is left as it is).
import { resolve } from "node:path";
import { openSession } from "../../mcp-client.ts";
const s = await openSession();
const call = (t: string, a: Record<string, unknown> = {}) => s.raw("plasticity_call", { toolName: t, arguments: a });
try {
  for (const [label, eye, target, radius] of [
    ["scoops-front34", [-3200, 4800, 6300], [0, -100, 4330], 1700],
    ["scoops-mouth", [1500, 2700, 4950], [700, 250, 4380], 650],
  ] as const) {
    await call("plasticity_set_camera", { eyeMm: eye, targetMm: target, frameRadiusMm: radius });
    await new Promise((r) => setTimeout(r, 1200));
    await s.raw("plasticity_screenshot", { path: resolve(`discovery/neorc11/user-half/review-v8/${label}-${Date.now()}.png`) });
  }
} finally { await s.close(); }
