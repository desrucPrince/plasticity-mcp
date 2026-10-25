// HUD demo: a harmless 24-step batch far from the model (12 boxes created, then deleted), with a raw CDP screenshot
// of the Plasticity window taken mid-batch from a separate connection, so the badge is captured while working.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { discoverPlasticityTargets } from "../../../src/cdp/discovery.ts";
import { CdpClient } from "../../../src/cdp/client.ts";
import { openSession } from "../../mcp-client.ts";
const s = await openSession();
const [target] = await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
const cdp = await CdpClient.connect(target!.webSocketDebuggerUrl);
try {
  const steps: Array<{ toolName: string; arguments: Record<string, unknown> }> = [];
  for (let k = 0; k < 12; k++) steps.push({ toolName: "plasticity_create_box", arguments: { originMm: [40000 + 30 * k, 40000, 0], sizeMm: [10, 10, 10], name: "hud-demo-box" } });
  for (let k = 0; k < 12; k++) steps.push({ toolName: "plasticity_delete", arguments: { ids: [`$${k}.added[0]`] } });
  const run = s.raw("plasticity_batch", { undoOnError: true, steps });
  const shots: string[] = [];
  for (const delay of [500, 900, 1400]) {
    await new Promise((r) => setTimeout(r, delay === 500 ? 500 : 400));
    const png = await cdp.captureScreenshot();
    const path = resolve(`discovery/neorc11/user-half/review-v5/hud-working-${delay}.png`);
    await writeFile(path, Buffer.from(png, "base64"));
    shots.push(path);
  }
  const out = await run;
  await new Promise((r) => setTimeout(r, 300));
  await writeFile(resolve("discovery/neorc11/user-half/review-v5/hud-done.png"), Buffer.from(await cdp.captureScreenshot(), "base64"));
  console.log("batch undoSteps", out.undoSteps, "shots", shots.length + 1);
} finally { cdp.close(); await s.close(); }
