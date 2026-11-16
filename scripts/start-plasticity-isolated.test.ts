import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIsolatedLaunchArgs, readApplicationVersion, resolveApplicationPath } from "./start-plasticity-isolated.ts";

test("isolated launcher requires an explicit absolute bundle path for a selected copy", () => {
  assert.deepEqual(parseIsolatedLaunchArgs([]), { help: false });
  assert.deepEqual(parseIsolatedLaunchArgs(["--help"]), { help: true });
  assert.deepEqual(parseIsolatedLaunchArgs(["--application", "/tmp/Experimental/Plasticity.app"]), { help: false, applicationPath: "/tmp/Experimental/Plasticity.app" });
  for (const args of [["--application"], ["--application", "Plasticity.app"], ["--application", "/tmp/program"], ["--application", "/tmp/First.app", "--application", "/tmp/Second.app"], ["--patch-fuses"]]) {
    assert.throws(() => parseIsolatedLaunchArgs(args));
  }
});

test("--app is an alias, PLASTICITY_APP_PATH is the fallback, and the default is unchanged", async () => {
  assert.deepEqual(parseIsolatedLaunchArgs(["--app", "/tmp/Beta/Plasticity.app"]), { help: false, applicationPath: "/tmp/Beta/Plasticity.app" });
  for (const args of [["--app"], ["--app", "Plasticity.app"], ["--app", "/tmp/First.app", "--application", "/tmp/Second.app"]]) {
    assert.throws(() => parseIsolatedLaunchArgs(args));
  }
  assert.equal(resolveApplicationPath({}, {}), undefined);
  assert.equal(resolveApplicationPath({}, { PLASTICITY_APP_PATH: "" }), undefined);
  assert.equal(resolveApplicationPath({}, { PLASTICITY_APP_PATH: "/tmp/Env/Plasticity.app" }), "/tmp/Env/Plasticity.app");
  assert.equal(resolveApplicationPath({ applicationPath: "/tmp/Flag.app" }, { PLASTICITY_APP_PATH: "/tmp/Env/Plasticity.app" }), "/tmp/Flag.app");
  assert.throws(() => resolveApplicationPath({}, { PLASTICITY_APP_PATH: "relative/Plasticity.app" }));
  assert.equal(await readApplicationVersion("/nonexistent/Plasticity.app"), null);
});
