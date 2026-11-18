import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { PlasticityOperations, type OutputFileOptions } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

// overwrite: true on every tool that writes a file at a caller-given path. Each case runs the real
// PlasticityOperations method against the real file system; the runtime fake writes what Plasticity would stage.

const construction: RuntimeState["construction"] = { planes: [], activePlaneId: "standard:top", planeStateToken: "planes:empty", viewStateToken: "workplane:standard:top" };
const body = (id: number, type: string) => ({ id, versionId: id + 10, type, name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] });
const state = { targetId: "window-1", title: "Untitled - Plasticity", documentToken: "document-1", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction, regions: [], bodies: [body(7, "Solid"), body(8, "Wire")] } as unknown as RuntimeState;

function png(shade: number): Buffer {
  const data = Buffer.alloc(32, shade);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data, 0);
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(1, 16);
  data.writeUInt32BE(1, 20);
  return data;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries: Array<readonly [string, Buffer]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const filename = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function threeMf(width: number): Buffer {
  const model = `<model unit="meter"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="${width}" y="0" z="0"/><vertex x="0" y="0.01" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
  return storedZip([
    ["[Content_Types].xml", Buffer.from('<Types><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')],
    ["_rels/.rels", Buffer.from('<Relationships><Relationship Target="/3D/3dmodel.model"/></Relationships>')],
    ["3D/3dmodel.model", Buffer.from(model)],
  ]);
}

function stl(triangles: number): Buffer {
  const data = Buffer.alloc(84 + triangles * 50, 1);
  data.writeUInt32LE(triangles, 80);
  return data;
}

const igesLine = (text: string, section: string) => `${text.padEnd(72)}${section}      1\n`;

interface Case {
  tool: string;
  extension: string;
  /** What Plasticity stages (variant 1 is the old file's content, variant 2 the new one's). */
  staged(variant: 1 | 2): Buffer | unknown;
  run(operations: PlasticityOperations, output: string, options?: OutputFileOptions): Promise<{ path: string; bytes: number }>;
}

const wire = (width: number) => [{ id: 8, closed: true, plane: { originMm: [0, 0, 0], normal: [0, 0, 1] }, segments: [
  { curveType: "Line", startMm: [0, 0, 0], endMm: [width, 0, 0] }, { curveType: "Line", startMm: [width, 0, 0], endMm: [width, 10, 0] },
  { curveType: "Line", startMm: [width, 10, 0], endMm: [0, 10, 0] }, { curveType: "Line", startMm: [0, 10, 0], endMm: [0, 0, 0] },
] }];
const projection = (width: number) => ({ positions: [0, 0, width, 0, width, 50], segments: [{ bodyIndex: 0, category: "Visible", offset: 0, count: 3 }], scaleXmmPerPixel: 0.01, scaleYmmPerPixel: 0.01, cameraType: "OrthographicCamera" });
const options = (value: OutputFileOptions | undefined): [] | [OutputFileOptions] => (value ? [value] : []);

const CASES: Case[] = [
  { tool: "plasticity_export_step", extension: ".step", staged: (v) => Buffer.from(`ISO-10303-21;\nHEADER;\nFILE_NAME('x','t',(''),(''),'a','b','c');\nENDSEC;\nDATA;\n#1=PRODUCT('part ${v}','','',());\nENDSEC;\nEND-ISO-10303-21;\n`), run: (o, path, opt) => o.exportStep([7], path, "r1", ...options(opt)) },
  { tool: "plasticity_export_parasolid", extension: ".x_t", staged: (v) => Buffer.from(`**ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz**************************\n**PARASOLID test fixture ${v}\n`), run: (o, path, opt) => o.exportParasolid([7], path, "r1", ...options(opt)) },
  { tool: "plasticity_export_iges", extension: ".igs", staged: (v) => Buffer.from(igesLine(`IGES test fixture ${v}`, "S") + igesLine("fixture", "G")), run: (o, path, opt) => o.exportIges([7], path, "r1", ...options(opt)) },
  { tool: "plasticity_export_sat", extension: ".sat", staged: (v) => Buffer.from(`700 0 1 0 \n12 1 1 0\nbody $-1 -${v} $-1 $1 $-1 $-1 #\n`), run: (o, path, opt) => o.exportSat([7], path, "r1", ...options(opt)) },
  { tool: "plasticity_export_stl", extension: ".stl", staged: (v) => stl(v), run: (o, path, opt) => o.exportStl([7], path, "r1", 0.05, 15, ...options(opt)) },
  { tool: "plasticity_export_3mf", extension: ".3mf", staged: (v) => threeMf(v === 1 ? 0.02 : 0.03), run: (o, path, opt) => o.export3mf([7], path, "r1", 0.05, 15, ...options(opt)) },
  { tool: "plasticity_export_obj", extension: ".obj", staged: (v) => Buffer.from(`o Box\nv 0 0 0\nv ${v}0 0 0\nv 0 10 5\nvt 0 0\nvt 1 0\nvt 0 1\nvn 0 0 1\nf 1/1/1 2/2/1 3/3/1\n`), run: (o, path, opt) => o.exportObj([7], path, "r1", 0.05, 15, ...options(opt)) },
  { tool: "plasticity_export_svg", extension: ".svg", staged: (v) => wire(v * 20), run: (o, path, opt) => o.exportSvg([8], path, "r1", 0.05, 5, ...options(opt)) },
  { tool: "plasticity_export_hiddenline_svg", extension: ".svg", staged: (v) => projection(v * 100), run: (o, path, opt) => o.exportHiddenLineSvg([7], path, "r1", 0.05, 5, 1, ...options(opt)) },
  { tool: "plasticity_screenshot", extension: ".png", staged: (v) => png(v), run: (o, path, opt) => o.screenshot(path, "window", ...options(opt)) },
  { tool: "plasticity_save_copy", extension: ".plasticity", staged: (v) => Buffer.concat([Buffer.from("plasticity"), Buffer.alloc(20, v)]), run: (o, path, opt) => o.saveCopy(path, ...options(opt)) },
];

