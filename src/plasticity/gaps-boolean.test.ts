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

// Kernel ClashType numbers as read live on 26.1.3 (a two-way enum, like the kernel's).
const CLASH = { None: 0, AinB: 1, BinA: 2, Exists: 3, AbutNoClass: 4, AbutBInA: 5, AbutBOutA: 6, Interfere: 7 } as const;
const ClashType: Record<string | number, string | number> = { ...CLASH, ...Object.fromEntries(Object.entries(CLASH).map(([name, value]) => [value, name])) };

// clash: replaces the fixture's own clash answer for one target and tool (a number list, or an Error to throw).
function booleanFixture(options: { failOnTool?: number; failOnTarget?: number; rollBack?: boolean; clash?: (targetId: number, toolId: number) => number[] | Error | undefined } = {}) {
  // Stable ID -> the cells of that body. 8 x 8 targets 1 and 4; tool 2 is x < 3; tool 3 is y < 3. Tool 5 (10 x 10)
  // contains the targets; tool 6 lies beside them; tool 7 (x < 5, y < 5) contains target AND tools 2 and 3 only.
  let bodies = new Map<number, Set<string>>([
    [1, grid(8, 8, () => true)],
    [2, grid(8, 8, (x) => x < 3)],
    [3, grid(8, 8, (_x, y) => y < 3)],
    [4, grid(8, 8, () => true)],
    [5, grid(10, 10, () => true)],
    [6, grid(24, 8, (x) => x >= 20)],
    [7, grid(8, 8, (x, y) => x < 5 && y < 5)],
  ]);
  let versionOf = new Map<number, number>([[1, 11], [2, 12], [3, 13], [4, 14], [5, 15], [6, 16], [7, 17]]);
  let nextVersion = 100;
  let nextId = 50;
  let revision = 1;
  let undoDepth = 0;
  const history = { executions: 0, factories: 0, commands: 0, clashes: [] as Array<[number, number]>, cancelled: 0, deleted: [] as number[] };
  const selected = new Set<number>();
  const stableOf = (versionId: number) => [...versionOf.entries()].find(([, version]) => version === versionId)?.[0];
  class Factory {
    targets: Array<{ id: number }> = [];
    tools: Array<{ id: number }> = [];
    operationType = 0;
    keepTools = false;
    constructor(_editor: unknown) { history.factories += 1; }
    resource(_command: unknown) { return this; }
    async commit() {
      // The renderer's error carries its stack after the first line.
      const noEffect = () => new Error("Operation has no effect\n    at BooleanFactory.calculate (evalmachine.<anonymous>:1:6138886)");
      if (options.failOnTool !== undefined && this.tools.some((tool) => tool.id === options.failOnTool)
        && (options.failOnTarget === undefined || this.targets.some((target) => target.id === options.failOnTarget))) throw noEffect();
      const toolCells = (bodiesOf: Array<{ id: number }>) => bodiesOf.map((body) => bodies.get(body.id)!);
      // Live: the kernel refuses an intersection that would leave the target as it is (a tool that contains it) and one
      // that would leave nothing (a tool that misses it) with the same text.
      if (this.operationType === 15901) {
        const union = new Set(toolCells(this.tools).flatMap((set) => [...set]));
        for (const target of this.targets) {
          const own = bodies.get(target.id)!;
          const kept = [...own].filter((key) => union.has(key)).length;
          if (kept === own.size || kept === 0) throw noEffect();
        }
      }
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
    async cancel() { history.cancelled += 1; }
  }
  // The kernel's clash test on the CURRENT cells: no shared cell is no contact; the target inside the tool is AinB; the
  // tool inside the target BinA; anything else Interfere.
  const pkDefault = { a: {
    ClashType,
    Context: { Get: () => ({}) },
    Eval: class {
      constructor(_context: unknown) {}
      Collisions(targets: Int32Array, tools: Int32Array) {
        const [targetId, toolId] = [stableOf(targets[0]!)!, stableOf(tools[0]!)!];
        history.clashes.push([targetId, toolId]);
        const forced = options.clash?.(targetId, toolId);
        if (forced instanceof Error) throw forced;
        if (forced) return { clashTypes: Int32Array.from(forced) };
        const a = bodies.get(targetId)!, b = bodies.get(toolId)!;
        const shared = [...a].filter((key) => b.has(key)).length;
        const types = shared === 0 ? [] : shared === a.size && a.size < b.size ? [CLASH.AinB] : shared === b.size && b.size < a.size ? [CLASH.BinA] : [CLASH.Interfere, CLASH.Interfere];
        return { clashTypes: Int32Array.from(types) };
      }
    },
  } };
  const editor = {
    executor: { isBusy: false },
    geo: { get geometryModel() { return new Map([...versionOf.entries()].map(([id, version]) => [version, { view: { id }, model: { Id: () => version } }])); } },
    db: { lookupStableId: (versionId: number) => stableOf(versionId) },
    selection: { selected: { removeAll() { selected.clear(); }, add(view: { id: number }) { selected.add(view.id); } } },
    commands: {
      BooleanCommand: class { remember = true; execute: () => Promise<void> = async () => undefined; constructor(_editor: unknown) { history.commands += 1; } },
      // DeleteCommand's own execute: removes the selected bodies (run inside the Boolean command).
      DeleteCommand: class { async execute() { for (const id of selected) { bodies.delete(id); versionOf.delete(id); history.deleted.push(id); } selected.clear(); } },
    },
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
      // Every intersection asks for the kernel too (its clash test); union and difference do not.
      const intersection = /operationType = 15901/.test(source);
      assert.deepEqual(bindings, intersection ? ["BooleanFactory", "pk_default"] : ["BooleanFactory"]);
      return await (new Function(`return (${source})`)() as (...args: unknown[]) => Promise<unknown>).apply(editor, intersection ? [Factory, pkDefault, ...values] : [Factory, ...values]);
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

// ---------- final review B1: several targets with ONE tool ----------

test("B1: two targets with one tool: each target becomes target AND tool and keeps its ID; the tool is kept or consumed as asked", async () => {
  for (const keepTools of [false, true]) {
    const f = booleanFixture();
    const result = await f.operations.booleanDetailed([1, 4], [2], "intersection", keepTools, "r1");
    const expected = [...grid(8, 8, (x) => x < 3)].sort();
    assert.deepEqual([f.bodies.has(1), f.bodies.has(4)], [true, true], `both targets keep their IDs (keepTools ${keepTools}); the bodies are now ${[...f.bodies.keys()]}`);
    assert.deepEqual([...f.bodies.get(1)!].sort(), expected, `target 1 keeps its ID (keepTools ${keepTools})`);
    assert.deepEqual([...f.bodies.get(4)!].sort(), expected, `target 4 keeps its ID (keepTools ${keepTools})`);
    assert.deepEqual([...f.bodies.keys()].filter((id) => id >= 50), [], "no new body IDs");
    assert.equal(f.bodies.has(2), keepTools, "the tool is consumed unless keepTools");
    assert.equal(f.history.executions, 1, "one native command (one Undo step)");
    assert.equal(f.history.factories, 2, "one pass per target");
    assert.equal(result.state.undoDepth, 1);
    assert.deepEqual(result.unchangedBy, []);
  }
});

// ---------- final review B2: a tool that contains the target, and a tool that misses it ----------

test("B2: a containing tool is a no-op for the target: [BIG, A] and [A, BIG] both give target AND A, and the reply names the tool", async () => {
  for (const keepTools of [false, true]) for (const tools of [[5, 2], [2, 5]]) {
    const f = booleanFixture();
    const result = await f.operations.booleanDetailed([1], tools, "intersection", keepTools, "r1");
    assert.deepEqual([...f.bodies.get(1)!].sort(), [...grid(8, 8, (x) => x < 3)].sort(), `tools ${tools} keepTools ${keepTools}`);
    assert.deepEqual(result.unchangedBy, [{ targetId: 1, toolId: 5 }]);
    assert.deepEqual([f.bodies.has(2), f.bodies.has(5)], [keepTools, keepTools], "both tools are consumed unless keepTools, the containing one too");
    assert.deepEqual(f.history.deleted, keepTools ? [] : [5], "the tool whose pass cut nothing is deleted inside the same command");
    assert.equal(f.history.executions, 1);
    assert.equal(result.state.undoDepth, 1, "one Undo step");
    assert.deepEqual(f.history.clashes, [[1, 5]], "the clash test runs only for the pass the kernel refused");
  }
});

test("B2: a single containing tool returns the target at its version, lists the tool in unchangedBy and consumes it unless keepTools", async () => {
  for (const keepTools of [false, true]) {
    const f = booleanFixture();
    const before = f.state();
    const result = await f.operations.booleanDetailed([1, 4], [5], "intersection", keepTools, "r1");
    assert.deepEqual(result.unchangedBy, [{ targetId: 1, toolId: 5 }, { targetId: 4, toolId: 5 }]);
    for (const id of [1, 4]) assert.deepEqual(result.state.bodies.find((body) => body.id === id), before.bodies.find((body) => body.id === id), `target ${id} is at its earlier version`);
    assert.equal(f.bodies.has(5), keepTools);
    assert.equal(f.history.cancelled, 2, "the refused factories are cancelled");
  }
});

test("B2: a containing tool is judged against the CURRENT target: a tool around target AND A only is a no-op after A", async () => {
  const f = booleanFixture();
  // Tool 7 crosses target 1 (it would cut it to 25 cells) but contains target AND tool 2 AND tool 3 (9 cells).
  const result = await f.operations.booleanDetailed([1], [2, 3, 7], "intersection", false, "r1");
  assert.equal(f.bodies.get(1)!.size, 9);
  assert.deepEqual(result.unchangedBy, [{ targetId: 1, toolId: 7 }]);
  assert.equal(f.bodies.has(7), false);
});

test("B2: a tool that misses the target fails: the message says the intersection is empty and the document is unchanged, without a stack", async () => {
  for (const tools of [[6], [2, 6]]) {
    const f = booleanFixture();
    const before = f.state();
    await assert.rejects(f.operations.boolean([1], tools, "intersection", false, "r1"), (error: Error) => {
      assert.match(error.message, /^Intersection of target 1 with tool 6 failed: the intersection is empty: Plasticity refused it \(Operation has no effect\) and the kernel clash test finds no contact between the two bodies\. Plasticity rolled the command back: the document reads back as before this call \(Undo depth 0, every body at its earlier version\); the current revision is r2\. The document is unchanged\.$/);
      assert.doesNotMatch(error.message, /evalmachine|\n/);
      return true;
    });
    assert.deepEqual(f.state().bodies, before.bodies);
    assert.equal(f.state().undoDepth, before.undoDepth);
    assert.equal(f.bodies.get(1)!.size, 64);
  }
});

test("B2: the kernel decides first: a clash answer of AinB never skips a pass the kernel cuts (a tool with a void inside the target)", async () => {
  // Live: a 60 mm box with a 10 mm void inside a 40 mm target answers [AinB], and the kernel still cuts 1,000 mm3.
  const f = booleanFixture({ clash: () => [CLASH.AinB] });
  const result = await f.operations.booleanDetailed([1], [2], "intersection", false, "r1");
  assert.equal(f.bodies.get(1)!.size, 24, "the kernel's cut stands");
  assert.deepEqual(result.unchangedBy, []);
  assert.deepEqual(f.history.clashes, [], "no clash test for a pass the kernel ran");
});

test("B2: bodies that only touch have no volume; a refusal the clash test cannot explain says so and gives the document state", async () => {
  const touching = booleanFixture({ clash: () => [CLASH.AbutNoClass, CLASH.AbutNoClass] });
  await assert.rejects(touching.operations.boolean([1], [6], "intersection", false, "r1"), /^Error: Intersection of target 1 with tool 6 failed: the intersection has no volume: Plasticity refused it \(Operation has no effect\) and the kernel clash test finds the two bodies touching only on their surfaces\. Plasticity rolled the command back: .*The document is unchanged\.$/);
  // The kernel says "no effect" although the bodies cross: neither containment nor a miss is proven.
  const crossing = booleanFixture({ failOnTool: 3 });
  const before = crossing.state();
  await assert.rejects(crossing.operations.boolean([1], [2, 3], "intersection", false, "r1"),
    /^Error: Intersection of target 1 with tool 3 failed: Operation has no effect\. Plasticity rolled the command back: the document reads back as before this call \(Undo depth 0, every body at its earlier version\); the current revision is r2\. The document is unchanged\. The kernel clash test could not tell a tool that contains the target \(which would leave the target unchanged\) from an empty intersection: it reported Interfere\.$/);
  assert.deepEqual(crossing.state().bodies, before.bodies);
  // The clash test itself fails: the same refusal, with its error.
  const broken = booleanFixture({ clash: () => new Error("Collisions is not a function") });
  await assert.rejects(broken.operations.boolean([1], [5], "intersection", false, "r1"), /^Error: Intersection of target 1 with tool 5 failed: Operation has no effect\. Plasticity rolled the command back: .*The document is unchanged\. The kernel clash test could not tell .* from an empty intersection: it failed \(Collisions is not a function\)\.$/);
  // Without a rollback the note still follows the document state.
  const kept = booleanFixture({ failOnTool: 3, rollBack: false });
  await assert.rejects(kept.operations.boolean([1], [2, 3], "intersection", false, "r1"), /The document does not read back as before this call \(Undo depth 0, was 0\); read the bodies before you continue; the current revision is r2\. The kernel clash test could not tell/);
});

test("B2: a failure that is not 'no effect' is quoted as before, by its first line", async () => {
  const f = booleanFixture();
  await assert.rejects(f.operations.boolean([1], [99], "intersection", false, "r1"), /Unknown body ID: 99/);
});
