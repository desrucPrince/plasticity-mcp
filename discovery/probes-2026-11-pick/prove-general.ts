// Proof item 3 (generalisation) and item 5 (window state): the same seeded-click-point mechanism
// (js/driving-distance.js) on a non-box solid (cylinder caps -> height) and with a single selected face.
// Optional WINDOW_STATE=minimized runs one box trial with the isolated window minimised via CDP Browser.setWindowBounds.
import { connect, depth, mcp, save, errText, nativeFunction, HERE, CDP } from "./harness.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CdpClient } from "../../src/cdp/client.ts";

const src = readFileSync(join(HERE, "js/driving-distance.js"), "utf8");
const runtime = await connect();
const session = await mcp();
const log: any = { startNative: await depth(runtime), trials: [] };
const mm = (v: number) => v / 1000;
const geo = JSON.parse(readFileSync(join(HERE, "general-geometry.json"), "utf8"));

async function bodyState(id: number) {
  const st = await session.raw("plasticity_status", { bodyLimit: 200 });
  const b = st.bodies.find((x: any) => x.id === id);
  const size = b ? [0, 1, 2].map((i) => b.boundsMm.max[i] - b.boundsMm.min[i]) : null;
  return { revision: st.revision, undoDepth: st.undoDepth, bodyCount: st.bodies.length, boundsMm: b?.boundsMm, sizeMm: size };
}
async function faceBy(id: number, normal: number[]) {
  const info = (await session.raw("plasticity_body_info", { id })).body;
  return info.faces.find((f: any) => f.normal && f.normal.every((c: number, i: number) => Math.abs(c - normal[i]!) < 1e-9));
}
async function trial(label: string, bodyId: number, opts: { refNormal?: number[]; movingNormal: number[]; targetMm: number; axis: number; baseMm: number }) {
  const entry: any = { label, opts };
  try {
    const before = await bodyState(bodyId);
    const moving = await faceBy(bodyId, opts.movingNormal);
    const ref = opts.refNormal ? await faceBy(bodyId, opts.refNormal) : null;
    const faces = ref ? [ref.id, moving.id] : [moving.id];
    entry.before = before; entry.faces = faces;
    entry.native = await runtime.mutate<any>(nativeFunction([src] as any), ["DimensionDistanceCommand", "DimensionDistanceSpaceDialog"], [{ bodyId, faces, hit: { face: moving.id, point: moving.centerMm.map(mm), normal: moving.normal }, mode: "factory", distanceM: mm(opts.targetMm), dialogTimeoutMs: 3000, finishTimeoutMs: 8000 }], 30000);
    entry.after = await bodyState(bodyId);
    entry.undoSteps = entry.after.undoDepth - before.undoDepth;
    entry.pass = entry.undoSteps === 1 && Math.abs(entry.after.sizeMm[opts.axis] - opts.targetMm) < 1e-3 && entry.native.end.active === null && !entry.native.end.inputLeft;
    if (entry.undoSteps > 0) {
      await session.raw("plasticity_undo", { steps: entry.undoSteps, revision: entry.after.revision });
      entry.afterUndo = await bodyState(bodyId);
      entry.undoRestored = Math.abs(entry.afterUndo.sizeMm[opts.axis] - opts.baseMm) < 1e-3 && entry.afterUndo.undoDepth === before.undoDepth;
    }
  } catch (error) { entry.error = errText(error); }
  log.trials.push(entry);
  console.log(label, JSON.stringify({ pass: entry.pass, size: [entry.before?.sizeMm, entry.after?.sizeMm, entry.afterUndo?.sizeMm], undo: [entry.before?.undoDepth, entry.after?.undoDepth, entry.afterUndo?.undoDepth], restored: entry.undoRestored, factoryAtDialog: entry.native?.factoryAtDialog, end: entry.native?.end, error: entry.error }));
}

let browser: CdpClient | undefined;
try {
  const st = await session.raw("plasticity_status", { bodyLimit: 200 });
  const box = st.bodies.find((b: any) => b.type === "Solid" && b.boundsMm.min[0] > 1980 && b.boundsMm.max[0] < 2050);
  const cyl = geo.cylinder[0];
  log.ids = { box: box.id, cyl: cyl.id };
  if (process.env.WINDOW_STATE) {
    const version = await (await fetch(CDP + "/json/version")).json() as any;
    if (!String(version.webSocketDebuggerUrl).includes("127.0.0.1:57291")) throw new Error("wrong browser endpoint");
    browser = await CdpClient.connect(version.webSocketDebuggerUrl);
    const win: any = await browser.send("Browser.getWindowForTarget", { targetId: "E634FD207384F0F8D6EB10D2D01D46F2" });
    log.window = { id: win.windowId, before: win.bounds };
    await browser.send("Browser.setWindowBounds", { windowId: win.windowId, bounds: { windowState: process.env.WINDOW_STATE } });
    await new Promise((r) => setTimeout(r, 1500));
    log.window.during = ((await browser.send("Browser.getWindowForTarget", { targetId: "E634FD207384F0F8D6EB10D2D01D46F2" })) as any).bounds;
    await trial(`window_${process.env.WINDOW_STATE}_box_30`, box.id, { refNormal: [-1, 0, 0], movingNormal: [1, 0, 0], targetMm: 30, axis: 0, baseMm: 20 });
  } else {
    await trial("cylinder_caps_height_16", cyl.id, { refNormal: [0, 0, -1], movingNormal: [0, 0, 1], targetMm: 16, axis: 2, baseMm: 10 });
    await trial("cylinder_topOnly_height_14", cyl.id, { movingNormal: [0, 0, 1], targetMm: 14, axis: 2, baseMm: 10 });
    await trial("box_oneFace_xPos_33", box.id, { movingNormal: [1, 0, 0], targetMm: 33, axis: 0, baseMm: 20 });
    await trial("box_twoFaces_y_height_via_yPos_18", box.id, { refNormal: [0, -1, 0], movingNormal: [0, 1, 0], targetMm: 18, axis: 1, baseMm: 10 });
  }
} catch (error) { log.fatal = errText(error); console.error(error); }
finally {
  if (browser && log.window) {
    try { await browser.send("Browser.setWindowBounds", { windowId: log.window.id, bounds: { windowState: "normal" } }); await new Promise((r) => setTimeout(r, 800)); log.window.after = ((await browser.send("Browser.getWindowForTarget", { targetId: "E634FD207384F0F8D6EB10D2D01D46F2" })) as any).bounds; } catch (e) { log.window.restoreError = errText(e); }
    browser.close();
  }
  log.endNative = await depth(runtime);
  save(process.env.WINDOW_STATE ? `prove-window-${process.env.WINDOW_STATE}.json` : "prove-general.json", log);
  await session.close(); runtime.close(); process.exit(0);
}
