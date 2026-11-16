import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

/**
 * Native sources that use `nativeApi` only work when wrapped by `nativeFunction`, which
 * defines it. A source that starts with `function (` / `async function (`, is not tagged,
 * and mentions `nativeApi` (directly or through an interpolated snippet constant) would
 * throw a ReferenceError inside the renderer.
 */

function templateText(node: ts.TemplateLiteral): string {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return node.head.text + node.templateSpans.map((span) => `\${${span.expression.getText()}}` + span.literal.text).join("");
}

function interpolatedNames(node: ts.TemplateLiteral): string[] {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return [];
  return node.templateSpans.flatMap((span) => {
    const names: string[] = [];
    const visit = (child: ts.Node): void => {
      if (ts.isIdentifier(child)) names.push(child.text);
      ts.forEachChild(child, visit);
    };
    visit(span.expression);
    return names;
  });
}

/** Names of declarations whose template text (transitively) contains `nativeApi`. */
export function nativeApiSnippetNames(sourceText: string): Set<string> {
  const source = ts.createSourceFile("source.ts", sourceText, ts.ScriptTarget.Latest, true);
  const declared = new Map<string, ts.TemplateLiteral>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isNoSubstitutionTemplateLiteral(node.initializer) || ts.isTemplateExpression(node.initializer))) {
      declared.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const names = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, literal] of declared) {
      if (names.has(name)) continue;
      if (templateText(literal).includes("nativeApi") || interpolatedNames(literal).some((used) => names.has(used))) {
        names.add(name);
        changed = true;
      }
    }
  }
  return names;
}

export interface UntaggedSite { line: number; reason: string }

export function untaggedNativeApiSites(sourceText: string, extraSnippetNames: ReadonlySet<string> = new Set()): UntaggedSite[] {
  const source = ts.createSourceFile("source.ts", sourceText, ts.ScriptTarget.Latest, true);
  const snippets = new Set([...nativeApiSnippetNames(sourceText), ...extraSnippetNames]);
  const sites: UntaggedSite[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))
      && !(ts.isTaggedTemplateExpression(node.parent) && node.parent.template === node)) {
      const text = templateText(node).trimStart();
      if (/^(async\s+)?function\s*\(/.test(text)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (text.includes("nativeApi")) sites.push({ line, reason: "contains nativeApi" });
        for (const name of interpolatedNames(node)) {
          if (snippets.has(name)) sites.push({ line, reason: `interpolates ${name}, which needs nativeApi` });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

const files = ["operations.ts", "recipes.ts"];

for (const file of files) {
  const sourceText = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");

  test(`${file}: untagged native function sources never need nativeApi`, () => {
    assert.deepEqual(untaggedNativeApiSites(sourceText), []);
  });
}

test("the rule derives its snippet list from the source", () => {
  const names = nativeApiSnippetNames(readFileSync(new URL("./operations.ts", import.meta.url), "utf8"));
  for (const expected of ["findView", "findFaceViews", "findEdgeViews", "findCurveControlPoints", "findWritableInstanceEmpty"]) {
    assert.ok(names.has(expected), `${expected} should be recognised as needing nativeApi`);
  }
});

test("the rule fails when a tagged site is left untagged", () => {
  const sourceText = readFileSync(new URL("./operations.ts", import.meta.url), "utf8");
  const taggedUsingSnippet = /nativeFunction`((?:async )?function \([^`]*?\$\{(?:findView|findFaceViews|findEdgeViews|findCurveControlPoints|findWritableInstanceEmpty)\})/;
  assert.match(sourceText, taggedUsingSnippet);
  const mutated = sourceText.replace(taggedUsingSnippet, "`$1");
  assert.notEqual(mutated, sourceText);
  assert.ok(untaggedNativeApiSites(mutated).length > 0);
  const direct = untaggedNativeApiSites("const f = `function (args) { return nativeApi.db; }`;");
  assert.deepEqual(direct, [{ line: 1, reason: "contains nativeApi" }]);
  const tagged = untaggedNativeApiSites("const f = nativeFunction`function (args) { return nativeApi.db; }`;");
  assert.deepEqual(tagged, []);
});
