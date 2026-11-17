import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { sourceRunsCommand } from "./runtime.ts";

/**
 * Every place the server runs a Plasticity command must go through PlasticityRuntime.mutate(): that is where the
 * selection guard lives (runtime.ts, SELECTION_GUARD_SOURCE). A native source that runs a command and is sent with
 * read(), readNative() or cdp(), or that opts out of the guard, would run without it and can hang on the user's
 * selection again. This test reads every non-test source under src/ and fails for such a site.
 *
 * What it reads: every string and template literal (also one piece of a concatenation) whose text contains a command
 * pattern (`.exec(`, `['exec']`, `.enqueue(`, `.undo()`, `.redo()`, `[args.direction]()`, `.execute(`,
 * `cancelActiveCommand(`, `enqueueDefaultCommand(`; whatever the receiver is called, so an aliased editor counts; a
 * regular expression literal's own `.exec(` does not). Such a literal must be the source of a mutate() call, or sit
 * in a named constant or function (a "command source") whose every use is the source of a mutate() call or another
 * command source; names are followed through named imports between files. The opt-out ({ selectionGuard: false })
 * must be written as an object literal in the mutate() call itself, on a source that runs no command, at the one
 * site listed below.
 *
 * What it cannot catch:
 *  - a source put together at run time from pieces that each lack a pattern ('ex' + 'ec('), or read from a file;
 *  - a method name computed in the renderer (this[name]()), or a renderer-side helper that runs the command for the
 *    source (a function kept on globalThis, a Plasticity method that starts a command under another name);
 *  - a command source that leaves through a class method, a property or a default import instead of a named
 *    constant or function (it is reported as a source with no known way to mutate(), which fails the test, but a
 *    method that only RETURNS such a source built from a parameter is not followed);
 *  - code outside src/ (the live scripts run sources of their own on purpose).
 *
 * PlasticityRuntime.mutate() wraps a source in the guard when sourceRunsCommand() finds a pattern in it, and this
 * test asks that same function about every literal: there is one list of patterns, in runtime.ts. A mutate() source
 * in which it finds none is sent WITHOUT the guard. So the test also pins those sites by name (PLAIN_SITES): a new
 * one fails the test until somebody has looked at what it does. The question to ask of such a source: does it end or
 * drive a command that another call started, or call a helper kept in the page that runs one? Then it needs the
 * guard ({ selectionGuard: true }, pinned in FORCED_SITES) although no pattern is in its text.
 */