function fixture(testCase: Case) {
  let variant: 1 | 2 = 1;
  let fail: "throw" | "invalid" | undefined;
  let nativeCalls = 0;
  const staged = () => testCase.staged(variant);
  const runtime = {
    isUncertain: () => false,
    async getState() { return state; },
    async cdp() {},
    async read() { return false; }, // document.hidden
    async captureScreenshot() {
      nativeCalls += 1;
      if (fail === "throw") throw new Error("capture failed");
      return (fail === "invalid" ? Buffer.from("not a png") : staged() as Buffer).toString("base64");
    },
    async readNative() {
      nativeCalls += 1;
      if (fail === "throw") throw new Error("native read failed");
      if (fail === "invalid") return testCase.tool === "plasticity_export_svg" ? [{ ...wire(20)[0], plane: null }] : { ...projection(100), cameraType: "PerspectiveCamera" };
      return staged();
    },
    async mutate(_source: string, _bindings: string[], values: unknown[]) {
      nativeCalls += 1;
      if (fail === "throw") throw new Error("native export failed");
      const first = values[0] as string | { path: string };
      await writeFile(typeof first === "string" ? first : first.path, fail === "invalid" ? Buffer.from("garbage that no validator accepts\n") : staged() as Buffer);
      return {};
    },
  } as unknown as PlasticityRuntime;
  return {
    operations: new PlasticityOperations(runtime, "session-1"),
    use(next: 1 | 2) { variant = next; fail = undefined; },
    failWith(mode: "throw" | "invalid") { fail = mode; },
    nativeCalls: () => nativeCalls,
  };
}

/** Everything in the folder besides the named files: staging folders and temporary files show up here. */
async function leftovers(folder: string, expected: string[]): Promise<string[]> {
  return (await readdir(folder)).filter((name) => !expected.includes(name)).sort();
}

