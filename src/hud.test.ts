import assert from "node:assert/strict";
import test from "node:test";
import { Script } from "node:vm";
import { Hud, HUD_DONE_SHOW_MS, HUD_ERROR_SHOW_MS, HUD_SLOW_MS, HUD_STUCK_MS, hudScript, hudView, type HudFrame, type HudState } from "./hud.ts";

const base: HudState = { op: "fillet", step: null, startedAt: 0, lastActivityAt: 0, finishedAt: null, error: null, progress: null };

test("hud tone follows the time since the last activity", () => {
  assert.equal(hudView(base, 0).tone, "active");
  assert.equal(hudView(base, HUD_SLOW_MS - 1).tone, "active");
  assert.equal(hudView(base, HUD_SLOW_MS).tone, "slow");
  assert.equal(hudView(base, HUD_STUCK_MS - 1).tone, "slow");
  const stuck = hudView(base, HUD_STUCK_MS);
  assert.equal(stuck.tone, "stuck");
  assert.match(stuck.detail, /possibly stuck/);
  // Activity resets the clock even when the job has been running long.
  assert.equal(hudView({ ...base, lastActivityAt: 200_000 }, 210_000).tone, "active");
});

test("hud shows batch steps, elapsed time and external progress", () => {
  const frame = hudView({ ...base, op: "batch", step: { index: 2, total: 12, name: "fillet" }, lastActivityAt: 4_000, progress: "Blender rendering 42%" }, 9_000);
  assert.equal(frame.title, "batch step 3/12: fillet");
  assert.match(frame.detail, /^Blender rendering 42% · elapsed 9s · last activity 5s ago$/);
});

test("hud done and error frames fade after their display time", () => {
  const done = { ...base, finishedAt: 10_000 };
  assert.equal(hudView(done, 10_000).tone, "done");
  assert.match(hudView(done, 10_000).title, /done ✓/);
  assert.equal(hudView(done, 10_000 + HUD_DONE_SHOW_MS - 1).visible, true);
  assert.equal(hudView(done, 10_000 + HUD_DONE_SHOW_MS).visible, false);
  const failed = { ...done, error: "Operation Blend failed" };
  assert.equal(hudView(failed, 10_000).tone, "error");
  assert.equal(hudView(failed, 10_000).detail, "Operation Blend failed");
  assert.equal(hudView(failed, 10_000 + HUD_ERROR_SHOW_MS).visible, false);
  assert.equal(hudView({ ...base, op: null }, 0).visible, false);
});

test("Hud nests calls, reports steps, and ends once the outer job ends", () => {
  let now = 0;
  const frames: HudFrame[] = [];
  const ended: Array<[string, number, string | null]> = [];
  const hud = new Hud((frame) => { frames.push(frame); }, { now: () => now, onLongJobEnd: (op, ms, error) => ended.push([op, ms, error]), longJobMs: 60_000 });
  hud.start("batch");
  hud.step(0, 2, "create_box");
  now = 1_000; hud.start("create_box"); hud.finish();
  assert.equal(hud.frame().title, "batch step 1/2: create_box");
  now = 70_000; hud.step(1, 2, "fillet");
  hud.start("fillet"); hud.fail(new Error("Operation Blend failed"));
  assert.notEqual(hud.frame().tone, "error", "a nested failure is held until the outer job ends");
  hud.fail(new Error("batch failed"));
  assert.equal(hud.frame().tone, "error");
  assert.equal(hud.frame().detail, "Operation Blend failed");
  assert.deepEqual(ended, [["batch", 70_000, "Operation Blend failed"]]);
  assert.ok(frames.length >= 4);
  hud.dispose();
});

test("Hud external progress starts and ends a job without tool calls", () => {
  let now = 5_000;
  const hud = new Hud(() => undefined, { now: () => now });
  hud.progress("Blender rendering 10%", "render");
  assert.equal(hud.frame().title, "render");
  assert.match(hud.frame().detail, /Blender rendering 10%/);
  now = 5_000 + HUD_SLOW_MS;
  assert.equal(hud.frame().tone, "slow");
  hud.progress("Blender rendering 55%");
  assert.equal(hud.frame().tone, "active");
  hud.endExternal();
  assert.equal(hud.frame().tone, "done");
  hud.dispose();
});

test("Hud hideNow draws an instant hidden frame and tick restores the current frame", async () => {
  let now = 0;
  const frames: HudFrame[] = [];
  const hud = new Hud((frame) => { frames.push(frame); }, { now: () => now });
  hud.start("fillet");
  await hud.hideNow();
  assert.deepEqual([frames.at(-1)?.visible, frames.at(-1)?.instant], [false, true]);
  hud.tick();
  assert.equal(frames.at(-1)?.visible, true);
  assert.match(hudScript({ ...frames.at(-1)!, instant: true }), /f.instant \? 'none'/);
  hud.dispose();
});

test("disabled Hud never draws", () => {
  let draws = 0;
  const hud = new Hud(() => { draws += 1; }, { enabled: false });
  hud.start("fillet"); hud.step(0, 1, "x"); hud.progress("y"); hud.finish();
  assert.equal(draws, 0);
});

test("hud script is self-contained and pointer-transparent", () => {
  const script = hudScript({ visible: true, tone: "stuck", title: "fillet", detail: "possibly stuck" });
  assert.match(script, /pointer-events:none/);
  assert.match(script, /plasticity-mcp-hud/);
  assert.match(script, /#ff4d4d/);
  assert.doesNotThrow(() => new Script(script)); // compiles; the payload is JSON-encoded
});