// A command in a native source: the runtime's own predicate. A regular expression literal's exec() (/x/.exec(id)) is
// not one for this test (at run time it only makes mutate() guard a source that would not need it).
const runsCommand = (text: string) => sourceRunsCommand(text.replace(/(\/[dgimsuy]{0,6})\.exec\(/g, "$1.regexExec("));
const COMMAND = { test: runsCommand };
const SENDERS = new Set(["mutate", "read", "readNative", "cdp", "call", "drawOverlay"]);

type Literal = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression;
const isLiteral = (node: ts.Node): node is Literal => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
const ownText = (node: Literal) => ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map((span) => span.literal.text).join("") : node.text;

export interface CommandSite { line: number; sender: string; what: string }
export interface SiteReport {
  /** mutate() calls whose source runs a command (inside the guard). */
  guarded: CommandSite[];
  /** Command sources that reach the renderer another way, that opt out of the guard, or whose way cannot be followed. */
  unguarded: CommandSite[];
  /** Named constants and functions that hold or build a command source. */
  snippets: string[];
  /** Those of them that the file exports. */
  exported: string[];
  /** mutate() calls that opt out of the guard with a literal { selectionGuard: false }. */
  exempt: CommandSite[];
  /** mutate() calls whose source shows no command and that say nothing: sent without the guard. By enclosing function. */
  plain: string[];
  /** mutate() calls that ask for the guard with a literal { selectionGuard: true }. By enclosing function. */
  forced: string[];
}

export function commandSites(sourceText: string, imported: ReadonlySet<string> = new Set(), options: { ownsOptOut?: boolean } = {}): SiteReport {
  const source = ts.createSourceFile("source.ts", sourceText, ts.ScriptTarget.Latest, true);
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const senderOf = (node: ts.Node): string | undefined => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && SENDERS.has(node.expression.name.text) ? node.expression.name.text : undefined;
  /** Where a node goes: the sender call whose source (first argument) holds it, else the named declaration around it. */
  const routeOf = (node: ts.Node): { sender: string; call: ts.CallExpression } | { name: string } | undefined => {
    for (let child: ts.Node = node, current: ts.Node | undefined = node.parent; current; child = current, current = current.parent) {
      const sender = senderOf(current);
      if (sender && (current as ts.CallExpression).arguments[0] === child) return { sender, call: current as ts.CallExpression };
      if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer === child) return { name: current.name.text };
      if (ts.isFunctionDeclaration(current) && current.name) return { name: current.name.text };
    }
    return undefined;
  };
  const literals: Literal[] = [];
  const identifiers: ts.Identifier[] = [];
  const mutates: ts.CallExpression[] = [];
  const collect = (node: ts.Node): void => {
    if (isLiteral(node) && COMMAND.test(ownText(node))) literals.push(node);
    if (ts.isIdentifier(node)) identifiers.push(node);
    if (senderOf(node) === "mutate") mutates.push(node as ts.CallExpression);
    ts.forEachChild(node, collect);
  };
  collect(source);
  // A use of a name: not its own declaration, not a property name, not an import or export binding.
  const isUse = (id: ts.Identifier) => {
    const parent = id.parent;
    if ((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isParameter(parent)) && parent.name === id) return false;
    if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
    if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
    if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent)) return false;
    return true;
  };
  const snippets = new Set<string>(imported);
  const guardedCalls = new Set<ts.CallExpression>();
  const unguarded: CommandSite[] = [];
  const flag = (node: ts.Node, sender: string, what: string) => { if (!unguarded.some((site) => site.line === lineOf(node) && site.sender === sender)) unguarded.push({ line: lineOf(node), sender, what }); };
  const follow = (node: ts.Node, what: string): boolean => {
    const route = routeOf(node);
    if (!route) { flag(node, "unknown", `${what} with no known way to mutate()`); return false; }
    if ("name" in route) { if (snippets.has(route.name)) return false; snippets.add(route.name); return true; }
    if (route.sender === "mutate") guardedCalls.add(route.call);
    else flag(route.call, route.sender, what);
    return false;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const literal of literals) if (follow(literal, "a source that runs a command")) changed = true;
    for (const id of identifiers) if (snippets.has(id.text) && isUse(id) && follow(id, `the command source ${id.text}`)) changed = true;
  }
  // The opt-out: a literal in the mutate() call, on a source that runs no command.
  const exempt: CommandSite[] = [];
  const settled = new Set<ts.CallExpression>(); // calls that are exempt, forced or flagged
  const forced: string[] = [];
  const inside = (node: ts.Node) => { for (let current = node.parent; current; current = current.parent) if ((ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) && current.name) return current.name.getText(source); return "(top level)"; };
  for (const call of mutates) {
    const optionsArgument = call.arguments[4];
    if (!optionsArgument) continue;
    settled.add(call);
    if (!ts.isObjectLiteralExpression(optionsArgument)) { guardedCalls.delete(call); flag(call, "mutate with options that are not a literal", "a source whose guard option cannot be read here"); continue; }
    if (optionsArgument.properties.length === 1 && optionsArgument.properties.every((property) => ts.isPropertyAssignment(property) && property.name.getText(source) === "selectionGuard" && property.initializer.kind === ts.SyntaxKind.TrueKeyword)) { if (!guardedCalls.has(call)) forced.push(inside(call)); continue; }
    const optsOut = optionsArgument.properties.some((property) => ts.isPropertyAssignment(property) && property.name.getText(source) === "selectionGuard" && property.initializer.kind !== ts.SyntaxKind.TrueKeyword);
    if (!optsOut) { settled.delete(call); continue; }
    if (optionsArgument.properties.some((property) => ts.isPropertyAssignment(property) && property.name.getText(source) === "selectionGuard" && property.initializer.kind !== ts.SyntaxKind.FalseKeyword)) { guardedCalls.delete(call); flag(call, "mutate with a computed selectionGuard", "a source whose guard option cannot be read here"); continue; }
    exempt.push({ line: lineOf(call), sender: "mutate", what: "a source outside the guard" });
    if (guardedCalls.has(call)) { guardedCalls.delete(call); flag(call, "mutate with selectionGuard: false", "a source that runs a command"); }
  }
  // selectionGuard anywhere else (an options object built in a variable, a spread) hides an opt-out from this test.
  if (!options.ownsOptOut) {
    for (const id of identifiers) {
      if (id.text !== "selectionGuard") continue;
      const literal = id.parent.parent;
      const inCall = ts.isPropertyAssignment(id.parent) && ts.isObjectLiteralExpression(literal) && ts.isCallExpression(literal.parent) && senderOf(literal.parent) === "mutate" && literal.parent.arguments[4] === literal;
      if (!inCall) flag(id, "selectionGuard outside a mutate() call", "an opt-out that is not written in the mutate() call");
    }
  }
  const exported = [...snippets].filter((name) => new RegExp(`export\\s+(?:const|function|async function)\\s+${name}\\b`).test(sourceText)).sort();
  const guarded = [...guardedCalls].map((call) => ({ line: lineOf(call), sender: "mutate", what: "a source that runs a command" })).sort((a, b) => a.line - b.line);
  const plain = mutates.filter((call) => !guardedCalls.has(call) && !settled.has(call)).map(inside).sort();
  return { guarded, unguarded: unguarded.sort((a, b) => a.line - b.line), snippets: [...snippets].sort(), exported, exempt, plain, forced: forced.sort() };
}

