import assert from "node:assert/strict";
import { test } from "node:test";

import { discoverOrLaunch, RUNNING_WITHOUT_CDP_MESSAGE, unlockMainProcess, type DiscoverOrLaunchDependencies, type InspectorClient } from "./launcher.ts";

test("unlocks renderer CDP before resuming Plasticity main", async () => {
  const calls: string[] = [];
  let paused: ((params: unknown) => void) | undefined;
  const client: InspectorClient = {
    on(method, listener) {
      assert.equal(method, "Debugger.paused");
      paused = listener;
      return () => {};
    },
    async send(method) {
      calls.push(method);
      if (method === "Runtime.runIfWaitingForDebugger") {
        paused?.({ callFrames: [{ callFrameId: "frame-1" }] });
      }
      if (method === "Debugger.evaluateOnCallFrame") {
        return { result: { value: { patched: true, port: "9223" } } };
      }
      return {};
    },
  };

  await unlockMainProcess(client, 9223);

  assert.deepEqual(calls, [
    "Runtime.enable",
    "Debugger.enable",
    "Runtime.runIfWaitingForDebugger",
    "Debugger.evaluateOnCallFrame",
    "Debugger.resume",
  ]);
});

const target = { id: "t1", title: "Untitled - Plasticity", url: "file:///app_window/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/t1" };

function fakeDependencies(state: { targets: typeof target[] | Error; running: boolean }) {
  const calls: string[] = [];
  const dependencies: DiscoverOrLaunchDependencies = {
    async discover() { calls.push("discover"); if (state.targets instanceof Error) throw state.targets; return state.targets; },
    async isRunning() { calls.push("isRunning"); return state.running; },
    async launch() { calls.push("launch"); return [target]; },
  };
  return { calls, dependencies };
}

test("returns reachable windows without launching", async () => {
  const { calls, dependencies } = fakeDependencies({ targets: [target], running: true });
  assert.deepEqual(await discoverOrLaunch("http://127.0.0.1:9223", true, dependencies), [target]);
  assert.deepEqual(calls, ["discover"]);
});

test("launches Plasticity when no process is running", async () => {
  const { calls, dependencies } = fakeDependencies({ targets: new Error("ECONNREFUSED"), running: false });
  assert.deepEqual(await discoverOrLaunch("http://127.0.0.1:9223", true, dependencies), [target]);
  assert.deepEqual(calls, ["discover", "isRunning", "launch"]);
});

test("never launches over a running Plasticity without CDP", async () => {
  const { calls, dependencies } = fakeDependencies({ targets: new Error("ECONNREFUSED"), running: true });
  await assert.rejects(discoverOrLaunch("http://127.0.0.1:9223", true, dependencies), { message: RUNNING_WITHOUT_CDP_MESSAGE });
  assert.deepEqual(calls, ["discover", "isRunning"]);
});

test("returns an empty list when CDP is up but no document window is open", async () => {
  const { calls, dependencies } = fakeDependencies({ targets: [], running: true });
  assert.deepEqual(await discoverOrLaunch("http://127.0.0.1:9223", true, dependencies), []);
  assert.deepEqual(calls, ["discover", "isRunning"]);
});

test("auto-launch disabled keeps the original discovery behavior", async () => {
  const refused = fakeDependencies({ targets: new Error("ECONNREFUSED"), running: false });
  await assert.rejects(discoverOrLaunch("http://127.0.0.1:9223", false, refused.dependencies), { message: "ECONNREFUSED" });
  assert.deepEqual(refused.calls, ["discover"]);
  const empty = fakeDependencies({ targets: [], running: false });
  assert.deepEqual(await discoverOrLaunch("http://127.0.0.1:9223", false, empty.dependencies), []);
  assert.deepEqual(empty.calls, ["discover"]);
});
