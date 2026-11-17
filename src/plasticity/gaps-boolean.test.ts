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

function booleanFixture(options: { failOnTool?: number; failOnTarget?: number; rollBack?: boolean } = {}) {
  // Stable ID -> the cells of that body. 8 x 8 targets 1 and 4; tool 2 is x < 3; tool 3 is y < 3.
  let bodies = new Map<number, Set<string>>([
    [1, grid(8, 8, () => true)],
    [2, grid(8, 8, (x) => x < 3)],
    [3, grid(8, 8, (_x, y) => y < 3)],
    [4, grid(8, 8, () => true)],
  ]);
  let versionOf = new Map<number, number>([[1, 11], [2, 12], [3, 13], [4, 14]]);
  let nextVersion = 100;
  let nextId = 50;
  let revision = 1;
  let undoDepth = 0;
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
      if (options.failOnTool !== undefined && this.tools.some((tool) => tool.id === options.failOnTool)
        && (options.failOnTarget === undefined || this.targets.some((target) => target.id === options.failOnTarget))) throw new Error("Operation has no effect");
      const toolCells = (bodiesOf: Array<{ id: number }>) => bodiesOf.map((body) => bodies.get(body.id)!);
      for (const target of this.targets) {
        const own = bodies.get(target.id)!;
        const tools = toolCells(this.tools);
        const union = new Set(tools.flatMap((set) => [...set]));
        const result = this.operationType === 15901 ? new Set([...own].filter((key) => union.has(key)))
          : this.operationType === 15902 ? new Set([...own].filter((key) => !union.has(key))) : new Set([...own, ...union]);
        // Live: an intersection with several targets gives every result a new body ID.
        const id = this.operationType === 15901 && this.targets.length > 1 ? nextId++ : target.id;
        if (id !== target.id) { bodies.delete(target.id); versionOf.delete(target.id); }
        bodies.set(id, result);
        versionOf.set(id, nextVersion++);
      }
      if (!this.keepTools) for (const tool of this.tools) { bodies.delete(tool.id); versionOf.delete(tool.id); }
    }
  }
  const editor = {
    executor: { isBusy: false },
    geo: { get geometryModel() { return new Map([...versionOf.entries()].map(([id, version]) => [version, { view: { id } }])); } },
    db: { lookupStableId: (versionId: number) => stableOf(versionId) },
    commands: { BooleanCommand: class { remember = true; execute: () => Promise<void> = async () => undefined; constructor(_editor: unknown) { history.commands += 1; } } },
    async exec(command: { execute(): Promise<void> }) {
      history.executions += 1;
      const saved = { bodies: new Map(bodies), versionOf: new Map(versionOf) };
      try {
        await command.execute();
        undoDepth += 1;
      } catch (error) {
        // Plasticity rolls a failed command back; the revision still moves.
        if (options.rollBack !== false) { bodies = saved.bodies; versionOf = saved.versionOf; }
        throw error;
      } finally {
        revision += 1;
      }
    },
  };
  const state = (): RuntimeState => ({
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: `r${revision}`, dbVersion: revision, undoDepth, redoDepth: 0, regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p", viewStateToken: "v" },
    bodies: [...versionOf.entries()].map(([id, versionId]) => ({ id, versionId, type: "Solid", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] })),
  }) as unknown as RuntimeState;
  const runtime = {
    async getState() { return state(); },
    isUncertain: () => false,
    async mutate(source: string, bindings: string[], values: unknown[]) {
      assert.deepEqual(bindings, ["BooleanFactory"]);
      return await (new Function(`return (${source})`)() as (...args: unknown[]) => Promise<unknown>).apply(editor, [Factory, ...values]);
    },
  } as unknown as PlasticityRuntime;
  return { operations: new PlasticityOperations(runtime, "session-1"), get bodies() { return bodies; }, history, state };
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

test("an intersection that fails on a later tool names target and tool, and the rolled-back document reads back as before", async () => {
  const f = booleanFixture({ failOnTool: 3 });
  const before = f.state();
  await assert.rejects(f.operations.boolean([1], [2, 3], "intersection", false, "r1"), (error: Error) => {
    assert.match(error.message, /Intersection of target 1 with tool 3 failed: Operation has no effect\. Plasticity rolled the command back: the document reads back as before this call \(Undo depth 0, every body at its earlier version\); the current revision is r2\./);
    return true;
  });
  const after = f.state();
  assert.equal(after.undoDepth, before.undoDepth);
  assert.deepEqual(after.bodies, before.bodies, "every body, at its version, as before");
  assert.notEqual(after.revision, before.revision, "the rollback moves the revision");
  assert.equal(f.bodies.get(1)!.size, 64);
  assert.equal(f.bodies.get(2)!.size, 24);
});

test("with several targets, a failure on the second target after the first one's passes is rolled back whole", async () => {
  const f = booleanFixture({ failOnTool: 3, failOnTarget: 4 });
  const before = f.state();
  await assert.rejects(f.operations.boolean([1, 4], [2, 3], "intersection", false, "r1"), /Intersection of target 4 with tool 3 failed: Operation has no effect\. Plasticity rolled the command back: the document reads back as before this call/);
  assert.deepEqual(f.state().bodies, before.bodies);
  assert.equal(f.bodies.get(1)!.size, 64, "the first target's finished passes are undone too");
  const kept = booleanFixture({ failOnTool: 3, rollBack: false });
  await assert.rejects(kept.operations.boolean([1], [2, 3], "intersection", false, "r1"), /The document does not read back as before this call \(Undo depth 0, was 0\); read the bodies before you continue; the current revision is r2\./);
});

test("several targets with several tools: every target is intersected with every tool, keeps its ID, in one command", async () => {
  for (const keepTools of [false, true]) {
    const f = booleanFixture();
    await f.operations.boolean([1, 4], [2, 3], "intersection", keepTools, "r1");
    const expected = [...grid(8, 8, (x, y) => x < 3 && y < 3)].sort();
    assert.deepEqual([...f.bodies.get(1)!].sort(), expected);
    assert.deepEqual([...f.bodies.get(4)!].sort(), expected);
    assert.equal(f.history.executions, 1);
    assert.equal(f.history.factories, 4, "one pass per target and tool");
    assert.equal(f.bodies.has(2) && f.bodies.has(3), keepTools, `keepTools ${keepTools}`);
    if (keepTools) assert.equal(f.bodies.get(2)!.size + f.bodies.get(3)!.size, 48);
    assert.deepEqual([...f.bodies.keys()].filter((id) => id >= 50), [], "no new body IDs");
  }
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