/** Named imports of a file: local name -> [module path as written, imported name]. */
export function namedImports(sourceText: string): Array<{ local: string; name: string; module: string }> {
  const source = ts.createSourceFile("source.ts", sourceText, ts.ScriptTarget.Latest, true);
  const found: Array<{ local: string; name: string; module: string }> = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) found.push({ local: element.name.text, name: (element.propertyName ?? element.name).text, module: statement.moduleSpecifier.text });
  }
  return found;
}

// What the scan finds in runtime.ts itself: the guard (wrapped around the caller's source and sent by mutate()'s own
// call()) and the recovery step of reconcile(), which cancel an idle default command.
const GUARD_OWN_SOURCES = ["sends the command source guarded with call()", "sends the command source DEFAULT_COMMAND_RECOVERY_SOURCE with read()"];
// Every mutate() site whose source shows no command: it is sent without the guard. Each was read: it sets viewport or
// shading state, or writes a file, and neither starts nor ends a command.
const PLAIN_SITES = [
  "plasticity/construction.ts setWorkplane",
  "plasticity/operations.ts createSectionAnalysis", "plasticity/operations.ts deleteAllSectionAnalyses", "plasticity/operations.ts deleteSectionAnalysis",
  "plasticity/operations.ts export3mf", "plasticity/operations.ts exportIges", "plasticity/operations.ts exportObj", "plasticity/operations.ts exportParasolid",
  "plasticity/operations.ts exportSat", "plasticity/operations.ts exportStep", "plasticity/operations.ts exportStl",
  "plasticity/operations.ts saveCopy",
];
// The source that shows no command and keeps the guard: opening a document replaces what the selection points at.
const FORCED_SITES = ["plasticity/operations.ts openDocument"];

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

