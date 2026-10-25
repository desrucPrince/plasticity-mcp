// Screenshots of the V5 gyro from an elevated rear 3/4 view (close and wide), then a harmless batch far from the
// model (create a box, delete it) followed by a screenshot to catch the activity HUD badge.
import { resolve } from "node:path";
import { openSession } from "../../mcp-client.ts";
const dir = resolve("discovery/neorc11/user-half/review-v5");
const s = await openSession();
const call = (t: string, a: Record<string, unknown> = {}) => s.raw("plasticity_call", { toolName: t, arguments: a });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  const C = [0, -4250, 3280];
  for (const [label, eye, radius] of [["gyro-close", [6500, -11500, 8200], 1500], ["gyro-rear34", [9000, -16000, 9500], 6500]] as const) {
    await call("plasticity_set_camera", { eyeMm: eye, targetMm: C, frameRadiusMm: radius });
    await pause(1200);
    await s.raw("plasticity_screenshot", { path: resolve(dir, `${label}-${Date.now()}.png`) });
  }
  const st = await s.raw("plasticity_status", { bodyLimit: 1 });
  await s.raw("plasticity_batch", { undoOnError: true, steps: [
    { toolName: "plasticity_create_box", arguments: { originMm: [40000, 40000, 0], sizeMm: [10, 10, 10], name: "hud-probe-box" } },
    { toolName: "plasticity_delete", arguments: { ids: ["$0.added[0]"] } },
  ] });
  await pause(400);
  await s.raw("plasticity_screenshot", { path: resolve(dir, `hud-done-${Date.now()}.png`) });
  console.log("undo before/after probe:", st.undoDepth, (await s.raw("plasticity_status", { bodyLimit: 1 })).undoDepth);
} finally { await s.close(); }
