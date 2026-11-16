// Read-only: prototype chains of the gap classes, plus own fields of fresh (never committed) factory instances.
import { connect, depth, save } from "./harness.ts";
const runtime = await connect();
const factories = ["SweepFactory", "SweepToolFactory", "XSidedFactory", "ExtendEdgeFactory", "ExtendSheetFactory", "MultiExtendVertexFactory",
  "DimensionDistanceFactory", "DimensionPolylineFactory", "MoveMeasurementFactory", "ShowFacePointsFactory", "MultiMoveControlPointFactory",
  "ConvertMeshToPolySplinesFactory", "ImportPolySplinesFactory", "ExportWebFactory", "ExtrudeSurfaceFactory", "RemoveNominalSurfaceFactory", "RefitSurfaceFactory"];
const enums = ["SweepAlignmentType", "SweepCornerType", "SweepGuideMethod", "ExtensionShape", "BodyExtensionType", "ExtensionLimit", "MeasurementType", "hasXNurbs", "TransformControlPointsMirrorMode", "TransformControlPointsProportionalMode"];
const commands = ["SweepCommand", "XNurbsCommand", "PolySplinesCommand", "ImportPolySplinesCommand", "DimensionDistanceCommand", "DimensionPolylineCommand", "MoveMeasurementCommand", "ExtendSheetCommand", "MoveControlPointCommand"];
try {
  const before = await depth(runtime);
  const caps = new Set(runtime.getCapabilities());
  const present = factories.filter((n) => caps.has(n));
  const presentEnums = enums.filter((n) => caps.has(n));
  const out = await runtime.readNative<any>(`function (...args) {
    const names = args.pop();
    const enumNames = names.enums;
    const facs = args.slice(0, names.factories.length);
    const ens = args.slice(names.factories.length);
    const show = (v) => v === null || v === undefined ? String(v) : typeof v === 'object' ? (v.constructor?.name ?? 'object') + (Array.isArray(v) ? '[' + v.length + ']' : '') : typeof v === 'function' ? 'fn' : v;
    const chainOf = (cls) => {
      const chain = [];
      let p = cls.prototype;
      while (p && p !== Object.prototype) {
        const entry = { name: p.constructor?.name, methods: [], accessors: [] };
        for (const key of Object.getOwnPropertyNames(p)) {
          if (key === 'constructor') continue;
          const d = Object.getOwnPropertyDescriptor(p, key);
          if (d.get || d.set) entry.accessors.push(key + ':' + (d.get ? 'g' : '') + (d.set ? 's' : '')); else if (typeof d.value === 'function') entry.methods.push(key);
        }
        chain.push(entry);
        p = Object.getPrototypeOf(p);
      }
      return chain;
    };
    const result = { factories: {}, enums: {}, commands: {} };
    facs.forEach((cls, i) => {
      const name = names.factories[i];
      const info = { chain: chainOf(cls).filter(e => !['GeometryFactory','AbstractFactory','CancellableRegisterable','ResourceRegistration','Registerable'].includes(e.name)).slice(0, 4), fields: null, getters: {} };
      let f;
      try {
        f = new cls(this);
        info.fields = Object.fromEntries(Object.keys(f).map(k => [k, show(f[k])]));
        for (const e of chainOf(cls).slice(0, 2)) for (const a of e.accessors) {
          const k = a.split(':')[0];
          if (a.endsWith('g') || a.endsWith('gs')) { try { info.getters[k] = show(f[k]); } catch (err) { info.getters[k] = 'throws: ' + err.message; } }
        }
      } catch (err) { info.fields = 'construct error: ' + err.message; }
      finally { try { f?.cancel?.(); } catch {} }
      result.factories[name] = info;
    });
    ens.forEach((e, i) => {
      const name = enumNames[i];
      if (typeof e === 'function') result.enums[name] = 'function: ' + String(e).slice(0, 400);
      else if (e && typeof e === 'object') result.enums[name] = Object.fromEntries(Object.entries(e).filter(([k, v]) => typeof v !== 'object').slice(0, 60));
      else result.enums[name] = e;
    });
    for (const name of names.commands) {
      const cls = this.commands?.[name];
      if (!cls) { result.commands[name] = 'absent from editor.commands'; continue; }
      const c = { chain: chainOf(cls).slice(0, 3).map(e => ({ name: e.name, methods: e.methods })), executeSource: String(cls.prototype.execute ?? '').slice(0, 1500) };
      result.commands[name] = c;
    }
    return result;
  }`, [...present, ...presentEnums], [{ factories: present, enums: presentEnums, commands }]);
  const after = await depth(runtime);
  save("describe-classes.json", { before, after, missingFactories: factories.filter((n) => !caps.has(n)), missingEnums: enums.filter((n) => !caps.has(n)), out });
} finally { runtime.close(); }