test("the checker finds a command source sent without the guard, and follows constants and helper functions", () => {
  const sample = (sender: string) => `
    const commandEnd = \`await this.exec(command);\`;
    const SOURCE = nativeFunction\`async function () { \${commandEnd} }\`;
    function pickSource(drive: string) { return nativeFunction\`async function () { editor.exec(command).then(() => {}); \${drive} }\`; }
    class Operations {
      async a() { await this.runtime.${sender}(\`async function () { await this.exec(command); }\`, [], []); }
      async b() { await this.runtime.${sender}(nativeFunction\`async function () { \${commandEnd} }\`, [], []); }
      async c() { await this.runtime.${sender}(SOURCE, [], []); }
      async d() { await this.runtime.${sender}(pickSource("x"), [], []); }
      async e() { await this.runtime.${sender}(\`async function (args) { this[args.direction]().then(() => {}); }\`, [], []); }
      async f() { await this.runtime.read(\`function () { return this.selection.selected.size; }\`); }
    }`;
  const good = commandSites(sample("mutate"));
  assert.deepEqual(good.unguarded, []);
  assert.equal(good.guarded.length, 5);
  assert.deepEqual(good.snippets, ["SOURCE", "commandEnd", "pickSource"]);
  for (const sender of ["read", "readNative", "cdp"]) {
    const bad = commandSites(sample(sender));
    assert.equal(bad.unguarded.length, 5, sender);
    assert.ok(bad.unguarded.every((site) => site.sender === sender));
    assert.equal(bad.guarded.length, 0);
  }
  // A command source handed to something that is not a runtime sender is flagged too.
  assert.deepEqual(commandSites("evaluate(`async function () { await editor.exec(command); }`);").unguarded.map((site) => site.sender), ["unknown"]);
  // A regular expression's exec() in a source is not a command.
  assert.deepEqual(commandSites("x.runtime.read(`function (id) { return (/^[0-9]+/.exec(id) ?? [])[0]; }`);"), { guarded: [], unguarded: [], snippets: [], exported: [], exempt: [], plain: [], forced: [] });
  // A mutate() source that shows no command is reported by the function around it; so is one that asks for the guard.
  const silent = commandSites("class O { async saveCopy() { await this.runtime.mutate(`async function (path) { await this.saver.save(path); }`, [], []); } async openDocument() { await this.runtime.mutate(`async function () { await this.open(); }`, [], [], 5, { selectionGuard: true }); } async move() { await this.runtime.mutate(`async function () { await this.exec(c); }`, [], []); } }");
  assert.deepEqual([silent.plain, silent.forced, silent.guarded.length, silent.unguarded.length], [["saveCopy"], ["openDocument"], 1, 0]);
  // Opting out of the guard is allowed for a source that runs no command, and flagged for one that does.
  const quiet = commandSites("x.runtime.mutate(`function () { this.labels.clear(); }`, [], [], undefined, { selectionGuard: false });");
  assert.deepEqual([quiet.exempt.length, quiet.unguarded.length, quiet.guarded.length], [1, 0, 0]);
  const loud = commandSites("x.runtime.mutate(`async function () { await this.exec(command); }`, [], [], undefined, { selectionGuard: false });");
  assert.deepEqual([loud.exempt.length, loud.guarded.length], [1, 0]);
  assert.deepEqual(loud.unguarded.map((site) => site.sender), ["mutate with selectionGuard: false"]);
});

test("the checker rejects each way a new unguarded command site could be written", () => {
  const rejected = (label: string, text: string, sender: string | RegExp, imported: string[] = []) => {
    const report = commandSites(text, new Set(imported));
    assert.ok(report.unguarded.some((site) => (typeof sender === "string" ? site.sender === sender : sender.test(site.sender))), `${label}: ${JSON.stringify(report.unguarded)}`);
    assert.equal(report.guarded.length, 0, label);
  };
  // A plain string, and a string put together from pieces.
  rejected("plain string source", `x.runtime.read("async function () { await this.exec(command); }");`, "read");
  rejected("concatenated string source", `x.runtime.readNative("async function () { " + "await this.exec(command);" + " }", []);`, "readNative");
  rejected("concatenated in a constant", `const S = "async function () {" + " await editor.exec(c); }"; x.runtime.read(S);`, "read");
  // An aliased editor.
  rejected("aliased editor", "x.runtime.read(`async function () { const e = this; await e.exec(c); }`);", "read");
  // The executor's own queue, a bracket call, a history step through an alias, a command run directly, a cancel.
  rejected("executor.enqueue", "x.runtime.read(`async function () { await this.executor.enqueue(c); }`);", "read");
  rejected("bracket exec", "x.runtime.read(`async function () { await this['exec'](c); }`);", "read");
  rejected("bracket exec, double quotes", "x.runtime.read(`async function () { await this[\"exec\"](c); }`);", "read");
  rejected("undo through an alias", "x.runtime.read(`async function () { const h = this; await h.undo(); }`);", "read");
  rejected("redo through an alias", "x.runtime.readNative(`async function () { const h = this; await h.redo(); }`, []);", "readNative");
  rejected("history step by name", "x.runtime.read(`async function (args) { await this[args.direction](); }`);", "read");
  rejected("direct command.execute()", "x.runtime.read(`async function () { const c = new this.commands.DeleteCommand(this); await c.execute(); }`);", "read");
  rejected("execute through call", "x.runtime.read(`async function () { await this.commands.DeleteCommand.prototype.execute.call(c); }`);", "read");
  rejected("cancelActiveCommand", "x.runtime.read(`function () { this.executor.cancelActiveCommand(); }`);", "read");
  rejected("enqueueDefaultCommand", "x.runtime.cdp(`function () { this.executor.enqueueDefaultCommand(); }`);", "cdp");
  // A constant imported from another file (the caller says which imported names are command sources).
  rejected("imported constant", `import { MOVE_SOURCE } from "./sources.ts"; x.runtime.read(MOVE_SOURCE);`, "read", ["MOVE_SOURCE"]);
  assert.equal(commandSites(`import { MOVE_SOURCE } from "./sources.ts"; x.runtime.mutate(MOVE_SOURCE, [], []);`, new Set(["MOVE_SOURCE"])).guarded.length, 1);
  assert.deepEqual(commandSites("export const MOVE_SOURCE = `async function () { await this.exec(c); }`;").exported, ["MOVE_SOURCE"]);
  assert.deepEqual(namedImports(`import { MOVE_SOURCE as S, other } from "./sources.ts";`), [{ local: "S", name: "MOVE_SOURCE", module: "./sources.ts" }, { local: "other", name: "other", module: "./sources.ts" }]);
  // A command source that goes nowhere this test can follow.
  rejected("stored on a property", "this.sources.move = `async function () { await this.exec(c); }`;", "unknown");
  rejected("passed to a helper", "const S = `async function () { await this.exec(c); }`; send(S);", "unknown");
  // The opt-out through a variable, a spread or a computed value.
  rejected("opt-out in a variable", "const quiet = { selectionGuard: false }; x.runtime.mutate(`async function () { await this.exec(c); }`, [], [], undefined, quiet);", /not a literal|outside a mutate/);
  rejected("opt-out through a spread", "const quiet = { selectionGuard: false }; x.runtime.mutate(`function () { return 1; }`, [], [], undefined, { ...quiet });", "selectionGuard outside a mutate() call");
  rejected("computed opt-out", "x.runtime.mutate(`async function () { await this.exec(c); }`, [], [], undefined, { selectionGuard: flag });", "mutate with a computed selectionGuard");
});

