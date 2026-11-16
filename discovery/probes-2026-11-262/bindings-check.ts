// Read-only. Which native bindings do this fork's added/changed tools need, and does each resolve on a connected build?
//
//   node discovery/probes-2026-11-262/bindings-check.ts collect  <label> <out.json>   (needs PLASTICITY_CDP_URL of an ISOLATED instance)
//   node discovery/probes-2026-11-262/bindings-check.ts merge    <a.json> <b.json> <out.json>
//
// "collect" starts the MCP server of THIS tree (scripts/run-server.ts) against the isolated instance and pages
// plasticity_capabilities. It never creates, edits or saves anything. The binding list per tool is derived from
// src/plasticity/operations.ts with the TypeScript AST (second argument of runtime.mutate/readNative, plus the
// command/dialog names of a PickCommandSpec), following this.<method>() calls inside the class.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// tool -> seed methods (operations.ts) whose binding arrays belong to it.
const TOOLS: Record<string, string[]> = {
  sweepCurves: ["sweepCurves"],
  "sweepRegions (guides)": ["sweepRegions"],
  extendSheetEdges: ["extendSheetEdges"],
  xsidedPatch: ["xsidedPatch"],
  convertReferenceMeshToPolySplines: ["convertReferenceMeshToPolySplines"],
  showFaceControlPoints: ["showFaceControlPoints"],
  hideFaceControlPoints: ["hideFaceControlPoints"],
  moveFaceControlPoints: ["moveFaceControlPoints"],
  moveMeasurementLabel: ["moveMeasurementLabel"],
  setDrivingDistance: ["setDrivingDistance", "runPickCommand"],
  exportIges: ["exportIges"],
  exportSat: ["exportSat"],
  clearSelection: ["clearSelection"],
  createControlPointCurve: ["createControlPointCurve"],
  knifeCurve: ["knifeCurve"],
  cutWithCurves: ["cutWithCurves"],
  extrudeCurves: ["extrudeCurves"],
  filletCurves: ["filletCurves"],
  createMirroredInstance: ["createMirroredInstance"],
  "createRib (recipe steps)": ["createPolyline", "extrudeRegions", "boolean"],
  "keepProfile:false delete (recipes)": ["remove"],
};
// Enum objects and the dialog the task names explicitly; kept even if the AST finds them elsewhere.
const EXPLICIT = ["ExtensionShape", "BodyExtensionType", "ExtensionLimit", "SweepGuideMethod", "ContinuityType", "DimensionDistanceSpaceDialog"];

function stringsOf(node: ts.Node, constants: Map<string, string[]>): string[] {
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap((element) => ts.isStringLiteralLike(element) ? [element.text] : []);
  if (ts.isIdentifier(node)) return constants.get(node.text) ?? [];
  return [];
}

function extract(): Record<string, string[]> {
  const source = ts.createSourceFile("operations.ts", readFileSync(resolve(root, "src/plasticity/operations.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const constants = new Map<string, string[]>();
  const methods = new Map<string, ts.MethodDeclaration>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const values = stringsOf(node.initializer, new Map());
      if (values.length) constants.set(node.name.text, values);
    }
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) methods.set(node.name.text, node);
    ts.forEachChild(node, visit);
  };
  visit(source);

  const result: Record<string, string[]> = {};
  for (const [tool, seeds] of Object.entries(TOOLS)) {
    const names = new Set<string>();
    const seen = new Set<string>();
    const walk = (methodName: string) => {
      if (seen.has(methodName)) return;
      seen.add(methodName);
      const method = methods.get(methodName);
      if (!method) { names.add(`!!missing-method:${methodName}`); return; }
      const inner = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const callee = node.expression.name.text;
          const receiver = node.expression.expression;
          if ((callee === "mutate" || callee === "readNative") && node.arguments[1]) {
            for (const name of stringsOf(node.arguments[1], constants)) names.add(name);
          }
          if (receiver.kind === ts.SyntaxKind.ThisKeyword && methods.has(callee)) walk(callee);
        }
        if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && (node.name.text === "command" || node.name.text === "dialog") && ts.isStringLiteralLike(node.initializer)) {
          names.add(node.initializer.text);
        }
        ts.forEachChild(node, inner);
      };
      inner(method);
    };
    for (const seed of seeds) walk(seed);
    result[tool] = [...names].sort();
  }
  return result;
}

