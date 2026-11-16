// Approach B / C check: select the box's +x face with a synthetic CDP mouse click (Input.dispatchMouseEvent) at the
// projected screen position, let Plasticity's own viewport selector record the selection hit, then run the real
// DimensionDistanceCommand on that selection (hybrid C) and finish its dialog natively. Camera restored afterwards.
import { connect, depth, mcp, save, errText, nativeFunction, HERE } from "./harness.ts";
import { readFileSync } from "node:fs";
const js = (n: string) => nativeFunction([readFileSync(join(HERE, "js", n), "utf8")] as any);
import { join } from "node:path";
const runtime = await connect();
const session = await mcp();
const log: any = { start: await depth(runtime), steps: {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sel = nativeFunction`async function (args) {
  const ed = this; const h = ed.selection.hits;
  return { faces: [...ed.selection.selected.faces].map(f => f.versionId ?? f.constructor.name), solids: ed.selection.selected.solids.size, hits: [...h.hits.entries()].map(([k, v]) => ({ key: k.constructor.name, vid: k.versionId, point: v.point?.toArray?.(), normal: v.normal?.toArray?.() ?? null })), env: { hasFocus: document.hasFocus(), visibility: document.visibilityState } };
}`;
let memento = false;
try {
  const st = await session.raw("plasticity_status", { bodyLimit: 200 });
  const box = st.bodies.find((b: any) => b.type === "Solid" && b.boundsMm.min[0] > 1980 && b.boundsMm.max[0] < 2050);
  const info = (await session.raw("plasticity_body_info", { id: box.id })).body;
  const xPos = info.faces.find((f: any) => f.normal?.[0] === 1);
  log.box = { id: box.id, boundsMm: box.boundsMm, undoDepth: st.undoDepth, xPos: xPos.id };
  // 1. Save camera, frame the box, clear selection and hits.
  // Frame the box with js/set-view.js (saves the previous orbit state in globalThis.__pickView), then clear selection/hits.
  log.steps.frame = await runtime.mutate(js("set-view.js"), [], [{ save: true, target: [2.01, 0.005, 0.0025], eye: [0.55, -0.65, 0.5], radius: 0.2, zoom: Number(process.env.ZOOM ?? 90), probe: xPos.centerMm.map((x: number) => x / 1000) }], 15000);
  await runtime.mutate(nativeFunction`async function () { this.selection.selected.removeAll(); this.selection.hits.clear(); }`, [], [], 5000);
  memento = true;
  const [x, y] = log.steps.frame.css;
  if (Math.abs(log.steps.frame.ndc[0]) > 0.95 || Math.abs(log.steps.frame.ndc[1]) > 0.95) throw new Error("face centre is off-screen after framing");
  // 1b. Face selection mode through the app's own keymap event (MODE=face), so a click selects the face, not the solid.
  if (process.env.MODE) log.steps.mode = await runtime.mutate(js("selmode.js"), [], [{ event: "selection:mode:set:" + process.env.MODE }], 5000);
  log.steps.undoBeforeClick = (await depth(runtime)).undo;
  // 2. Synthetic click (CSS pixels; CDP Input uses CSS px of the page, DPR handled by Chromium).
  log.steps.clicks = [];
  for (let n = 0; n < Number(process.env.CLICKS ?? 1); n++) {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await runtime.cdp("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 });
      await sleep(type === "mouseMoved" ? 150 : 60);
    }
    await sleep(700); // longer than a double-click interval
    log.steps.clicks.push({ n: n + 1, sel: await runtime.read(sel), undo: (await depth(runtime)).undo });
  }
  await sleep(400);
  log.steps.afterClick = await runtime.read(sel);
  log.steps.undoAfterClick = (await depth(runtime)).undo;
  // 3. Run the real command on the clicked selection (no programmatic select/hit), finish natively.
  log.steps.command = await runtime.mutate(nativeFunction`async function (DDC, Dlg, args) {
    const ed = this; const ex = ed.executor; const sleep = ms => new Promise(r => setTimeout(r, ms));
    const undo0 = ed.history.undoStack.length;
    const command = new DDC(ed); command.remember = false;
    const orig = command.execute.bind(command); let execError = null;
    command.execute = async function () { try { return await orig(); } catch (e) { execError = String(e?.message ?? e); throw e; } finally { ed.selection.selected.removeAll(); } };
    let settled = false; const p = ed.exec(command).then(() => { settled = true; }, () => { settled = true; });
    let dialog = null; const d = Date.now() + 2000;
    while (!dialog && !settled && Date.now() < d) { ed.helpers.scene.traverse(o => { if (!dialog && o instanceof Dlg && o.params) dialog = o; }); if (!dialog) await sleep(10); }
    const at = dialog ? { clickPoint: dialog.params.clickPoint.toArray(), to: dialog.params.to.toArray(), refDistance: dialog.params.refDistance } : null;
    if (dialog) { dialog.params.distance = args.distanceM; dialog.finish(); }
    const d2 = Date.now() + 5000; while (!settled && Date.now() < d2) await sleep(10);
    if (!settled && ex.active) ex.cancelActiveCommand();
    await p; ed.selection.hits.clear();
    return { at, execError, state: command.state, active: ex.active?.command?.constructor?.name ?? null, undoDelta: ed.history.undoStack.length - undo0 };
  }`, ["DimensionDistanceCommand", "DimensionDistanceSpaceDialog"], [{ distanceM: 0.03 }], 20000);
  const after = await session.raw("plasticity_status", { bodyLimit: 200 });
  const b2 = after.bodies.find((b: any) => b.id === box.id);
  log.readBack = { undoDepth: after.undoDepth, boundsMm: b2.boundsMm, sizeXmm: b2.boundsMm.max[0] - b2.boundsMm.min[0] };
  log.pass = Math.abs(log.readBack.sizeXmm - 30) < 1e-3 && after.undoDepth === st.undoDepth + 1;
  if (after.undoDepth > st.undoDepth) {
    await session.raw("plasticity_undo", { steps: after.undoDepth - st.undoDepth, revision: after.revision });
    const u = await session.raw("plasticity_status", { bodyLimit: 200 });
    const b3 = u.bodies.find((b: any) => b.id === box.id);
    log.afterUndo = { undoDepth: u.undoDepth, sizeXmm: b3.boundsMm.max[0] - b3.boundsMm.min[0] };
  }
} catch (error) { log.error = errText(error); console.error(error); }
finally {
  if (memento) { try { const pv = await runtime.read<any>(`function () { const v = globalThis.__pickView; delete globalThis.__pickView; return v; }`); const eyeFromQ = null; log.savedView = pv; log.restore = pv ? await runtime.mutate(js("set-view.js"), [], [{ target: pv.target, eye: [0, 0, 1], q: pv.q, radius: pv.radius, zoom: pv.zoom }], 15000) : "no saved view"; await runtime.mutate(nativeFunction`async function () { this.selection.selected.removeAll(); this.selection.hits.clear(); }`, [], [], 5000); } catch (e) { log.restore = errText(e); } }
  if (process.env.MODE) { try { log.modeRestore = await runtime.mutate(js("selmode.js"), [], [{ event: "selection:mode:set:default" }], 5000); } catch (e) { log.modeRestore = errText(e); } }
  log.end = await depth(runtime);
  save(`probe-synthetic-click${process.env.MODE ? "-" + process.env.MODE : ""}${process.env.CLICKS ? "-clicks" + process.env.CLICKS : ""}.json`, log);
  console.log(JSON.stringify({ mode: log.steps.mode?.after?.arr, modeRestore: log.modeRestore?.after?.arr ?? log.modeRestore, undoClick: [log.steps.undoBeforeClick, log.steps.undoAfterClick], clicks: log.steps.clicks?.map((c: any) => ({ n: c.n, faces: c.sel.faces, solids: c.sel.solids, undo: c.undo })), frame: log.steps.frame, afterClick: log.steps.afterClick, command: log.steps.command, readBack: log.readBack, pass: log.pass, afterUndo: log.afterUndo, error: log.error, end: log.end }));
  await session.close(); runtime.close(); process.exit(0);
}