test("every native source that runs a Plasticity command is sent through runtime.mutate(), where the selection guard is", () => {
  const files = sourceFiles(root);
  assert.ok(files.length > 50, "the source tree was found");
  const texts = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));
  // Command sources are followed through named imports: repeat until no file learns a new imported name.
  const exportedBy = new Map<string, Set<string>>();
  const importedBy = new Map<string, Set<string>>(files.map((file) => [file, new Set<string>()]));
  let reports = new Map<string, SiteReport>();
  for (let round = 0, changed = true; changed && round < 8; round += 1) {
    changed = false;
    reports = new Map(files.map((file) => [file, commandSites(texts.get(file)!, importedBy.get(file)!, { ownsOptOut: relative(root, file) === "plasticity/runtime.ts" })]));
    for (const [file, report] of reports) exportedBy.set(file, new Set(report.exported));
    for (const file of files) {
      for (const binding of namedImports(texts.get(file)!)) {
        if (!binding.module.startsWith(".")) continue;
        const from = resolve(dirname(file), binding.module);
        if (exportedBy.get(from)?.has(binding.name) && !importedBy.get(file)!.has(binding.local)) { importedBy.get(file)!.add(binding.local); changed = true; }
      }
    }
  }
  const guarded: string[] = [];
  const unguarded: string[] = [];
  const exempt: string[] = [];
  const plain: string[] = [];
  const forced: string[] = [];
  for (const [file, report] of reports) {
    const name = relative(root, file);
    guarded.push(...report.guarded.map((site) => `${name}:${site.line}`));
    unguarded.push(...report.unguarded.map((site) => `${name}:${site.line} sends ${site.what} with ${site.sender}()`));
    exempt.push(...report.exempt.map(() => name));
    plain.push(...report.plain.map((site) => `${name} ${site}`));
    forced.push(...report.forced.map((site) => `${name} ${site}`));
  }
  // The guard's own renderer sources cancel an idle default command and name the patterns; they are not sent sources.
  const own = unguarded.filter((line) => /^plasticity\/runtime\.ts:/.test(line));
  assert.deepEqual(unguarded.filter((line) => !own.includes(line)), [], "a command must run inside the selection guard: send its source with runtime.mutate()");
  assert.deepEqual(own.map((line) => line.replace(/^plasticity\/runtime\.ts:\d+ /, "")).sort(), GUARD_OWN_SOURCES.slice().sort(), "only the guard's own helpers may name a command outside a mutate() source");
  // The census of today (169 in operations.ts, 2 in construction.ts): it only ever grows through mutate().
  assert.ok(guarded.length >= 171, `expected the known command sites, found ${guarded.length}`);
  assert.ok(guarded.some((site) => site.startsWith("plasticity/construction.ts:")));
  // One source runs outside the guard by its own word: the measurement overlay refresh of a state read.
  assert.deepEqual(exempt, ["plasticity/operations.ts"]);
  // Every other mutate() source in which sourceRunsCommand() finds nothing goes without the guard: the known ones.
  assert.deepEqual(plain.sort(), PLAIN_SITES.slice().sort(), "a mutate() source that shows no command is sent without the selection guard: read what it does (does it end or drive a command of an earlier call, or call a helper kept in the page?), then list it here or give it { selectionGuard: true }");
  assert.deepEqual(forced.sort(), FORCED_SITES.slice().sort(), "the sources that keep the guard although they show no command");
});

