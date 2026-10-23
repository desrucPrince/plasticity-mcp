// Read-only: builds an uncommitted ExtrudeFactory on given region ids and prints its direction.
// Usage: PLASTICITY_CDP_URL=... node discovery/probe-extrude-direction.ts <regionId> ...
import { discoverPlasticityTargets } from "../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../src/plasticity/runtime.ts";
const [target] = await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
if (!target) throw new Error("no window");
const runtime = await PlasticityRuntime.connect(target);
try {
  const out = await runtime.readNative(`function (Factory, ...ids) {
    const v = (x) => x ? [x.x, x.y, x.z].map(n => Math.round(n * 1000) / 1000) : null;
    return ids.map(regionId => {
      let region;
      for (const [versionId, item] of this.geo.geometryModel) {
        if (!this.geo.automatics.has(versionId) || item.view?.constructor?.name !== 'SketchIsland') continue;
        for (let i = 0; i < (item.view.regions?.length ?? 0); i += 1) {
          const r = item.view.regions.get(i);
          if (r && String(r.versionId) === regionId) region = r;
        }
      }
      if (!region) return { regionId, error: 'not found' };
      const factory = new Factory(this);
      try {
        factory.regions = [region];
        factory.distance1 = 0.002;
        return { regionId, direction: v(factory.direction), gizmo: v(factory.gizmoDirection), center: v(factory.center) };
      } finally { try { factory.cancel(); } catch {} }
    });
  }`, ["ExtrudeFactory"], process.argv.slice(2));
  console.log(JSON.stringify(out));
} finally { runtime.close(); }
