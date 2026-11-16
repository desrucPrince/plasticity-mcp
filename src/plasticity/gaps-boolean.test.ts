import assert from "node:assert/strict";
import { test } from "node:test";

import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

// G1: the kernel's BooleanFactory intersects the target with the UNION of its tools. plasticity_boolean must give
// target AND tool 1 AND tool 2 ... in one call. The native source runs here against a fake editor whose factory
// reproduces the kernel behaviour seen live (intersection with several tools = target AND (tool 1 OR tool 2)).

const cell = (x: number, y: number) => `${x},${y}`;
const grid = (width: number, height: number, keep: (x: number, y: number) => boolean) => {
  const out = new Set<string>();
  for (let x = 0; x < width; x += 1) for (let y = 0; y < height; y += 1) if (keep(x, y)) out.add(cell(x, y));
  return out;
};

function booleanFixture(options: { failOnTool?: number } = {}) {
  // Stable ID -> the cells of that body. 8 x 8 target; tool 2 is x < 3; tool 3 is y < 3.
  const bodies = new Map<number, Set<string>>([
    [1, grid(8, 8, () => true)],
    [2, grid(8, 8, (x) => x < 3)],
    [3, grid(8, 8, (_x, y) => y < 3)],
  ]);
  const versionOf = new Map<number, number>([[1, 11], [2, 12], [3, 13]]);
  const history = { executions: 0, factories: 0, commands: 0 };
  const stableOf = (versionId: number) => [...versionOf.entries()].find(([, version]) => version === versionId)?.[0];
  class Factory {
    targets: Array<{ id: number }> = [];
    tools: Array<{ id: number }> = [];
    operationType = 0;
    keepTools = false;
    constructor(_editor: unknown) { history.factories += 1; }
    resource(_command: unknown) { return this; }
    async commit() {
      if (options.failOnTool !== undefined && this.tools.some((tool) => tool.id === options.failOnTool)) throw new Error("Operation has no effect");
      const toolCells = (bodiesOf: Array<{ id: number }>) => bodiesOf.map((body) => bodies.get(body.id)!);
      for (const target of this.targets) {
        const own = bodies.get(target.id)!;
        const tools = toolCells(this.tools);
        const union = new Set(tools.flatMap((set) => [...set]));
        if (this.operationType === 15901) bodies.set(target.id, new Set([...own].filter((key) => union.has(key))));
        else if (this.operationType === 15902) bodies.set(target.id, new Set([...own].filter((key) => !union.has(key))));
        else bodies.set(target.id, new Set([...own, ...union]));
      }
      if (!this.keepTools) for (const tool of this.tools) { bodies.delete(tool.id); versionOf.delete(tool.id); }
    }
  }
  const editor = {
    executor: { isBusy: false },
    geo: { get geometryModel() { return new Map([...versionOf.entries()].map(([id, version]) => [version, { view: { id } }])); } },
    db: { lookupStableId: (versionId: number) => stableOf(versionId) },
    commands: { BooleanCommand: class { remember = true; execute: () => Promise<void> = async () => undefined; constructor(_editor: unknown) { history.commands += 1; } } },
    async exec(command: { execute(): Promise<void> }) { history.executions += 1; await command.execute(); },
  };
  const state = (): RuntimeState => ({
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" }, bodies: [],
  }) as unknown as RuntimeState;
  const runtime = {
    async getState() { return state(); },
    async mutate(source: string, bindings: string[], values: unknown[]) {
      assert.deepEqual(bindings, ["BooleanFactory"]);
      return await (new Function(`return (${source})`)() as (...args: unknown[]) => Promise<unknown>).apply(editor, [Factory, ...values]);
    },
  } as unknown as PlasticityRuntime;
  return { operations: new PlasticityOperations(runtime, "session-1"), bodies, history };
}

test("intersection with several tools keeps target AND every tool, in one native command", async () => {
  const f = booleanFixture();
  await f.operations.boolean([1], [2, 3], "intersection", false, "r1");
  const expected = grid(8, 8, (x, y) => x < 3 && y < 3);
  assert.deepEqual([...f.bodies.get(1)!].sort(), [...expected].sort());
  assert.equal(f.bodies.get(1)!.size, 9);
  assert.equal(f.history.executions, 1, "one native command (one Undo step), however many tools");
  assert.equal(f.bodies.has(2) || f.bodies.has(3), false, "tools are consumed without keepTools");
});

test("intersection with several tools and keepTools keeps every tool body", async () => {
  const f = booleanFixture();
  await f.operations.boolean([1], [2, 3], "intersection", true, "r1");
  assert.equal(f.bodies.get(1)!.size, 9);
  assert.equal(f.bodies.get(2)!.size, 24);
  assert.equal(f.bodies.get(3)!.size, 24);
});

test("intersection with one tool and duplicate tool IDs use the single-tool path", async () => {
  const single = booleanFixture();
  await single.operations.boolean([1], [2], "intersection", false, "r1");
  assert.equal(single.bodies.get(1)!.size, 24);
  const duplicate = booleanFixture();
  await duplicate.operations.boolean([1], [2, 2], "intersection", false, "r1");
  assert.equal(duplicate.bodies.get(1)!.size, 24);
});

test("an intersection that fails on a later tool reports the failure", async () => {
  const f = booleanFixture({ failOnTool: 3 });
  await assert.rejects(f.operations.boolean([1], [2, 3], "intersection", false, "r1"), /no effect/);
});

test("union and difference with several tools still pass every tool at once", async () => {
  const union = booleanFixture();
  await union.operations.boolean([1], [2, 3], "union", false, "r1");
  assert.equal(union.bodies.get(1)!.size, 64);
  assert.equal(union.history.executions, 1);
  const difference = booleanFixture();
  await difference.operations.boolean([1], [2, 3], "difference", false, "r1");
  assert.deepEqual([...difference.bodies.get(1)!].sort(), [...grid(8, 8, (x, y) => x >= 3 && y >= 3)].sort());
  assert.equal(difference.bodies.get(1)!.size, 25);
  assert.equal(difference.history.executions, 1);
});

test("overlapping target and tool IDs are still refused before any native call", async () => {
  const f = booleanFixture();
  await assert.rejects(f.operations.boolean([1], [1, 2], "intersection", false, "r1"), /must not overlap/);
  assert.equal(f.history.executions, 0);
});
