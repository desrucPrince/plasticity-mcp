import assert from "node:assert/strict";
import { test } from "node:test";

import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";
import { SCREENSHOT_SHADERS, SCREENSHOT_VIEW_SOURCE, validateScreenshotView, withScreenshotView } from "./surfacing.ts";

// plasticity_screenshot shader/frame (P4): the native source runs against a stub editor; the host wrapper restores on failure.

class V3 {
  x = 0; y = 0; z = 0;
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
class Q { a = [0, 0, 0, 1]; toArray() { return [...this.a]; } }

function stubEditor(options: { shaders?: Record<string, { name: string }>; undoGrows?: boolean } = {}) {
  const name2shader = options.shaders ?? Object.fromEntries(SCREENSHOT_SHADERS.map((name) => [name, { name }]));
  let current: { name: string } | null = null;
  let undo = 7;
  const log: string[] = [];
  const shading = {
    saveToMemento: () => ({ shader: current }),
    setShader: (material: { name: string }) => { log.push(`set:${material.name}`); current = material; },
    restoreFromMemento: (memento: { shader: { name: string } | null }) => { log.push(`restore:${memento.shader?.name ?? "default"}`); current = memento.shader; },
  };
  // The camera looks from position toward controls.target + focalOffset; update() derives position from the orbit state.
  const controls = {
    target: new V3(0.04, 0.015, 0.015), targetEnd: new V3(), focalOffset: new V3(), focalOffsetEnd: new V3(), radius: 0.1, radiusEnd: 0.1, zoom: 66, zoomEnd: 66, dir: new V3(0.6, -0.8, 0),
    setQuaternion(q: Q & { dir?: V3 }) { if (q.dir) this.dir = q.dir.clone(); },
    setNeedsUpdate() {}, update() { camera.target.copy(this.target).addScaledVector(this.focalOffset, 1); camera.position.copy(camera.target).addScaledVector(this.dir, this.radius); camera.quaternion.a = [this.dir.x, this.dir.y, this.dir.z, 0]; },
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
  const viewport = { camera, orbitControls: controls, setNeedsRender() { log.push("render"); } };
  const editor = {
    viewports: [viewport], shading,
    history: { get undoStack() { return { length: options.undoGrows ? undo++ : undo }; } },
    geo: { geometryModel: new Map([[17, { model: { FindBox: () => ({ min: { x: 5, y: 0, z: 0 }, max: { x: 5.02, y: 0.02, z: 0.02 } }) } }]]), automatics: new Set() },
    db: { lookupStableId: (versionId: number) => (versionId === 17 ? 7 : undefined), commit() {} },
  };
  const runtime = {
    async readNative(source: string, bindings: string[], values: unknown[]) {
      assert.deepEqual(bindings, ["name2shader"]);
      const execute = new Function(`return (${source})`)() as (...args: unknown[]) => Promise<unknown>;
      return await execute.apply(editor, [name2shader, ...values]);
    },
  } as unknown as PlasticityRuntime;
  return { runtime, log, camera, controls, current: () => current };
}

const KEY = Symbol.for("plasticity-mcp.screenshot-view");

test("shader capture: set, render, capture, restore the previous shader; nothing left on the renderer global", async () => {
  const stub = stubEditor();
  let seenDuringCapture: string | null = "unset";
  const result = await withScreenshotView(stub.runtime, { shader: "zebraVertical" }, async () => { seenDuringCapture = stub.current()?.name ?? null; return { path: "/x.png", bytes: 10 }; });
  assert.equal(seenDuringCapture, "zebraVertical");
  assert.equal(stub.current(), null);
  assert.deepEqual(result, { path: "/x.png", bytes: 10, view: { shader: { mode: "zebraVertical", previous: null, restored: null } } });
  assert.deepEqual(stub.log.filter((entry) => entry !== "render"), ["set:zebraVertical", "restore:default"]);
  assert.equal((globalThis as Record<symbol, unknown>)[KEY], undefined);
});

test("the previous shader comes back also when the capture fails, and the capture error is kept", async () => {
  const stub = stubEditor();
  await assert.rejects(withScreenshotView(stub.runtime, { shader: "topo" }, async () => { throw new Error("Refusing to overwrite existing file"); }), /Refusing to overwrite/);
  assert.equal(stub.current(), null);
  assert.deepEqual(stub.log.filter((entry) => entry !== "render"), ["set:topo", "restore:default"]);
  assert.equal((globalThis as Record<symbol, unknown>)[KEY], undefined);
});

test("a view change left by a crashed call is restored before the next one", async () => {
  const stub = stubEditor();
  await assert.rejects(withScreenshotView(stub.runtime, { shader: "draft" }, async () => { throw new Error("boom"); }), /boom/);
  // Simulate a crash between apply and restore: apply only.
  await stub.runtime.readNative(SCREENSHOT_VIEW_SOURCE, ["name2shader"], [{ op: "apply", shader: "isophotes" }]);
  assert.equal(stub.current()?.name, "isophotes");
  await withScreenshotView(stub.runtime, { shader: "topo" }, async () => ({ ok: true }));
  assert.equal(stub.current(), null);
  assert.deepEqual(stub.log.filter((entry) => entry !== "render").slice(-4), ["set:isophotes", "restore:default", "set:topo", "restore:default"]);
});

test("frame aims at the bodies' box and puts the camera back exactly", async () => {
  const stub = stubEditor();
  const before = { p: stub.camera.position.toArray(), t: stub.camera.target.toArray(), z: stub.camera.zoom };
  let during: number[] = [];
  const result = await withScreenshotView(stub.runtime, { frame: { bodyIds: [7] } }, async () => { during = stub.camera.target.toArray(); return {}; });
  assert.deepEqual(during.map((v) => Math.round(v * 1e6) / 1e6), [5.01, 0.01, 0.01]);
  const close = (a: number[], b: number[]) => a.every((value, index) => Math.abs(value - b[index]!) <= 1e-12);
  assert.ok(close(stub.camera.position.toArray(), before.p), String(stub.camera.position.toArray()));
  assert.ok(close(stub.camera.target.toArray(), before.t));
  assert.equal(stub.camera.zoom, before.z);
  assert.deepEqual(result.view.frame?.bodyIds, [7]);
  assert.equal(result.view.frame?.cameraRestored, true);
  assert.ok(result.view.frame!.cameraDeviation <= 1e-9);
});

test("an Undo depth change or an unknown shader fails the call; the view is still restored", async () => {
  const grows = stubEditor({ undoGrows: true });
  await assert.rejects(withScreenshotView(grows.runtime, { shader: "draft" }, async () => ({})), /changed the Undo depth/);
  assert.equal(grows.current(), null);
  const missing = stubEditor({ shaders: { draft: { name: "draft" } } });
  await assert.rejects(withScreenshotView(missing.runtime, { shader: "topo" }, async () => ({})), /no topo shader \(available: draft\)/);
  assert.equal((globalThis as Record<symbol, unknown>)[KEY], undefined);
});

test("validateScreenshotView rejects bad shaders and frames before any native call", () => {
  const state = { bodies: [{ id: 7 }, { id: 8 }] } as unknown as RuntimeState;
  assert.throws(() => validateScreenshotView({ shader: "curvature" as never }, state), /shader must be one of: isophotes, draft, faceDirection, zebraVertical, zebraHorizontal, topo/);
  assert.throws(() => validateScreenshotView({ frame: { bodyIds: [] } }, state), /1-64/);
  assert.throws(() => validateScreenshotView({ frame: { bodyIds: [7, 7] } }, state), /unique/);
  assert.throws(() => validateScreenshotView({ frame: { bodyIds: [9] } }, state), /current body IDs: 9/);
  validateScreenshotView({ shader: "topo", frame: { bodyIds: [7, 8] } }, state);
});
