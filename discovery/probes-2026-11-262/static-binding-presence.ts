// Static, read-only proxy for bindings-check.ts when a build cannot be driven live (for example a licence window blocks the editor).
// (26.2.7 stable keeps its code in an encrypted PLSEC001 pack; it cannot be scanned.) Reports whether each binding name appears as a byte string in the build's compiled renderer bundle. Presence of a
// string is NOT proof that the native binding resolves on the store route; it only shows the name exists in that build.
//   node discovery/probes-2026-11-262/static-binding-presence.ts <bindings-26.1.3.json> <out.json> <label=App.app>...
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const [bindingsPath, out, ...apps] = process.argv.slice(2);
if (!bindingsPath || !out || apps.length === 0) { console.error("usage: <bindings.json> <out.json> <label=/path/App.app>..."); process.exit(2); }
// Alias targets used by native-discovery.ts on 26.2 are checked too.
const names = [...new Set([...Object.keys(JSON.parse(readFileSync(bindingsPath, "utf8")).bindings), "CutFactory", "MoveControlPointFactory"])];
const result: Record<string, Record<string, boolean>> = {};
for (const spec of apps) {
  const [label, app] = spec.split("=");
  // Unpacked builds keep the bytecode as a file; packaged builds keep it inside app.asar (scanned as a whole).
  const unpacked = `${app}/Contents/Resources/app/.webpack/renderer/app_window.compiled/index.jsc`;
  const bundle = existsSync(unpacked) ? readFileSync(unpacked) : readFileSync(`${app}/Contents/Resources/app.asar`);
  const text = bundle.toString("latin1");
  result[label!] = Object.fromEntries(names.map((name) => [name, new RegExp(`(?<![A-Za-z0-9_$])${name.replace(/\$/g, "\\$")}(?![A-Za-z0-9_$])`).test(text)]));
}
writeFileSync(out, JSON.stringify({ note: "string presence in compiled renderer bundle; not live resolution", result }, null, 1));
for (const [label, table] of Object.entries(result)) console.log(label, "absent:", Object.entries(table).filter(([, present]) => !present).map(([name]) => name).join(", ") || "none");
