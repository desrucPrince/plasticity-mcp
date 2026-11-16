// Reference-build self test: build a deterministic reference, run the real verifier on it, print every check, restore the document.
// Usage: node selftest.ts <s1|s2|m>   -> output file reference-<name>-selftest.json
import { makeCtx, withSession, restore, type Check } from "./common.ts";
import { s1Reference, s2Reference, s3Reference } from "./reference.ts";
import { verifyS1, verifyS2, verifyS3 } from "./verify.ts";
import { mReference } from "./reference-m.ts";
import { verifyM } from "./verify-m.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const which = process.argv[2] ?? "s2";
const scratch = mkdtempSync(join(tmpdir(), "bench-selftest-"));
const cwd = join(scratch, "cwd"); mkdirSync(cwd);
const ctx = makeCtx(undefined, join(scratch, "history"), cwd); mkdirSync(ctx.historyRoot);
const start = await withSession(ctx, (s) => s.status());
ctx.base = { undoDepth: start.undoDepth, ids: start.bodies.map((b) => b.id).sort((a, b) => a - b).join(","), bodyCount: start.bodies.length };
console.error(`start undoDepth ${ctx.base.undoDepth} bodies ${ctx.base.bodyCount}`);
let checks: Check[] = []; let error: string | undefined;
try {
  await withSession(ctx, async (s) => {
    if (which === "s2") {
      const { steps, padStep } = s2Reference();
      const r = await s.batch(steps, { undoOnError: true });
      checks = await verifyS2(s, r.steps[padStep].added[0]);
    } else if (which === "s1") {
      const { steps, solidStep } = s1Reference();
      const r = await s.batch(steps, { undoOnError: true });
      checks = await verifyS1(s, r.steps[solidStep].added[0]);
    } else if (which === "s3") {
      const { steps, bodyStep, geometry } = s3Reference();
      const r = await s.batch(steps, { undoOnError: true });
      checks = await verifyS3(s, r.steps[bodyStep].added[0], geometry.holeMid);
    } else if (which === "m" || which === "mneg") {
      const { parts } = mReference();
      const t0 = Date.now();
      for (const p of parts) await s.batch(p.steps, { undoOnError: true });
      console.error(`M reference built in ${Date.now() - t0} ms, ${parts.map((p) => p.steps.length).join("+")} steps`);
      if (which === "mneg") { // negative control: sink the pod 1 mm into the lid, shift the lid 0.5 mm in x
        const st = await s.status(); const id = (n: string) => st.bodies.find((b) => b.name === n)!.id;
        await s.batch([{ toolName: "plasticity_move", arguments: { ids: [id("sensor-pod")], deltaMm: [0, 0, -1] } }, { toolName: "plasticity_move", arguments: { ids: [id("lid")], deltaMm: [0.5, 0, 0] } }]);
      }
      const v = await verifyM(s);
      checks = v.checks; console.error(`scale ${JSON.stringify(v.scale)}`);
    }
  });
} catch (e) { error = String(e).slice(0, 2000); }
const restored = await restore(ctx);
const hard = checks.filter((c) => !c.soft);
const res = { which, passed: hard.filter((c) => c.ok).length, of: hard.length, checks, error, restored, startUndoDepth: ctx.base.undoDepth, startBodies: ctx.base.bodyCount };
writeFileSync(join(HERE, `reference-${which}-selftest.json`), JSON.stringify(res, null, 1));
for (const c of checks) console.log(`${c.ok ? "PASS" : c.soft ? "info" : "FAIL"}  ${c.check} :: ${JSON.stringify(c.actual)}`);
console.log(`${which}: ${res.passed}/${res.of} hard checks passed; error=${error ?? "none"}; restored=${JSON.stringify(restored)}`);