test("mutate() wraps a source that runs a command in the guard; a source without one, read() and readNative() go as they are", async () => {
  const { PlasticityRuntime, SELECTION_GUARD_KEY, selectionSafeSource } = await import("./runtime.ts");
  const sent: string[] = [];
  const client = { async send(_method: string, params: Record<string, unknown>) { sent.push(String(params.functionDeclaration)); return { result: { value: sent.at(-1)!.includes("cancelIdleDefaults") ? { [SELECTION_GUARD_KEY]: { mode: "guarded", problems: [] }, value: 5 } : 5 } }; }, close() {} };
  type Runtime = { mutate(source: string, bindings: string[], values: unknown[], timeoutMs?: number, options?: { selectionGuard: boolean }): Promise<unknown>; read(source: string): Promise<unknown>; readNative(source: string, bindings: string[]): Promise<unknown> };
  const Runtime = PlasticityRuntime as unknown as new (client: unknown, target: unknown, editorId: string) => Runtime;
  const runtime = new Runtime(client, { id: "w", title: "t", webSocketDebuggerUrl: "ws://127.0.0.1/x" }, "editor");
  const edit = "async function () { await this.exec(command); return 5; }";
  assert.equal(await runtime.mutate(edit, [], []), 5, "the envelope is opened");
  assert.ok(sent[0]!.includes("cancelIdleDefaults") && sent[0]!.includes(edit));
  // The guard's budget is the call's timeout (10 s without one).
  const owner = /"owner":"([^"]+)"/.exec(sent[0]!)![1]!;
  assert.equal(sent[0], selectionSafeSource(edit, { budgetMs: 10_000, owner }));
  await runtime.mutate(edit, [], [], 700);
  assert.equal(sent[1], selectionSafeSource(edit, { budgetMs: 700, owner }));
  // No command in the source: nothing reaches the executor, so nothing needs the guard.
  const quiet = "async function () { return 5; }";
  assert.equal(await runtime.mutate(quiet, [], []), 5);
  await runtime.read(edit);
  await runtime.readNative(edit, []);
  // The explicit opt-out sends even a command source as it is (the site test below forbids that in the sources).
  await runtime.mutate(edit, [], [], undefined, { selectionGuard: false });
  assert.deepEqual(sent.slice(2), [quiet, edit, edit, edit]);
  // The guard can be asked for, for a source that shows no command (opening a document).
  await runtime.mutate(quiet, [], [], 900, { selectionGuard: true });
  assert.equal(sent.at(-1), selectionSafeSource(quiet, { budgetMs: 900, owner }));
  // What counts as "runs a command": deliberately broad.
  for (const source of ["this.exec(command)", "editor.exec(c)", "e.exec(c)", "this['exec'](c)", 'this["exec"](c)', "this.executor.enqueue(c)", "this.enqueue(c)", "h.undo()", "this.redo()", "this[args.direction]()", "command.execute()", "this.commands.DeleteCommand.prototype.execute.call(this)", "executor.cancelActiveCommand()", "executor.enqueueDefaultCommand()", "(/^[0-9]+/.exec(id) ?? [])[0]"]) {
    assert.equal(sourceRunsCommand(`async function () { ${source}; }`), true, source);
  }
  for (const source of ["await factory.commit()", "command.execute = async function () {}", "this.selection.selected.removeAll()", "nativeLabels.labels.length = 0", "exports.undoStack.length"]) {
    assert.equal(sourceRunsCommand(`async function () { ${source}; }`), false, source);
  }
});
