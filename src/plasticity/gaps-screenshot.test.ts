import assert from "node:assert/strict";
import { test } from "node:test";

import type { PlasticityRuntime } from "./runtime.ts";
import { withScreenshotView } from "./surfacing.ts";

// G2: plasticity_screenshot frame. A camera still easing toward its end pose (plasticity_set_view right before) used to
// make the restore miss by millimetres and the call fail after the PNG was written. The pose is now saved once it holds
// still, and a restore that is still not exact returns the image with cameraRestored false.

class V3 {
  x: number; y: number; z: number;
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; }
  fromArray(a: number[]) { return this.set(a[0]!, a[1]!, a[2]!); }
  toArray() { return [this.x, this.y, this.z]; }
  clone() { return new V3(this.x, this.y, this.z); }
  copy(v: V3) { return this.set(v.x, v.y, v.z); }
  sub(v: V3) { return this.set(this.x - v.x, this.y - v.y, this.z - v.z); }
  length() { return Math.hypot(this.x, this.y, this.z); }
  normalize() { const l = this.length() || 1; return this.set(this.x / l, this.y / l, this.z / l); }
  addScaledVector(v: V3, s: number) { return this.set(this.x + v.x * s, this.y + v.y * s, this.z + v.z * s); }
}
class Q { a = [0, 0, 0, 1]; toArray() { return [...this.a]; } fromArray(values: number[]) { this.a = [...values]; return this; } }

function stub(options: { easing: boolean }) {
  const drift = { on: false };
  const controls = {
    target: new V3(0.04, 0.015, 0.015), targetEnd: new V3(0.04, 0.015, 0.015), focalOffset: new V3(), focalOffsetEnd: new V3(),
    radius: options.easing ? 0.3 : 0.1, radiusEnd: 0.1, zoom: 66, zoomEnd: 66, dir: new V3(0.6, -0.8, 0),
    setQuaternion(q: Q & { dir?: V3 }) { if (q.dir) this.dir = q.dir.clone(); },
    setNeedsUpdate() {},
    update() {
      // The orbit controls ease the radius toward radiusEnd, as they do after a view change.
      const gap = this.radiusEnd - this.radius;
      this.radius = Math.abs(gap) < 1e-13 ? this.radiusEnd : this.radius + gap * 0.5;
      camera.target.copy(this.target).addScaledVector(this.focalOffset, 1);
      camera.position.copy(camera.target).addScaledVector(this.dir, this.radius);
      if (drift.on) camera.position.x += 1e-6;
      camera.quaternion.a = [this.dir.x, this.dir.y, this.dir.z, 0];
    },
  };
  const camera = {
    position: new V3(), target: new V3(), quaternion: new Q(), zoom: 66, orthographic: { left: -1, right: 1, top: 0.7, bottom: -0.7 },
    updateProjectionMatrix() {},
    clone() {
      const aim = { position: new V3(), up: new V3(), quaternion: new Q() as Q & { dir?: V3 }, lookAt(t: V3) { aim.quaternion.dir = aim.position.clone().sub(t).normalize(); } };
      return aim;
    },
  };
  controls.update();
  const editor = {
    viewports: [{ camera, orbitControls: controls, setNeedsRender() {} }],
    shading: { saveToMemento: () => ({ shader: null }), setShader() {}, restoreFromMemento() {} },
    history: { get undoStack() { return { length: 7 }; } },
    geo: { geometryModel: new Map([[17, { model: { FindBox: () => ({ min: { x: 5, y: 0, z: 0 }, max: { x: 5.02, y: 0.02, z: 0.02 } }) } }]]), automatics: new Set() },
    db: { lookupStableId: (versionId: number) => (versionId === 17 ? 7 : undefined), commit() {} },
  };
  const runtime = {
    async readNative(source: string, _bindings: string[], values: unknown[]) {
      const execute = new Function(`return (${source})`)() as (...args: unknown[]) => Promise<unknown>;
      return await execute.apply(editor, [{}, ...values]);
    },
  } as unknown as PlasticityRuntime;
  return { runtime, camera, controls, drift };
}

async function withFrames<T>(controls: { update(): void }, run: () => Promise<T>): Promise<T> {
  const globals = globalThis as { requestAnimationFrame?: (callback: () => void) => void };
  const saved = globals.requestAnimationFrame;
  globals.requestAnimationFrame = (callback) => { controls.update(); callback(); };
  try { return await run(); } finally { if (saved) globals.requestAnimationFrame = saved; else delete globals.requestAnimationFrame; }
}

test("a camera still easing when the call starts is settled first and comes back exactly", async () => {
  const s = stub({ easing: true });
  const startRadius = s.controls.radius;
  const result = await withFrames(s.controls, async () => await withScreenshotView(s.runtime, { frame: { bodyIds: [7] } }, async () => ({ path: "/x.png", bytes: 10 })));
  assert.equal(result.view.frame?.cameraRestored, true);
  assert.equal(result.view.frame?.cameraSettled, true);
  assert.ok(result.view.frame!.cameraDeviation <= 1e-9);
  assert.ok(Math.abs(s.controls.radius - 0.1) < 1e-9 && startRadius > 0.15, "the camera ended at its end pose, not at the mid-motion pose");
  assert.deepEqual(result.path, "/x.png");
});

test("a camera that cannot come back exactly returns the written image with cameraRestored false and the deviation", async () => {
  const s = stub({ easing: false });
  const result = await withFrames(s.controls, async () => await withScreenshotView(s.runtime, { frame: { bodyIds: [7] } }, async () => { s.drift.on = true; return { path: "/y.png", bytes: 11 }; }));
  assert.equal(result.path, "/y.png");
  assert.equal(result.view.frame?.cameraRestored, false);
  assert.ok(result.view.frame!.cameraDeviation > 1e-9);
  assert.deepEqual(result.view.frame?.bodyIds, [7]);
});

test("a camera that never holds still within the budget is reported, not turned into an error", async () => {
  const s = stub({ easing: false });
  const globals = globalThis as { requestAnimationFrame?: (callback: () => void) => void };
  globals.requestAnimationFrame = (callback) => { s.camera.position.x += 1e-3; callback(); };
  try {
    const result = await withScreenshotView(s.runtime, { frame: { bodyIds: [7] } }, async () => ({ path: "/z.png" }));
    assert.equal(result.view.frame?.cameraSettled, false);
    // The settle budget is 2 s; the camera then moves 1 mm on each of the six frames the restore renders.
    assert.ok(result.view.frame!.cameraSettleWaitMs! >= 2000 && result.view.frame!.cameraSettleWaitMs! < 2600, `waited ${result.view.frame!.cameraSettleWaitMs} ms`);
    assert.equal(result.view.frame?.cameraRestored, false);
    assert.ok(Math.abs(result.view.frame!.cameraDeviation - 0.006) < 1e-9, `deviation ${result.view.frame!.cameraDeviation}`);
    assert.equal(result.path, "/z.png");
  } finally { delete globals.requestAnimationFrame; }
});
