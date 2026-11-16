// Gap 8: ExportWebFactory. Network exits (fetch, XMLHttpRequest.send, WebSocket.send, sendBeacon) are stubbed to log and
// reject for the duration of the call and restored in finally. Prototype reads are traced to learn its inputs.
import { connect, depth, save, mcp, newBodies, undoTo, errText, nativeFunction, TRACE } from "./harness.ts";
const runtime = await connect();
const start = await depth(runtime);
const log: any = { start, runs: {} };
let session: Awaited<ReturnType<typeof mcp>> | undefined;
const OUT = "/private/tmp/claude-501/plasticity-probe-state/export-web";
async function run(label: string, setup: string, args: any = {}) {
  const entry: any = {};
  try {
    entry.native = await runtime.mutate(nativeFunction`async function (Factory, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const find = id => { for (const [v, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(v) === id) return item.view; throw new Error('Unknown body ' + id); };
      const g = globalThis, exits = [];
      const saved = { fetch: g.fetch, xhrSend: g.XMLHttpRequest?.prototype.send, xhrOpen: g.XMLHttpRequest?.prototype.open, wsSend: g.WebSocket?.prototype.send, beacon: g.navigator?.sendBeacon, open: g.open };
      g.fetch = async (...a) => { exits.push({ via: 'fetch', url: String(a[0]?.url ?? a[0]).slice(0, 200), method: a[1]?.method }); throw new Error('probe: network blocked'); };
      if (g.XMLHttpRequest) { g.XMLHttpRequest.prototype.open = function (m, u) { this.__probe = { m, u: String(u).slice(0, 200) }; return saved.xhrOpen.apply(this, arguments); }; g.XMLHttpRequest.prototype.send = function () { exits.push({ via: 'xhr', ...this.__probe }); throw new Error('probe: network blocked'); }; }
      if (g.WebSocket) g.WebSocket.prototype.send = function () { exits.push({ via: 'websocket', url: this.url }); throw new Error('probe: network blocked'); };
      if (g.navigator?.sendBeacon) g.navigator.sendBeacon = (u) => { exits.push({ via: 'beacon', url: String(u) }); return false; };
      g.open = (u) => { exits.push({ via: 'window.open', url: String(u) }); return null; };
      const factory = new Factory(this);
      ${TRACE}
      const out = { exits };
      try {
        ${setup}
        const r = await Promise.race([factory.commit(), new Promise((_, rej) => setTimeout(() => rej(new Error('commit timeout 10s')), 10000))]);
        out.result = r === undefined ? 'undefined' : r?.constructor?.name;
        if (r && typeof r === 'object') { out.resultKeys = Object.keys(r).slice(0, 30); out.byteLength = r.byteLength ?? r.length ?? null; }
      } catch (e) { out.error = String(e?.message ?? e).slice(0, 500); }
      finally {
        g.fetch = saved.fetch;
        if (g.XMLHttpRequest) { g.XMLHttpRequest.prototype.send = saved.xhrSend; g.XMLHttpRequest.prototype.open = saved.xhrOpen; }
        if (g.WebSocket) g.WebSocket.prototype.send = saved.wsSend;
        if (saved.beacon) g.navigator.sendBeacon = saved.beacon;
        g.open = saved.open;
        try { factory.cancel(); } catch {}
      }
      out.protoReads = __reads;
      out.ownFieldsAfter = Object.keys(factory);
      return out;
    }`, ["ExportWebFactory"], [args], 20000);
  } catch (error) { entry.error = errText(error); }
  entry.depthAfter = await depth(runtime);
  log.runs[label] = entry;
  console.log(label, JSON.stringify(entry).slice(0, 1500));
}
try {
  await run("bare_commit", ``);
  session = await mcp();
  const baseIds = new Set<number>((await session.raw("plasticity_status", { bodyLimit: 200 })).bodies.map((b: any) => b.id));
  const st = await newBodies(session, baseIds);
  await session.raw("plasticity_create_box", { originMm: [3200, 0, 0], sizeMm: [10, 10, 10], revision: st.revision });
  const box = (await newBodies(session, baseIds)).bodies[0];
  await run("items_and_filePath", `factory.items = [find(args.box)]; factory.filePath = args.out + '/probe.web';`, { box: box.id, out: OUT });
} catch (error) { log.fatal = errText(error); console.error(error); }
finally {
  try { await session?.close(); } catch {}
  log.end = await undoTo(runtime, start.undo);
  log.endOk = log.end.undo === start.undo && log.end.bodies === start.bodies;
  save("probe-export-web.json", log);
  runtime.close();
  process.exit(0);
}
