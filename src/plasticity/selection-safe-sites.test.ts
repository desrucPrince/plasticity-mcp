import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Every place the server runs a Plasticity command must go through PlasticityRuntime.mutate(): that is where the
 * selection guard lives (runtime.ts, SELECTION_GUARD_SOURCE). A native source that runs a command (exec(), enqueue(),
 * an Undo or Redo step) and is sent with read(), readNative() or cdp() would run without the guard and can hang on
 * the user's selection again. This test reads the sources and fails for such a site.
 */

// What "runs a command" looks like in a native source.
const COMMAND = /\b(?:this|editor|ed)\.exec\(|\.exec\(\s*command\b|\b(?:this|editor|ed)\.enqueue\(|\.enqueue\(\s*command\b|\bthis\[args\.direction\]\(\)|\b(?:this|editor|ed)\.(?:undo|redo)\(\)|\bhistory\.(?:undo|redo)\(\)|\benqueueDefaultCommand\(/;
const SENDERS = new Set(["mutate", "read", "readNative", "cdp", "call", "drawOverlay"]);

type Template = ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression;
const isTemplate = (node: ts.Node): node is Template => ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
const ownText = (node: Template) => ts.isNoSubstitutionTemplateLiteral(node) ? node.text : node.head.text + node.templateSpans.map((span) => span.literal.text).join("");
function identifiersIn(node: ts.Node): string[] {
  const names: string[] = [];
  const visit = (child: ts.Node): void => { if (ts.isIdentifier(child)) names.push(child.text); ts.forEachChild(child, visit); };
  visit(node);
  return names;
}
const interpolated = (node: Template) => ts.isNoSubstitutionTemplateLiteral(node) ? [] : node.templateSpans.flatMap((span) => identifiersIn(span.expression));

export interface CommandSite { line: number; sender: string; what: string }
export interface SiteReport {
  /** Sources that run a command and are sent with mutate(). */
  guarded: CommandSite[];
  /** Sources that run a command and are sent another way, or whose way to the runtime this test cannot follow. */
  unguarded: CommandSite[];
  /** Names (constants and functions) whose template runs a command, directly or through another such name. */
  snippets: string[];
  /** mutate() calls that opt out of the guard ({ selectionGuard: false }); one that runs a command is in unguarded too. */
  exempt: CommandSite[];
}

export function commandSites(sourceText: string, extraSnippets: ReadonlySet<string> = new Set()): SiteReport {
  const source = ts.createSourceFile("source.ts", sourceText, ts.ScriptTarget.Latest, true);
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const templates: Template[] = [];
  const collect = (node: ts.Node): void => { if (isTemplate(node)) templates.push(node); ts.forEachChild(node, collect); };
  collect(source);
  // The name a template is declared under: a variable, or the function (declaration or arrow) that returns it.
  const ownerName = (node: ts.Node): string | undefined => {
    for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
      if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) && SENDERS.has(current.expression.name.text)) return undefined;
      if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
      if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    }
    return undefined;
  };
  const snippets = new Set<string>(extraSnippets);
  const runsCommand = (node: Template) => COMMAND.test(ownText(node)) || interpolated(node).some((name) => snippets.has(name));
  for (let changed = true; changed;) {
    changed = false;
    for (const node of templates) {
      const name = ownerName(node);
      if (name !== undefined && !snippets.has(name) && runsCommand(node)) { snippets.add(name); changed = true; }
    }
  }
  const guarded: CommandSite[] = [];
  const unguarded: CommandSite[] = [];
  const exempt: CommandSite[] = [];
  const accounted = new Set<Template>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && SENDERS.has(node.expression.name.text) && node.arguments.length > 0) {
      const sender = node.expression.name.text;
      const first = node.arguments[0]!;
      const inside: Template[] = [];
      const gather = (child: ts.Node): void => { if (isTemplate(child)) inside.push(child); ts.forEachChild(child, gather); };
      gather(first);
      const viaTemplate = inside.some(runsCommand);
      const viaName = identifiersIn(first).some((name) => snippets.has(name));
      // mutate(..., { selectionGuard: false }) runs the source outside the guard.
      const optsOut = sender === "mutate" && node.arguments.slice(1).some((argument) => /\bselectionGuard\s*:\s*false\b/.test(argument.getText(source)));
      if (optsOut) exempt.push({ line: lineOf(node), sender, what: "a source outside the guard" });
      if (viaTemplate || viaName) {
        for (const template of inside) accounted.add(template);
        const what = viaTemplate ? "a source that runs a command" : `the command source ${identifiersIn(first).find((name) => snippets.has(name))}`;
        (sender === "mutate" && !optsOut ? guarded : unguarded).push({ line: lineOf(node), sender: optsOut ? "mutate with selectionGuard: false" : sender, what });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  // A command source that is neither a named snippet nor an argument of a sender: its way to the runtime is unknown.
  for (const node of templates) {
    if (!runsCommand(node) || accounted.has(node) || ownerName(node) !== undefined) continue;
    let nested = false;
    for (let current: ts.Node | undefined = node.parent; current; current = current.parent) if (isTemplate(current)) { nested = true; break; }
    if (!nested) unguarded.push({ line: lineOf(node), sender: "unknown", what: "a source that runs a command and is not passed to mutate()" });
  }
  return { guarded, unguarded, snippets: [...snippets].sort(), exempt };
}

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
  assert.deepEqual(commandSites("x.runtime.read(`function (id) { return (/^[0-9]+/.exec(id) ?? [])[0]; }`);"), { guarded: [], unguarded: [], snippets: [], exempt: [] });
  // Opting out of the guard is allowed for a source that runs no command, and flagged for one that does.
  const quiet = commandSites("x.runtime.mutate(`function () { this.labels.clear(); }`, [], [], undefined, { selectionGuard: false });");
  assert.deepEqual([quiet.exempt.length, quiet.unguarded.length, quiet.guarded.length], [1, 0, 0]);
  const loud = commandSites("x.runtime.mutate(`async function () { await this.exec(command); }`, [], [], undefined, { selectionGuard: false });");
  assert.deepEqual([loud.exempt.length, loud.guarded.length], [1, 0]);
  assert.deepEqual(loud.unguarded.map((site) => site.sender), ["mutate with selectionGuard: false"]);
});

test("every native source that runs a Plasticity command is sent through runtime.mutate(), where the selection guard is", () => {
  const files = sourceFiles(root);
  assert.ok(files.length > 50, "the source tree was found");
  // Command snippets are shared across files only by import; none is today, so each file is read on its own.
  const guarded: string[] = [];
  const unguarded: string[] = [];
  const exempt: string[] = [];
  for (const file of files) {
    const report = commandSites(readFileSync(file, "utf8"));
    const name = relative(root, file);
    guarded.push(...report.guarded.map((site) => `${name}:${site.line}`));
    unguarded.push(...report.unguarded.map((site) => `${name}:${site.line} sends ${site.what} with ${site.sender}()`));
    exempt.push(...report.exempt.map(() => name));
  }
  assert.deepEqual(unguarded, [], "a command must run inside the selection guard: send its source with runtime.mutate()");
  // The census of today (169 in operations.ts, 2 in construction.ts): it only ever grows through mutate().
  assert.ok(guarded.length >= 171, `expected the known command sites, found ${guarded.length}`);
  assert.ok(guarded.some((site) => site.startsWith("plasticity/construction.ts:")));
  // One source runs outside the guard: the measurement overlay refresh of a state read, which runs no command.
  assert.deepEqual(exempt, ["plasticity/operations.ts"]);
});

test("mutate() wraps every source in the guard, and read() and readNative() do not", async () => {
  const { PlasticityRuntime, SELECTION_GUARD_KEY, selectionSafeSource } = await import("./runtime.ts");
  const sent: string[] = [];
  const client = { async send(_method: string, params: Record<string, unknown>) { sent.push(String(params.functionDeclaration)); return { result: { value: { [SELECTION_GUARD_KEY]: { mode: "guarded", problems: [] }, value: 5 } } }; }, close() {} };
  type Runtime = { mutate(source: string, bindings: string[], values: unknown[]): Promise<unknown>; read(source: string): Promise<unknown>; readNative(source: string, bindings: string[]): Promise<unknown> };
  const Runtime = PlasticityRuntime as unknown as new (client: unknown, target: unknown, editorId: string) => Runtime;
  const runtime = new Runtime(client, { id: "w", title: "t", webSocketDebuggerUrl: "ws://127.0.0.1/x" }, "editor");
  const source = "async function () { return 5; }";
  assert.equal(await runtime.mutate(source, [], []), 5, "the envelope is opened");
  assert.equal(sent[0], selectionSafeSource(source));
  assert.ok(sent[0]!.includes("cancelIdleDefaults") && sent[0]!.includes(source));
  await runtime.read(source);
  await runtime.readNative(source, []);
  assert.deepEqual(sent.slice(1), [source, source]);
  // The opt-out sends the source as it is.
  await (runtime as unknown as { mutate(source: string, bindings: string[], values: unknown[], timeoutMs: number | undefined, options: { selectionGuard: boolean }): Promise<unknown> }).mutate(source, [], [], undefined, { selectionGuard: false });
  assert.equal(sent[3], source);
});