async function collect(label: string, out: string) {
  const cdp = process.env.PLASTICITY_CDP_URL ?? "";
  const endpoint = (() => { try { return new URL(cdp); } catch { return undefined; } })();
  if (!endpoint || endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port) throw new Error(`Refusing: PLASTICITY_CDP_URL must be http://127.0.0.1:PORT (got "${cdp}")`);
  if (endpoint.port === "9223") throw new Error("Refusing: port 9223 is the owner's Plasticity");
  const { openSession } = await import("../mcp-client.ts");
  const session = await openSession({ env: { PLASTICITY_CDP_URL: cdp, PLASTICITY_AUTO_LAUNCH: "0", PLASTICITY_HUD: "0" } });
  try {
    const status = await session.raw("plasticity_status").catch((error: unknown) => ({ error: String(error) }));
    const available = new Set<string>();
    let offset = 0;
    let total = 0;
    for (;;) {
      const page = await session.op("plasticity_capabilities", { offset, limit: 250 }) as { totalBindings: number; bindings: string[]; nextOffset: number | null };
      total = page.totalBindings;
      for (const name of page.bindings) available.add(name);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    const perTool = extract();
    const needed = [...new Set([...Object.values(perTool).flat(), ...EXPLICIT])].filter((name) => !name.startsWith("!!")).sort();
    const bindings = Object.fromEntries(needed.map((name) => [name, available.has(name)]));
    writeFileSync(out, JSON.stringify({ label, totalBindingsOnBuild: total, status, tools: perTool, bindings }, null, 1));
    console.log(`wrote ${out}: ${needed.length} names, ${needed.filter((name) => !available.has(name)).length} unavailable on ${label} (build exposes ${total})`);
  } finally {
    await session.close();
  }
}

function merge(aPath: string, bPath: string, out: string) {
  const a = JSON.parse(readFileSync(aPath, "utf8")); const b = JSON.parse(readFileSync(bPath, "utf8"));
  const names = [...new Set([...Object.keys(a.bindings), ...Object.keys(b.bindings)])].sort();
  const table = names.map((binding) => ({
    binding,
    [a.label]: a.bindings[binding] ?? null,
    [b.label]: b.bindings[binding] ?? null,
    usedBy: Object.entries(a.tools as Record<string, string[]>).filter(([, list]) => list.includes(binding)).map(([tool]) => tool),
  }));
  const differs = table.filter((row) => row[a.label] !== row[b.label]);
  const perTool = Object.fromEntries(Object.entries(a.tools as Record<string, string[]>).map(([tool, list]) => [tool, {
    bindings: list,
    [`missing on ${a.label}`]: list.filter((name) => !a.bindings[name]),
    [`missing on ${b.label}`]: list.filter((name) => !b.bindings[name]),
  }]));
  writeFileSync(out, JSON.stringify({ versions: [a.label, b.label], totals: { [a.label]: a.totalBindingsOnBuild, [b.label]: b.totalBindingsOnBuild }, differing: differs, perTool, table }, null, 1));
  console.log(`wrote ${out}: ${table.length} bindings, ${differs.length} differ`);
}

// 26.2 renames these; native-discovery.ts SELECT_STORE_BINDINGS aliases legacy -> current when the legacy name is absent.
const ALIASES_262: Record<string, string> = { MultiCutFactory: "CutFactory", MultiMoveControlPointFactory: "MoveControlPointFactory" };

// Combine a live run (26.1.3) with static-binding-presence.ts output for a build that could not be driven live.
function table(livePath: string, staticPath: string, out: string) {
  const live = JSON.parse(readFileSync(livePath, "utf8"));
  const stat = JSON.parse(readFileSync(staticPath, "utf8")).result as Record<string, Record<string, boolean>>;
  const [other] = Object.keys(stat).filter((label) => label !== live.label);
  const otherPresence = stat[other!]!;
  const rows = Object.keys(live.bindings).sort().map((binding) => {
    const alias = ALIASES_262[binding];
    return {
      binding,
      [`live on ${live.label}`]: live.bindings[binding],
      [`name in ${other} bundle (static only)`]: otherPresence[binding] ?? null,
      ...(alias ? { [`${other} route`]: `absent by name; native-discovery.ts aliases ${binding} -> ${alias} (${alias} in bundle: ${stat[other!]![alias] ?? "not checked"})` } : {}),
      usedBy: Object.entries(live.tools as Record<string, string[]>).filter(([, list]) => list.includes(binding)).map(([tool]) => tool),
    };
  });
  writeFileSync(out, JSON.stringify({ note: `${other} could not be driven live; its column is string presence in the compiled renderer bundle, not proof that the binding resolves`, rows }, null, 1));
  console.log(`wrote ${out}: ${rows.length} rows`);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "collect" && rest.length === 2) await collect(rest[0]!, rest[1]!);
else if (mode === "merge" && rest.length === 3) merge(rest[0]!, rest[1]!, rest[2]!);
else if (mode === "table" && rest.length === 3) table(rest[0]!, rest[1]!, rest[2]!);
else { console.error("usage: table <live.json> <static.json> <out.json> | collect <label> <out.json> | merge <a.json> <b.json> <out.json>"); process.exit(2); }
