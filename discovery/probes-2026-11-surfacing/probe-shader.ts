// Item 3: analysis shader modes. Switch each name2shader entry through ViewportShading.setShader, capture with
// plasticity_screenshot (window mode, falling back to viewport mode), compare pixels with the default shader,
// restore with restoreFromMemento. Camera state is saved and restored natively; fixtures are undone.
import { connect, save, errText, nativeFunction, HERE } from "./harness.ts";
import { startMcp, call, status, undoTo, tryCall } from "./mcp.ts";
import { rev, created, filletedBox } from "./fixtures.ts";
import { PNG } from "pngjs";
import { readFileSync, writeFileSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const client = await startMcp();
const runtime = await connect();
const start = await status(client);
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "surfacing-shots-"));
const out: any = { startUndo: start.undoDepth, shots: {} };

const shading = nativeFunction`function (name2shader, args) {
  const sh = this.shading;
  const vp = Array.from(this.viewports)[0];
  const desc = () => ({ shader: sh.shader ? (sh.shader.name || sh.shader.constructor.name) : null, tag: sh.mode.tag, undo: this.history.undoStack.length, memento: (() => { const m = sh.saveToMemento(); return { mode: m.mode, shader: m.shader ? (m.shader.name || m.shader.constructor?.name) : null, isTinted: m.isTinted, isSectioned: m.isSectioned, matcap: m.matcap?.uuid ?? m.matcap?.constructor?.name ?? null }; })() });
  if (args.op === 'save') {
    globalThis.__probeShadingMemento = sh.saveToMemento();
    const c = vp.orbitControls, cam = vp.camera;
    globalThis.__probeCamera = { q: cam.quaternion.clone(), target: c.target.clone(), radius: c.radius, zoom: c.zoom, camZoom: cam.zoom, fo: c.focalOffset.clone() };
    return { ...desc(), keys: Object.keys(name2shader) };
  }
  if (args.op === 'set') { const before = desc(); sh.setShader(name2shader[args.name]); vp.setNeedsRender(); return { before, after: desc() }; }
  if (args.op === 'restore') { sh.restoreFromMemento(globalThis.__probeShadingMemento); vp.setNeedsRender(); return desc(); }
  if (args.op === 'restoreCamera') {
    const s = globalThis.__probeCamera; const c = vp.orbitControls, cam = vp.camera;
    c.setQuaternion(s.q); c.target.copy(s.target); c.targetEnd.copy(s.target); c.focalOffset.copy(s.fo); c.focalOffsetEnd.copy(s.fo);
    c.radius = c.radiusEnd = s.radius; c.zoom = c.zoomEnd = s.zoom; cam.zoom = s.camZoom; c.setNeedsUpdate(); c.update(1 / 60); cam.updateProjectionMatrix(); vp.setNeedsRender();
    const r = { target: cam.target.toArray(), zoom: cam.zoom, q: cam.quaternion.toArray() };
    delete globalThis.__probeCamera; delete globalThis.__probeShadingMemento; return r;
  }
  if (args.op === 'camera') { const cam = vp.camera; return { target: cam.target.toArray(), zoom: cam.zoom, q: cam.quaternion.toArray(), position: cam.position.toArray() }; }
  return desc();
}`;
const sh = (args: any) => runtime.readNative<any>(shading, ["name2shader"], [args], 15000);

function stats(path: string, ref?: PNG) {
  const png = PNG.sync.read(readFileSync(path));
  let lum = 0, diff = 0, changed = 0;
  const n = png.width * png.height;
  for (let i = 0; i < n; i++) {
    const r = png.data[4 * i]!, g = png.data[4 * i + 1]!, b = png.data[4 * i + 2]!;
    lum += 0.299 * r + 0.587 * g + 0.114 * b;
    if (ref && ref.width === png.width && ref.height === png.height) {
      const d = (Math.abs(r - ref.data[4 * i]!) + Math.abs(g - ref.data[4 * i + 1]!) + Math.abs(b - ref.data[4 * i + 2]!)) / 3;
      diff += d; if (d > 16) changed++;
    }
  }
  return { png, width: png.width, height: png.height, meanLuminance: lum / n, ...(ref ? { meanAbsDiffVsDefault: diff / n, fractionChangedVsDefault: changed / n } : {}) };
}
// Small copy for the repo: 1/4 scale nearest-neighbour.
function writeSmall(png: PNG, name: string) {
  const f = 4, w = Math.floor(png.width / f), h = Math.floor(png.height / f);
  const small = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = 4 * ((y * f) * png.width + x * f), d = 4 * (y * w + x); for (let k = 0; k < 4; k++) small.data[d + k] = png.data[s + k]!; }
  const target = join(HERE, name); if (existsSync(target)) rmSync(target);
  writeFileSync(target, PNG.sync.write(small)); return name;
}

