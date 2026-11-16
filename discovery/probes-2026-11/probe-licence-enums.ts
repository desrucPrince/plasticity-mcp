// Read-only: XNurbs/XSided option enums and the licence predicates (hasXNurbs, isStudioLicense, isIndieLicense).
import { connect, depth, save } from "./harness.ts";
const runtime = await connect();
try {
  const names = ["ContinuityType", "ControlType", "BoundaryCondition", "ParameterizationType", "ConstraintTopologyType", "ConstraintPriority", "hasXNurbs", "isStudioLicense", "isIndieLicense", "isLicenseExpired", "LicenseContext"];
  const out = await runtime.readNative<any>(`function (...bound) {
    const names = bound.pop();
    const res = {};
    const safe = v => { try { return JSON.parse(JSON.stringify(v ?? null)); } catch { return String(v); } };
    bound.forEach((b, i) => {
      const n = names[i];
      if (typeof b === 'function' && !/^[A-Z]/.test(n)) {
        const calls = {};
        for (const [label, argv] of [['noArgs', []], ['editor', [this]], ['editor.license', [this.license]], ['editor.licenseManager', [this.licenseManager]]]) {
          try { calls[label] = safe(b(...argv)); } catch (e) { calls[label] = 'throws: ' + e.message; }
        }
        res[n] = { kind: 'function', length: b.length, calls };
      } else if (typeof b === 'function') res[n] = { kind: 'class', statics: Object.getOwnPropertyNames(b) };
      else res[n] = Object.fromEntries(Object.entries(b ?? {}).filter(([k, v]) => typeof v !== 'object'));
    });
    res.editorLicenceKeys = Object.keys(this).filter(k => /licen|user|account|plan|entitle/i.test(k));
    for (const k of res.editorLicenceKeys) { const v = this[k]; res['editor.' + k] = v && typeof v === 'object' ? { ctor: v.constructor?.name, keys: Object.keys(v).slice(0, 30) } : safe(v); }
    return res;
  }`, names, [names]);
  save("probe-licence-enums.json", { depth: await depth(runtime), out });
  console.log(JSON.stringify(out, null, 1).slice(0, 5000));
} finally { runtime.close(); }