for (const testCase of CASES) {
  test(`${testCase.tool}: an existing file is refused by default and replaced with overwrite: true`, async () => {
    const root = await mkdtemp(join(tmpdir(), "plasticity-overwrite-"));
    try {
      const f = fixture(testCase);
      const output = join(root, `part${testCase.extension}`);
      f.use(1);
      const first = await testCase.run(f.operations, output);
      assert.equal(first.path, output);
      const old = await readFile(output);
      assert.ok(old.length > 0);

      // Default: refused before anything native runs, the message names the option, the old file is untouched.
      f.use(2);
      const before = f.nativeCalls();
      await assert.rejects(testCase.run(f.operations, output), (error: Error) => {
        assert.match(error.message, /^Refusing to overwrite existing file: /);
        assert.match(error.message, /overwrite: true/);
        return true;
      });
      await assert.rejects(testCase.run(f.operations, output, { overwrite: false }), /Refusing to overwrite existing file/);
      assert.equal(f.nativeCalls(), before, "the refusal comes before the native export");
      assert.deepEqual(await readFile(output), old);

      // overwrite: true replaces the regular file with different content and leaves nothing else behind.
      const replaced = await testCase.run(f.operations, output, { overwrite: true });
      assert.equal(replaced.path, output);
      const now = await readFile(output);
      assert.notDeepEqual(now, old, "the new file's content differs from the old one");
      assert.equal(replaced.bytes, now.length);
      assert.ok((await lstat(output)).isFile());
      assert.deepEqual(await leftovers(root, [`part${testCase.extension}`]), [], "no temporary file or staging folder remains");

      // overwrite: true on a path that does not exist yet simply writes it.
      const fresh = join(root, `fresh${testCase.extension}`);
      const written = await testCase.run(f.operations, fresh, { overwrite: true });
      assert.ok((await lstat(fresh)).isFile());
      assert.equal((await readFile(fresh)).length, written.bytes);
      assert.deepEqual(await leftovers(root, [`part${testCase.extension}`, `fresh${testCase.extension}`]), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`${testCase.tool}: overwrite: true refuses a directory, a symbolic link and a wrong extension, before the native export`, async () => {
    const root = await mkdtemp(join(tmpdir(), "plasticity-overwrite-"));
    try {
      const f = fixture(testCase);
      const directory = join(root, `folder${testCase.extension}`);
      await mkdir(directory);
      await writeFile(join(directory, "keep.txt"), "kept");
      const target = join(root, `target${testCase.extension}`);
      await writeFile(target, "the link's target");
      const link = join(root, `link${testCase.extension}`);
      await symlink(target, link);
      const dangling = join(root, `dangling${testCase.extension}`);
      await symlink(join(root, "nowhere"), dangling);

      await assert.rejects(testCase.run(f.operations, directory, { overwrite: true }), /is a directory; overwrite: true replaces a regular file only/);
      await assert.rejects(testCase.run(f.operations, link, { overwrite: true }), /is a symbolic link; overwrite: true replaces a regular file only/);
      await assert.rejects(testCase.run(f.operations, dangling, { overwrite: true }), /is a symbolic link/);
      await assert.rejects(testCase.run(f.operations, dangling), /Refusing to overwrite existing file/);
      await assert.rejects(testCase.run(f.operations, join(root, "part.wrong"), { overwrite: true }), /must end in|Output must end/i);
      assert.equal(f.nativeCalls(), 0, "nothing native ran for a refused path");

      assert.equal(await readFile(join(directory, "keep.txt"), "utf8"), "kept");
      assert.equal(await readFile(target, "utf8"), "the link's target", "nothing was written through the link");
      assert.equal(await readlink(link), target);
      assert.ok((await lstat(link)).isSymbolicLink());
      assert.deepEqual(await leftovers(root, [`folder${testCase.extension}`, `target${testCase.extension}`, `link${testCase.extension}`, `dangling${testCase.extension}`]), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`${testCase.tool}: a failed export with overwrite: true leaves the old file byte-identical and no temporary file`, async () => {
    const root = await mkdtemp(join(tmpdir(), "plasticity-overwrite-"));
    try {
      const f = fixture(testCase);
      const output = join(root, `part${testCase.extension}`);
      f.use(1);
      await testCase.run(f.operations, output);
      const old = await readFile(output);
      for (const mode of ["throw", "invalid"] as const) {
        f.failWith(mode);
        await assert.rejects(testCase.run(f.operations, output, { overwrite: true }));
        assert.deepEqual(await readFile(output), old, `${mode}: the old file is byte-identical`);
        assert.deepEqual(await leftovers(root, [`part${testCase.extension}`]), [], `${mode}: nothing is left behind`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("a target that turns into a directory while the export runs is still refused, and the temporary file is removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-overwrite-"));
  try {
    const output = join(root, "part.stl");
    await writeFile(output, "old");
    const runtime = {
      isUncertain: () => false,
      async getState() { return state; },
      async mutate(_source: string, _bindings: string[], values: unknown[]) {
        await writeFile((values[0] as { path: string }).path, stl(2));
        // Between the first check and the rename the regular file is swapped for a directory.
        await rm(output);
        await mkdir(output);
        return {};
      },
    } as unknown as PlasticityRuntime;
    await assert.rejects(new PlasticityOperations(runtime).exportStl([7], output, "r1", 0.05, 15, { overwrite: true }), /is a directory/);
    assert.ok((await lstat(output)).isDirectory());
    assert.deepEqual(await readdir(output), []);
    assert.deepEqual(await leftovers(root, ["part.stl"]), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opening a document never overwrites its backup: the backup path takes no overwrite", async () => {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), "operations.ts"), "utf8");
  assert.match(source, /await this\.saveCopy\(backupPath\);/);
});

test("every file a tool puts at a caller-given path goes through the overwrite helpers", async () => {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), "operations.ts"), "utf8");
  // One early check per writer, each passing the caller's option; none of the old unconditional check is left.
  assert.equal(source.match(/await assertWritableOutput\(output, options\.overwrite === true\);/g)?.length, 11);
  assert.equal(source.includes("assertAbsent"), false);
  // Ten staged files are committed and one buffer (the screenshot) is written, all through the helpers.
  assert.equal(source.match(/await commitOutputFile\(temporary, output, options\.overwrite === true\);/g)?.length, 10);
  assert.equal(source.match(/await writeOutputFile\(output, data, options\.overwrite === true\);/g)?.length, 1);
  // Outside the helpers nothing copies or writes onto `output` any more.
  assert.equal(source.match(/copyFile\(temporary, output/g)?.length, 1, "only commitOutputFile's own exclusive copy");
  assert.equal(source.match(/writeFile\(output,/g)?.length, 1, "only writeOutputFile's own exclusive write");
});