try {
  out.saved = await sh({ op: "save" });
  out.cameraBefore = await sh({ op: "camera" });
  // Fixtures: sphere and a round-filleted box side by side.
  const before = new Set(((await status(client)).bodies as any[]).map((b) => b.id));
  await call(client, "plasticity_create_sphere", { centerMm: [5000, 0, 10], radiusMm: 10, intent: "probe sphere", revision: await rev(client) });
  await filletedBox(client, [5015, -10, 0], 6, "round");
  out.fixtures = (await created(client, before)).map((b) => ({ id: b.id, type: b.type }));
  out.camera = await call(client, "plasticity_set_camera", { eyeMm: [5060, -70, 60], targetMm: [5012, 0, 8], frameRadiusMm: 30 });
  out.undoAfterFixtures = (await status(client)).undoDepth;
  let mode: "window" | "viewport" = "window";
  let ref: PNG | undefined;
  for (const name of ["default", ...out.saved.keys]) {
    const shot: any = {};
    if (name !== "default") shot.set = await sh({ op: "set", name });
    await new Promise((r) => setTimeout(r, 400));
    const path = join(scratch, `shader-${name}.png`);
    let r = await tryCall(client, "plasticity_screenshot", { path, captureMode: mode });
    if (!r.ok && mode === "window") { shot.windowError = r.error; mode = "viewport"; r = await tryCall(client, "plasticity_screenshot", { path, captureMode: mode }); }
    shot.capture = r.ok ? { ...r.value, path: String(r.value.path).replace(scratch, "$TMPDIR/surfacing-shots-XXXXXX") } : { error: r.error };
    shot.captureMode = mode;
    if (r.ok) {
      const st = stats(path, ref);
      if (name === "default") ref = st.png;
      shot.stats = { width: st.width, height: st.height, meanLuminance: st.meanLuminance, meanAbsDiffVsDefault: (st as any).meanAbsDiffVsDefault, fractionChangedVsDefault: (st as any).fractionChangedVsDefault };
      shot.file = writeSmall(st.png, `shot-shader-${name}.png`);
    }
    if (name !== "default") shot.restored = await sh({ op: "restore" });
    shot.undo = (await status(client)).undoDepth;
    out.shots[name] = shot;
  }
  // Repeatability: default again after all modes (should match the first default).
  await new Promise((r) => setTimeout(r, 400));
  const again = join(scratch, "shader-default-again.png");
  const r2 = await tryCall(client, "plasticity_screenshot", { path: again, captureMode: mode });
  if (r2.ok && ref) { const st = stats(again, ref); out.defaultAgain = { meanAbsDiffVsDefault: (st as any).meanAbsDiffVsDefault, fractionChangedVsDefault: (st as any).fractionChangedVsDefault }; }
} catch (e) {
  out.error = errText(e);
} finally {
  try { out.finalShading = await sh({ op: "restore" }); } catch (e) { out.restoreError = errText(e); }
  await undoTo(client, start.undoDepth);
  try { out.cameraRestored = await sh({ op: "restoreCamera" }); } catch (e) { out.cameraRestoreError = errText(e); }
  const end = await status(client);
  out.endUndo = end.undoDepth; out.endBodies = (end.bodies as any[]).map((b) => b.id);
  save("probe-shader.json", out);
  rmSync(scratch, { recursive: true, force: true });
  runtime.close(); await client.close();
}
process.exit(0);
