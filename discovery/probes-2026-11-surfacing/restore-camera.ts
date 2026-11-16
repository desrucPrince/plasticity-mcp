// View-only: put the camera back to the pose recorded in probe-shader.json (cameraBefore: eye, target, zoom).
import { connect, save, nativeFunction } from "./harness.ts";
import { startMcp, call } from "./mcp.ts";
import { readFileSync } from "node:fs";
const before = JSON.parse(readFileSync(new URL("./probe-shader.json", import.meta.url), "utf8")).cameraBefore;
const client = await startMcp();
const runtime = await connect();
const mm = (v: number[]) => v.map((x) => x * 1000);
const set = await call(client, "plasticity_set_camera", { eyeMm: mm(before.position), targetMm: mm(before.target), frameRadiusMm: 10 });
const after = await runtime.readNative<any>(nativeFunction`function (args) {
  const vp = Array.from(this.viewports)[0]; const c = vp.orbitControls, cam = vp.camera;
  c.zoom = c.zoomEnd = args.zoom; cam.zoom = args.zoom; c.setNeedsUpdate(); c.update(1 / 60); cam.updateProjectionMatrix(); vp.setNeedsRender();
  return { target: cam.target.toArray(), zoom: cam.zoom, q: cam.quaternion.toArray(), position: cam.position.toArray(), undo: this.history.undoStack.length };
}`, [], [{ zoom: before.zoom }], 10000);
save("restore-camera.json", { before, set, after });
console.log(JSON.stringify({ before, after }));
runtime.close(); await client.close(); process.exit(0);
