// Gaps 6/7: which factory class does each native command construct? Wrap the shared resource() method,
// record the first factory a command registers, then abort it with a marker error. Nothing commits.
import { connect, depth, save, errText, nativeFunction } from "./harness.ts";
const runtime = await connect();
const start = await depth(runtime);
const log: any = { start, commands: {} };
try {
  for (const spec of [{ name: "PolySplinesCommand" }, { name: "XNurbsCommand" }, { binding: "ImportPolySplinesCommand" }, { name: "SweepToolCommand" }, { name: "TogglePointsCommand" }, { name: "PatchCommand" }, { name: "ExtendCommand" }]) {
    const label = spec.name ?? spec.binding!;
    try {
      log.commands[label] = await runtime.mutate(nativeFunction`async function (SweepFactory, ImportPolySplinesCommand, args) {
        if (this.executor.isBusy) throw new Error('Plasticity is busy');
        let owner = SweepFactory.prototype;
        while (owner && !Object.prototype.hasOwnProperty.call(owner, 'resource')) owner = Object.getPrototypeOf(owner);
        if (!owner) throw new Error('resource() owner not found');
        const original = owner.resource;
        const marker = '__PROBE_FACTORY__';
        const seen = [];
        owner.resource = function (...a) {
          const fields = {};
          for (const k of Object.keys(this)) { const v = this[k]; fields[k] = v === null || v === undefined ? String(v) : typeof v === 'object' ? v.constructor?.name : typeof v === 'function' ? 'fn' : v; }
          const chain = []; let p = Object.getPrototypeOf(this); while (p && p !== Object.prototype && chain.length < 4) { chain.push(p.constructor?.name); p = Object.getPrototypeOf(p); }
          seen.push({ chain, fields });
          throw new Error(marker);
        };
        const Command = args.spec.binding ? ImportPolySplinesCommand : this.commands[args.spec.name];
        const command = new Command(this);
        let error = null, timedOut = false;
        try { await Promise.race([command.execute(), new Promise((_, r) => setTimeout(() => { timedOut = true; r(new Error('timeout 3s')); }, 3000))]); }
        catch (e) { if (String(e?.message ?? e) !== marker) error = String(e?.message ?? e).slice(0, 300); }
        finally { owner.resource = original; try { command.cancel(); } catch {} }
        return { resourceOwner: owner.constructor?.name, factories: seen, error, timedOut, busy: this.executor.isBusy };
      }`, ["SweepFactory", "ImportPolySplinesCommand"], [{ spec }], 15000);
    } catch (error) { log.commands[label] = { error: errText(error) }; }
    console.log(label, JSON.stringify(log.commands[label]).slice(0, 1500));
  }
} finally {
  log.end = await depth(runtime);
  log.endOk = log.end.undo === start.undo && log.end.bodies === start.bodies;
  save("probe-command-factories.json", log);
  runtime.close();
  process.exit(0);
}
