#!/usr/bin/env node
// Live acceptance for the surfacing tools (probe_surface, exact_bounds, xsided_patch errors and options, screenshot
// shader/frame, continuity read-out, surface_align, square_surface). Isolated Plasticity instance only.
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { discoverPlasticityTargets } from "../src/cdp/discovery.ts";
import { nativeFunction } from "../src/plasticity/native-function.ts";
import { PlasticityOperations } from "../src/plasticity/operations.ts";
import { SCREENSHOT_VIEW_SOURCE } from "../src/plasticity/surfacing.ts";
import { PlasticityRuntime } from "../src/plasticity/runtime.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SECTIONS = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p6stall", "p6select"] as const;
// p6stall is opt-in (--only p6stall): an injected stall ends in a cancel while Plasticity may still be computing, and in
// one of about 150 such trials the isolated renderer died.
// p6select is opt-in (--only p6select): the final review's A1 check (an edit straight after an align, with faces still
// selected). Before the selection guard it failed 7 of 7 on Plasticity 26.1.3, and not because of the align: with a
// face selected, Plasticity starts its default face command after ANY command that finished, so the edit call never
// returned (discovery/probes-2026-11-surfacing/FINDINGS.md, "Selected faces and the next edit"). Since the guard
// (runtime.ts, SELECTION_GUARD_SOURCE; probes-2026-11-pick FINDINGS, "Selection and default commands") it passes 7 of
// 7. It stays opt-in because it runs plasticity_surface_align seven times.
const DEFAULT_SECTIONS: Section[] = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
type Section = (typeof SECTIONS)[number];

export interface SurfacingOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
  shots?: string;
  only?: Section[];
}

export function parseSurfacingArgs(argv: string[]): SurfacingOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: SurfacingOptions = { help: false, allowDisposableMutations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => { const next = argv[++index]; if (!next) throw new Error(`${argument} requires a value`); return next; };
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--target") options.target = value();
    else if (argument === "--output") options.output = value();
    else if (argument === "--shots") options.shots = value();
    else if (argument === "--only") {
      const list = value().split(",");
      const unknown = list.filter((entry) => !(SECTIONS as readonly string[]).includes(entry));
      if (unknown.length > 0) throw new Error(`Unknown section: ${unknown.join(", ")}`);
      options.only = list as Section[];
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live surfacing acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live surfacing acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live surfacing acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-surfacing-live.ts --help
  node scripts/verify-native-surfacing-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY [--shots NEW_DIRECTORY] [--only p1,p2,...]

With no arguments or --help, this command performs no connection and no mutation.
PLASTICITY_CDP_URL is mandatory: set it to the isolated Plasticity instance. The command never launches Plasticity
(it forces PLASTICITY_AUTO_LAUNCH=0 and PLASTICITY_HUD=0) and refuses to start without the variable.
It builds disposable geometry at x >= 5000 mm and checks, per section:
  p1 plasticity_probe_surface: sphere r20, cylinder r10, a 30 degree plane, a cubic Bezier extruded sheet against
     analytic heights within 1e-6 mm; a miss; four hits through a holed block; the benchmark grip pad; undo depth and
     body count unchanged by every call.
  p2 boundsMethod on a box, a filleted box, a lofted sheet and the grip pad; plasticity_exact_bounds; describe_body
     boundsExact (true, true, false, false); the pad's support top cross-checked with a probe ray.
  p3 plasticity_xsided_patch: error 30 reproduced with its message and nothing created; edgeContinuity, tension and
     quality each change the patch on the benchmark's three-sheet hole.
  p4 plasticity_screenshot shader (six modes) and frame: pixel statistics against the default, the default again,
     undo depth, a forced failure that still restores the shader, the camera back exactly. --shots saves six small PNGs.
  p5 plasticity_analyze_surface_continuity: interior, worstAt (a corner case) and absoluteCurvature.
  p6 plasticity_surface_align: G0, G1, G2 and swapped order, read back by joining and the continuity tool; refused inputs;
     a 20 mm edge aligned to a 30 mm curve (a certain mismatch that one undo restores); no prototype patches or globals
     left behind.
  p6stall (opt-in) stalls injected at the operations layer before and after finish(): classified, never a certain
     "unchanged" after finish(). One of about 150 such trials killed the renderer, so it is not in the default run.
  p6select (opt-in) the final review's A1 check: plasticity_join_sheets, plasticity_move and plasticity_fillet straight
     after an align with one and with two faces selected (under 1 s, selection kept, no active command), plus the same
     edit with no align. Failed 7 of 7 before the selection guard; passes 7 of 7 with it.
  p7 plasticity_square_surface: four curves (boundary heights read by probe rays); a flat neighbour Sheet plus three
     curves at g0 and g1 (joined, read by the continuity tool); error 30 on an open box at g1; refusals; one undo restores.
Every section undoes to its start. At the end the undo depth, body set, shader and camera equal the start.`;

// ---------------------------------------------------------------- PNG (8-bit RGB/RGBA, no interlace) ----------------------------------------------------------------
interface Image { width: number; height: number; rgb: Uint8Array }
function decodePng(data: Buffer): Image {
  if (data.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let offset = 8, width = 0, height = 0, colorType = 0;
  const idat: Buffer[] = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset), type = data.toString("ascii", offset + 4, offset + 8), body = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); colorType = body[9]!;
      if (body[8] !== 8 || body[12] !== 0 || (colorType !== 2 && colorType !== 6)) throw new Error("unsupported PNG layout");
    } else if (type === "IDAT") idat.push(body);
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : 3, stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(width * height * channels), rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!, line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels]! : 0, b = y > 0 ? out[(y - 1) * stride + x]! : 0, c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      out[y * stride + x] = (line[x]! + predictor) & 255;
    }
  }
  for (let i = 0; i < width * height; i++) for (let k = 0; k < 3; k++) rgb[3 * i + k] = out[channels * i + k]!;
  return { width, height, rgb };
}
function crc32(buffer: Buffer): number {
  let crc = ~0;
  for (const byte of buffer) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return ~crc >>> 0;
}
function encodePng(image: Image): Buffer {
  const chunk = (type: string, body: Buffer) => { const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(type, 4, "ascii"); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), body])), 0); return Buffer.concat([head, body, tail]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(image.width, 0); ihdr.writeUInt32BE(image.height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((image.width * 3 + 1) * image.height);
  for (let y = 0; y < image.height; y++) Buffer.from(image.rgb.buffer, image.rgb.byteOffset + y * image.width * 3, image.width * 3).copy(raw, y * (image.width * 3 + 1) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function shrink(image: Image, factor: number): Image {
  const width = Math.floor(image.width / factor), height = Math.floor(image.height / factor), rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let k = 0; k < 3; k++) rgb[3 * (y * width + x) + k] = image.rgb[3 * (y * factor * image.width + x * factor) + k]!;
  return { width, height, rgb };
}
function pixelDiff(a: Image, b: Image): { meanAbsDiff: number; fractionChanged: number } {
  if (a.width !== b.width || a.height !== b.height) throw new Error("image sizes differ");
  let sum = 0, changed = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    const d = (Math.abs(a.rgb[3 * i]! - b.rgb[3 * i]!) + Math.abs(a.rgb[3 * i + 1]! - b.rgb[3 * i + 1]!) + Math.abs(a.rgb[3 * i + 2]! - b.rgb[3 * i + 2]!)) / 3;
    sum += d; if (d > 16) changed++;
  }
  return { meanAbsDiff: sum / n, fractionChanged: changed / n };
}

// ---------------------------------------------------------------- renderer reads (read-only) ----------------------------------------------------------------
const VIEW_STATE = nativeFunction`function () {
  let bodies = 0;
  for (const [versionId] of nativeApi.geo.geometryModel) if (!nativeApi.geo.automatics.has(versionId)) bodies += 1;
  const viewport = Array.from(this.viewports)[0];
  const memento = this.shading.saveToMemento();
  return {
    undoDepth: this.history.undoStack.length, bodies, busy: Boolean(this.executor.isBusy),
    activeCommand: this.executor.active ? (this.executor.active.command?.constructor?.name ?? 'unknown') : null,
    shader: memento.shader ? String(memento.shader.name) : null,
    camera: { position: viewport.camera.position.toArray(), target: viewport.camera.target.toArray(), quaternion: viewport.camera.quaternion.toArray(), zoom: viewport.camera.zoom },
    pendingView: Boolean(globalThis[Symbol.for('plasticity-mcp.screenshot-view')]),
    globals: Object.getOwnPropertyNames(globalThis).filter(name => /align|probe|plasticity|surfacing/i.test(name)).sort(),
  };
}`;
// The camera with every orbit-control field (plain numbers), and the same put back exactly: the S1 check moves the camera
// with plasticity_set_camera and must leave the instance as it found it.
const SAVE_CAMERA = `function () {
  const viewport = Array.from(this.viewports)[0], camera = viewport.camera, controls = viewport.orbitControls, out = { vectors: {}, numbers: {}, wantsSnap: controls.wantsSnap };
  for (const name of ['target', 'targetEnd', 'focalOffset', 'focalOffsetEnd', 'pivot', 'quaternion', 'quaternionEnd', 'snaplessQuaternion', 'snappedQuaternion']) if (controls[name]?.toArray) out.vectors[name] = controls[name].toArray();
  for (const name of ['radius', 'radiusEnd', 'zoom', 'zoomEnd']) if (typeof controls[name] === 'number') out.numbers[name] = controls[name];
  return { controls: out, position: camera.position.toArray(), target: camera.target.toArray(), quaternion: camera.quaternion.toArray(), zoom: camera.zoom };
}`;
const RESTORE_CAMERA = `async function (args) {
  const viewport = Array.from(this.viewports)[0], camera = viewport.camera, controls = viewport.orbitControls, saved = args.camera;
  for (const [name, value] of Object.entries(saved.controls.vectors)) controls[name].fromArray(value);
  for (const [name, value] of Object.entries(saved.controls.numbers)) controls[name] = value;
  if (typeof saved.controls.wantsSnap === 'boolean') controls.wantsSnap = saved.controls.wantsSnap;
  for (const name of ['targetVelocity', 'focalOffsetVelocity']) controls[name]?.set?.(0, 0, 0);
  for (const name of ['radiusVelocity', 'zoomVelocity']) if (controls[name] && typeof controls[name].value === 'number') controls[name].value = 0;
  camera.zoom = saved.zoom;
  controls.setNeedsUpdate(); controls.update(1 / 60); camera.updateProjectionMatrix();
  camera.position.fromArray(saved.position); camera.quaternion.fromArray(saved.quaternion); camera.target.fromArray(saved.target); camera.zoom = saved.zoom;
  camera.updateMatrixWorld?.(true); camera.updateProjectionMatrix();
  viewport.setNeedsRender();
  for (let i = 0; i < 6; i += 1) await new Promise(resolve => { let done = false; const finish = () => { if (!done) { done = true; resolve(); } }; try { requestAnimationFrame(finish); } catch { finish(); } setTimeout(finish, 250); });
  return { position: camera.position.toArray(), target: camera.target.toArray(), quaternion: camera.quaternion.toArray(), zoom: camera.zoom };
}`;
const CANCEL_ACTIVE = nativeFunction`async function () {
  if (this.executor.active) await this.executor.cancelActiveCommand();
  for (let i = 0; i < 40 && this.executor.active; i++) await new Promise(resolve => setTimeout(resolve, 50));
  this.selection.selected.removeAll(); this.selection.hits?.clear?.();
  return this.executor.active?.command?.constructor?.name ?? null;
}`;
// Prototype hygiene: each own property of the align/square classes' prototypes as name, kind and a hash of the
// function source; a wrapped (patched) method changes its source, so two fingerprints differ.
const PROTOTYPE_FINGERPRINT = `function (...bound) {
  bound.pop();
  const hash = text => { let h = 0; for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0; return h; };
  return bound.map(C => C && C.prototype ? Object.getOwnPropertyNames(C.prototype).sort().map(name => { const d = Object.getOwnPropertyDescriptor(C.prototype, name); return name + ':' + (typeof d.value === 'function' ? hash(String(d.value)) : typeof d.value) + (d.get ? ':g' + hash(String(d.get)) : '') + (d.set ? ':s' + hash(String(d.set)) : ''); }).join('|') : null);
}`;

// ---------------------------------------------------------------- helpers ----------------------------------------------------------------
interface Ctx {
  client: Client;
  native: PlasticityRuntime;
  evidence: Record<string, any>;
  failures: string[];
  shots?: string;
  output: string;
}
const tolerance = 1e-6;
function check(ctx: Ctx, section: string, label: string, ok: boolean, detail?: unknown) {
  (ctx.evidence[section].checks ??= []).push({ label, ok, ...(detail === undefined ? {} : { detail }) });
  if (!ok) ctx.failures.push(`${section}: ${label}${detail === undefined ? "" : ` (${JSON.stringify(detail).slice(0, 400)})`}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${section} ${label}`);
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const text = (response.content as Array<{ type: string; text?: string }>).filter((entry) => entry.type === "text").map((entry) => entry.text ?? "").join("");
  if (response.isError) throw new Error(text);
  try { return JSON.parse(text); } catch { return text; }
}
async function tryCall(client: Client, name: string, args: Record<string, unknown>): Promise<{ ok: true; value: any } | { ok: false; error: string }> {
  try { return { ok: true, value: await call(client, name, args) }; } catch (error) { return { ok: false, error: (error as Error).message.slice(0, 2000) }; }
}
async function status(client: Client): Promise<any> { return await call(client, "plasticity_status", { bodyLimit: 200 }); }
async function batch(client: Client, steps: unknown[]): Promise<any> { return await call(client, "plasticity_batch", { steps, revision: (await status(client)).revision }); }
async function undoTo(client: Client, depth: number): Promise<any> {
  for (let i = 0; i < 80; i++) {
    const current = await status(client);
    if (current.undoDepth <= depth) return current;
    await call(client, "plasticity_undo", { intent: "Return to the surfacing acceptance baseline", revision: current.revision });
  }
  throw new Error(`Undo did not reach ${depth}`);
}
const idsOf = (state: any) => new Set<number>((state.bodies as any[]).map((body) => body.id));
async function added(client: Client, before: Set<number>) { return ((await status(client)).bodies as any[]).filter((body) => !before.has(body.id)); }
async function info(client: Client, id: number) { return (await call(client, "plasticity_body_info", { id })).body; }
async function viewState(ctx: Ctx) { return await ctx.native.read<any>(VIEW_STATE); }
// A read-only call must leave the undo depth and the body count as they were.
async function unchanged<T>(ctx: Ctx, section: string, label: string, run: () => Promise<T>): Promise<T> {
  const before = await viewState(ctx);
  const value = await run();
  const after = await viewState(ctx);
  check(ctx, section, `${label}: no document change`, before.undoDepth === after.undoDepth && before.bodies === after.bodies, { before: [before.undoDepth, before.bodies], after: [after.undoDepth, after.bodies] });
  return value;
}
async function section(ctx: Ctx, name: Section, run: () => Promise<void>) {
  ctx.evidence[name] = { startedAt: new Date().toISOString() };
  const start = await status(ctx.client);
  const startCamera = (await viewState(ctx)).camera;
  try { await run(); } catch (error) { check(ctx, name, "section ran to the end", false, (error as Error).message.slice(0, 1500)); }
  finally {
    try { await ctx.native.mutate(CANCEL_ACTIVE, []); } catch (error) { ctx.evidence[name].cancelError = (error as Error).message; }
    try { await call(ctx.client, "plasticity_reconcile", {}); } catch { /* not uncertain */ }
    const end = await undoTo(ctx.client, start.undoDepth);
    check(ctx, name, "section undone to its start", end.undoDepth === start.undoDepth && JSON.stringify([...idsOf(end)].sort()) === JSON.stringify([...idsOf(start)].sort()), { start: start.undoDepth, end: end.undoDepth });
    // Localizes a camera change to the section that made it (the end-state check only says that one happened).
    const endCamera = (await viewState(ctx)).camera;
    check(ctx, name, "camera unchanged by the section", JSON.stringify(endCamera) === JSON.stringify(startCamera), { start: startCamera, end: endCamera });
  }
}

// ---------------------------------------------------------------- P1 ----------------------------------------------------------------
async function p1(ctx: Ctx) {
  const c = ctx.client;
  const before = idsOf(await status(c));
  await batch(c, [
    { toolName: "plasticity_create_sphere", arguments: { centerMm: [5000, 0, 0], radiusMm: 20, name: "sf-sphere" } },
    { toolName: "plasticity_create_cylinder", arguments: { centerMm: [5100, 0, 0], radiusMm: 10, heightMm: 40, name: "sf-cylinder" } },
    { toolName: "plasticity_create_box", arguments: { originMm: [5200, 0, 0], sizeMm: [40, 40, 5], name: "sf-tilted" } },
    { toolName: "plasticity_rotate", arguments: { ids: ["$2.added[0]"], pivotMm: [5200, 0, 0], axis: [0, 1, 0], degrees: -30 } },
    { toolName: "plasticity_create_control_point_curve", arguments: { pointsMm: [[5300, 0, 0], [5320, 0, 9], [5340, 0, 9], [5360, 0, 0]] } },
    { toolName: "plasticity_extrude_curves", arguments: { ids: ["$4.added[0]"], distanceMm: 30, direction: [0, 1, 0] } },
    { toolName: "plasticity_create_box", arguments: { originMm: [5400, 0, 0], sizeMm: [40, 40, 20], name: "sf-holed" } },
    { toolName: "plasticity_create_cylinder", arguments: { centerMm: [5420, 20, 0], radiusMm: 5, heightMm: 20 } },
    { toolName: "plasticity_boolean", arguments: { targetIds: ["$6.added[0]"], toolIds: ["$7.added[0]"], operation: "difference" } },
  ]);
  const bodies = await added(c, before);
  const byName = (name: string) => bodies.find((body) => body.name === name)!.id as number;
  const sheet = bodies.find((body) => body.type === "Sheet")!.id as number;
  const probe = async (id: number, args: Record<string, unknown>, label: string) => await unchanged(ctx, "p1", label, async () => await call(c, "plasticity_probe_surface", { id, ...args, revision: (await status(c)).revision }));
  const axisValues = (ray: any, axis: number) => ray.intersections.map((hit: any) => hit.pointMm[axis]);
  const worst = (values: number[], truth: number[]) => values.length !== truth.length ? Infinity : Math.max(0, ...truth.map((value, index) => Math.abs(value - values[index]!)));
  const results: Record<string, unknown> = {};
  // Sphere r20: two hits at +-sqrt(r^2 - d^2) along -z, normals radial.
  const offsets = [[0, 0], [5, 0], [10, 5], [15, 0], [19.9, 0], [0, -12.3456]];
  const sphere = await probe(byName("sf-sphere"), { rays: offsets.map(([dx, dy]) => ({ originMm: [5000 + dx!, dy!, 100], direction: [0, 0, -1] })) }, "sphere");
  const sphereErr = Math.max(...sphere.rays.map((ray: any, i: number) => { const d = Math.hypot(offsets[i]![0]!, offsets[i]![1]!); const h = Math.sqrt(400 - d * d); return worst(axisValues(ray, 2), [h, -h]); }));
  check(ctx, "p1", "sphere heights within 1e-6 mm", sphereErr <= tolerance, sphereErr);
  const normalErr = Math.max(...sphere.rays.flatMap((ray: any) => ray.intersections.map((hit: any) => Math.max(...[0, 1, 2].map((k) => Math.abs(hit.normal[k] - (hit.pointMm[k] - [5000, 0, 0][k]!) / 20))))));
  check(ctx, "p1", "sphere normals radial and outward", normalErr <= 1e-9, normalErr);
  results.sphere = { maxErrMm: sphereErr, rays: sphere.rays.map((ray: any) => axisValues(ray, 2)) };
  // Cylinder r10 about z at x=5100: crossing along -x at y=3 and y=-7.5.
  const cylinder = await probe(byName("sf-cylinder"), { rays: [{ originMm: [5150, 3, 20], direction: [-1, 0, 0] }, { originMm: [5150, -7.5, 33], direction: [-1, 0, 0] }, { originMm: [5105, 2, 100], direction: [0, 0, -1] }] }, "cylinder");
  const cylErr = Math.max(...[3, -7.5].map((y, i) => { const h = Math.sqrt(100 - y * y); return worst(axisValues(cylinder.rays[i], 0), [5100 + h, 5100 - h]); }), worst(axisValues(cylinder.rays[2], 2), [40, 0]));
  check(ctx, "p1", "cylinder crossings within 1e-6 mm", cylErr <= tolerance, cylErr);
  results.cylinder = { maxErrMm: cylErr };
  // A 5 mm plate rotated -30 degrees about y at x=5200: top z = 4.330127 + (x - 5197.5) tan30, bottom z = (x - 5200) tan30.
  const xs = [5210, 5220, 5230];
  const tilted = await probe(byName("sf-tilted"), { rays: xs.map((x) => ({ originMm: [x, 17, 100], direction: [0, 0, -1] })) }, "tilted plane");
  const t30 = Math.tan(Math.PI / 6);
  const tiltErr = Math.max(...xs.map((x, i) => worst(axisValues(tilted.rays[i], 2), [5 * Math.cos(Math.PI / 6) + (x - 5197.5) * t30, (x - 5200) * t30])));
  check(ctx, "p1", "30 degree plane heights within 1e-6 mm", tiltErr <= tolerance, tiltErr);
  results.tilted = { maxErrMm: tiltErr };
  // Cubic Bezier (control z 0, 9, 9, 0 over x 5300..5360, evenly spaced) extruded along y: z = 27 s (1 - s), s = (x - 5300) / 60.
  const bx = [5301, 5315, 5330, 5345, 5359.5];
  const bezier = await probe(sheet, { gridMm: { axis: "z", at: bx.map((x) => [x, 15]) } }, "Bezier sheet grid");
  const bezErr = Math.max(...bx.map((x, i) => { const s = (x - 5300) / 60; return worst(axisValues(bezier.rays[i], 2), [27 * s * (1 - s)]); }));
  check(ctx, "p1", "B-spline (Bezier) sheet heights within 1e-6 mm of the control-polygon formula", bezErr <= tolerance, bezErr);
  const apex = bezier.rays[2].intersections[0];
  check(ctx, "p1", "B-spline apex curvature 0.015/mm (|z''| = 54/3600)", Math.abs(Math.abs(apex.vCurvaturePerMm ?? apex.uCurvaturePerMm) - 0.015) <= 1e-9, apex);
  results.bezier = { maxErrMm: bezErr, heights: bezier.rays.map((ray: any) => axisValues(ray, 2)) };
  // A miss, and a ray straight down the hole.
  const miss = await probe(byName("sf-sphere"), { rays: [{ originMm: [5050, 50, 100], direction: [0, 0, -1] }] }, "miss");
  check(ctx, "p1", "a miss returns hits 0", miss.rays[0].hits === 0 && miss.rays[0].intersections.length === 0);
  const holed = await probe(byName("sf-holed"), { rays: [{ originMm: [5500, 20, 10], direction: [-1, 0, 0] }, { originMm: [5420, 60, 7], direction: [0, -1, 0] }, { originMm: [5420, 20, 100], direction: [0, 0, -1] }] }, "holed block");
  const holeErr = Math.max(worst(axisValues(holed.rays[0], 0), [5440, 5425, 5415, 5400]), worst(axisValues(holed.rays[1], 1), [40, 25, 15, 0]));
  check(ctx, "p1", "a ray through the hole: four hits (two per wall) within 1e-6 mm", holed.rays[0].hits === 4 && holed.rays[1].hits === 4 && holeErr <= tolerance, { hits: [holed.rays[0].hits, holed.rays[1].hits], holeErr });
  check(ctx, "p1", "a ray down the hole axis misses", holed.rays[2].hits === 0);
  const holeNormals = holed.rays[0].intersections.map((hit: any) => hit.normal[0]);
  check(ctx, "p1", "hole wall normals point out of the solid (into the hole)", JSON.stringify(holeNormals) === JSON.stringify([1, -1, 1, -1]), holeNormals);
  // The benchmark grip pad (S2 reference) at x=5600: its crown is a B-spline patch; boundsMm is a control hull.
  const { s2Reference, S2 } = await import("../discovery/bench-2026-11/reference.ts");
  const beforePad = idsOf(await status(c));
  await batch(c, s2Reference({ ...S2, x0: 5600 }).steps);
  const pad = (await added(c, beforePad)).find((body) => body.name === "grip-pad")!;
  const padProbe = await probe(pad.id, { gridMm: { at: [[5645, 25], [5620, 20], [5700, 25]] } }, "grip pad grid");
  const top = padProbe.rays[0].intersections[0];
  check(ctx, "p1", "grip pad: crown height read exactly (residual <= 1e-6 mm) and below the control-hull max", top && top.residualMm <= tolerance && top.pointMm[2] < pad.boundsMm.max[2] - 0.1, { top: top?.pointMm, residualMm: top?.residualMm, boundsMaxZ: pad.boundsMm.max[2] });
  check(ctx, "p1", "grip pad: a ray past the pad misses", padProbe.rays[2].hits === 0);
  results.pad = { centreTopMm: top?.pointMm, boundsMaxZ: pad.boundsMm.max[2], rays: padProbe.rays.map((ray: any) => axisValues(ray, 2)) };
  // Round 3 (review D1): crossings beyond the display-mesh silhouette, and random rays with closed-form counts.
  const beforeR3 = idsOf(await status(c));
  await batch(c, [
    { toolName: "plasticity_create_torus", arguments: { centerMm: [6300, 0, 0], majorRadiusMm: 20, minorRadiusMm: 5, name: "sf-torus" } },
    { toolName: "plasticity_create_cone", arguments: { bottomCenterMm: [6200, 0, 0], bottomRadiusMm: 15, topRadiusMm: 5, heightMm: 30, name: "sf-cone" } },
    { toolName: "plasticity_create_sphere", arguments: { centerMm: [15000, 0, 0], radiusMm: 1500, name: "sf-big" } },
    { toolName: "plasticity_create_box", arguments: { originMm: [6500, 0, 0], sizeMm: [20, 20, 20], name: "sf-filleted-r3" } },
    { toolName: "plasticity_find_edges", arguments: { query: { bodyIds: ["$3.added[0]"], line: true, direction: { vector: [0, 0, 1] } }, limit: 10 } },
    { toolName: "plasticity_fillet", arguments: { id: "$3.added[0]", edgeIds: "$4.result.matches[*].id", radiusMm: 3 } },
  ]);
  const r3 = await added(c, beforeR3);
  const r3id = (name: string) => r3.find((body) => body.name === name)!.id as number;
  const reviewer = async (label: string, id: number, rays: Array<{ originMm: number[]; direction: number[] }>, axis: number, truth: number[][]) => {
    const result = await probe(id, { rays }, label);
    const worstErr = Math.max(...result.rays.map((ray: any, i: number) => worst(axisValues(ray, axis), truth[i]!)));
    check(ctx, "p1", `${label}: every crossing beyond the display-mesh silhouette, within 1e-6 mm, no flags`, worstErr <= tolerance && result.rays.every((ray: any) => !ray.unresolvedCrossings && !ray.grazing), { worstErr, hits: result.rays.map((ray: any) => ray.hits) });
  };
  const sq = (x: number) => Math.sqrt(x);
  await reviewer("sphere r20 at 19.96, 19.99, 19.999, 19.9999 mm", byName("sf-sphere"), [19.96, 19.99, 19.999, 19.9999].map((x) => ({ originMm: [5000 + x, 0, 100], direction: [0, 0, -1] })), 2, [19.96, 19.99, 19.999, 19.9999].map((x) => [sq(400 - x * x), -sq(400 - x * x)]));
  await reviewer("sphere r1500 at 1498 mm (155 mm chord)", r3id("sf-big"), [{ originMm: [16498, 0, 3000], direction: [0, 0, -1] }], 2, [[sq(1500 ** 2 - 1498 ** 2), -sq(1500 ** 2 - 1498 ** 2)]]);
  const torusX = (y: number, z: number) => { const a = sq(25 - z * z); return [20 + a, 20 - a].flatMap((rho) => (rho * rho >= y * y ? [sq(rho * rho - y * y)] : [])).flatMap((x) => [6300 + x, 6300 - x]).sort((p, q) => q - p); };
  await reviewer("torus R20 r5 along -x at z 4.99 and at y 14.99", r3id("sf-torus"), [{ originMm: [6400, 0, 4.99], direction: [-1, 0, 0] }, { originMm: [6400, 14.99, 0], direction: [-1, 0, 0] }], 0, [torusX(0, 4.99), torusX(14.99, 0)]);
  await reviewer("cylinder r10, oblique ray at 9.99 mm", byName("sf-cylinder"), [{ originMm: [5080, 9.99, 0.5], direction: [1, 0, 1] }], 0, [[5100 - sq(100 - 9.99 ** 2), 5100 + sq(100 - 9.99 ** 2)]]);
  await reviewer("cone at 9.99 mm (radius 10 at z 15)", r3id("sf-cone"), [{ originMm: [6250, 9.99, 15], direction: [-1, 0, 0] }], 0, [[6200 + sq(100 - 9.99 ** 2), 6200 - sq(100 - 9.99 ** 2)]]);
  const tangent = await probe(byName("sf-sphere"), { rays: [{ originMm: [5020, 0, 100], direction: [0, 0, -1] }] }, "tangent sphere ray");
  check(ctx, "p1", "an exactly tangent ray is a grazing entry, not a crossing", tangent.rays[0].hits === 0 && tangent.rays[0].grazing?.length === 1, tangent.rays[0]);
  // 4,096 random rays per body: zero unflagged odd counts; closed-form counts on the analytic bodies.
  let seed = 20261117;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  // Torus at (6300,0,0), z axis: the exact number of real roots of its quartic for t > 0 (Sturm sequence).
  const pmulN = (a: number[], b: number[]) => { const r = new Array(a.length + b.length - 1).fill(0); a.forEach((x, i) => b.forEach((y, j) => { r[i + j] += x * y; })); return r; };
  const paddN = (a: number[], b: number[]) => Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] ?? 0) + (b[i] ?? 0));
  const degN = (q: number[]) => { let n = q.length - 1; while (n > 0 && Math.abs(q[n]!) < 1e-300) n -= 1; return n; };
  const pvN = (q: number[], t: number) => q.reduceRight((acc, x) => acc * t + x, 0);
  const remN = (a: number[], b: number[]) => { let r = [...a]; const db = degN(b); while (degN(r) >= db && degN(r) > 0) { const dr = degN(r), k = r[dr]! / b[db]!; for (let i = 0; i <= db; i += 1) r[dr - db + i]! -= k * b[i]!; r = r.slice(0, dr); } return r; };
  const sturmCount = (q: number[], a: number, b: number) => { const seq = [q, q.slice(1).map((x, i) => x * (i + 1))]; while (degN(seq.at(-1)!) > 0) { const r = remN(seq.at(-2)!, seq.at(-1)!).map((x) => -x); if (r.every((x) => Math.abs(x) < 1e-30)) break; seq.push(r); } const changes = (t: number) => { let n = 0, prev = 0; for (const p of seq) { const v = pvN(p, t); if (v === 0) continue; if (prev && Math.sign(v) !== prev) n += 1; prev = Math.sign(v); } return n; }; return changes(a) - changes(b); };
  const quarticCount = (o: number[], d: number[]) => {
    const w = [o[0]! - 6300, o[1]!, o[2]!];
    const q = [w[0]! ** 2 + w[1]! ** 2 + w[2]! ** 2, 2 * (w[0]! * d[0]! + w[1]! * d[1]! + w[2]! * d[2]!), 1], H = [w[2]!, d[2]!];
    const G = paddN(q, [400 - 25]);
    return sturmCount(paddN(pmulN(G, G), paddN(q, pmulN(H, H).map((x) => -x)).map((x) => -1600 * x)), 0, 1e5);
  };
  const counts: Record<string, (o: number[], d: number[]) => number | null> = {
    "sf-torus": quarticCount,
    "sf-sphere": (o, d) => { const w = [o[0]! - 5000, o[1]!, o[2]!], b = w[0]! * d[0]! + w[1]! * d[1]! + w[2]! * d[2]!, disc = b * b - (w[0]! ** 2 + w[1]! ** 2 + w[2]! ** 2 - 400); return disc > 0 ? 2 : 0; },
    "sf-filleted-r3": (o, d) => { const tz = [(0 - o[2]!) / d[2]!, (20 - o[2]!) / d[2]!].sort((p, q) => p - q); const dist = (t: number) => Math.hypot(Math.max(0, Math.abs(o[0]! + t * d[0]! - 6510) - 7), Math.max(0, Math.abs(o[1]! + t * d[1]! - 10) - 7)); let a = Math.max(0, tz[0]!), b = tz[1]!; if (!(b > a)) return 0; for (let i = 0; i < 200; i += 1) { const m1 = a + (b - a) / 3, m2 = b - (b - a) / 3; if (dist(m1) < dist(m2)) b = m2; else a = m1; } return dist((a + b) / 2) < 3 ? 2 : 0; },
    "grip-pad": () => null,
  };
  const randomStats: Record<string, unknown> = {};
  for (const [name, expectedCount] of Object.entries(counts)) {
    const body = ((await status(c)).bodies as any[]).find((entry) => entry.name === name)!;
    const { min, max } = body.boundsMm;
    const span = Math.hypot(...[0, 1, 2].map((i) => max[i] - min[i])) + 10;
    let oddUnflagged = 0, mismatch = 0, flagged = 0, worstResidual = 0, ms = 0;
    for (let k = 0; k < 64; k += 1) {
      const rays = Array.from({ length: 64 }, () => { const target = [0, 1, 2].map((i) => min[i] + (max[i] - min[i]) * rnd()); let dir = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1]; const n = Math.hypot(...dir); dir = dir.map((x) => x / n); return { originMm: target.map((v, i) => v - dir[i]! * span), direction: dir }; });
      const started = Date.now();
      const result = await call(c, "plasticity_probe_surface", { id: body.id, rays, revision: (await status(c)).revision });
      ms += Date.now() - started;
      result.rays.forEach((ray: any, i: number) => {
        for (const hit of ray.intersections) worstResidual = Math.max(worstResidual, hit.residualMm);
        if (ray.unresolvedCrossings || ray.grazing) flagged += 1;
        if (ray.hits % 2 === 1 && !ray.unresolvedCrossings) oddUnflagged += 1;
        const want = expectedCount(rays[i]!.originMm, rays[i]!.direction);
        if (want !== null && want !== ray.hits && !ray.grazing) mismatch += 1;
      });
    }
    randomStats[name] = { rays: 4096, oddUnflagged, mismatch, flagged, worstResidualMm: worstResidual, msPer64Rays: Math.round(ms / 64) };
    check(ctx, "p1", `${name}: 4,096 random rays, zero unflagged odd counts${name === "grip-pad" ? "" : ", every count equal to the closed-form count"}`, oddUnflagged === 0 && mismatch === 0, randomStats[name]);
  }
  results.random = randomStats;
  // ---- Final review (P1-P4): the reviewer's rays, the sheet against its closed form, parity from inside the bounds box ----
  const final: Record<string, unknown> = {};
  const flaggedRay = (ray: any) => Boolean(ray.unresolvedCrossings) || Boolean(ray.grazing);
  // P1: the sheet is z = 27 u (1 - u), u = (x - 5300) / 60, x in [5300, 5360], y in [0, 30].
  const pairRay = await probe(sheet, { rays: [{ originMm: [5270.77, 7.3, 6.749], direction: [0.955336, 0.29552, 0] }] }, "P1 sheet close pair");
  final.pair = { hits: pairRay.rays[0].hits, distances: pairRay.rays[0].intersections.map((hit: any) => hit.distanceMm), grazing: pairRay.rays[0].grazing };
  check(ctx, "p1", "P1: the reviewer's sheet ray returns both crossings of the close pair (61.617 and 62.381 mm)", pairRay.rays[0].hits === 2 && Math.abs(pairRay.rays[0].intersections[0].distanceMm - 61.617) < 1e-3 && Math.abs(pairRay.rays[0].intersections[1].distanceMm - 62.381) < 1e-3, final.pair);
  let mseed = 0x1234567;
  const mrnd = () => { mseed |= 0; mseed = (mseed + 0x6d2b79f5) | 0; let t = Math.imul(mseed ^ (mseed >>> 15), 1 | mseed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  type P = [number, number, number];
  const vsub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], vadd = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], vmul = (a: P, k: number): P => [a[0] * k, a[1] * k, a[2] * k];
  const vdot = (a: P, b: P) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], vunit = (a: P): P => vmul(a, 1 / Math.hypot(...a));
  const vcross = (a: P, b: P): P => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const rdir = (): P => { for (;;) { const v: P = [2 * mrnd() - 1, 2 * mrnd() - 1, 2 * mrnd() - 1]; const n = Math.hypot(...v); if (n > 0.05 && n <= 1) return vmul(v, 1 / n); } };
  const surf = (x: number) => { const u = (x - 5300) / 60; return 27 * u * (1 - u); };
  // Closed-form crossings; ambiguous within 5e-5 mm of the sheet boundary, at t = 0, at tangency (1e-7 mm) and for pairs under 0.002 mm.
  const sheetTruth = (o: P, d: P, eps = 0) => {
    const centre: P = [5330, 15, 3], t0 = vdot(vsub(centre, o), d), q: P = vadd(o, vmul(d, t0));
    const u0 = (q[0] - 5300) / 60, du = d[0] / 60, A = 27 * du * du, B = d[2] - 27 * du * (1 - 2 * u0), C = q[2] - 27 * u0 * (1 - u0);
    let roots: number[] = [], amb = false;
    if (Math.abs(A) < 1e-14) { if (Math.abs(B) > 1e-12) roots = [-C / B]; else if (Math.abs(C) < 1e-6) amb = true; }
    else { const disc = B * B - 4 * A * C; if (Math.abs(C - B * B / (4 * A)) < 1e-7) amb = true; if (disc > 0) { const k = -0.5 * (B + Math.sign(B || 1) * Math.sqrt(disc)); roots = [k / A, C / k].sort((x, y) => x - y); if (roots[1]! - roots[0]! < 2e-3) amb = true; } }
    const ts: number[] = [];
    for (const r of roots) { const t = t0 + r, x = o[0] + t * d[0], y = o[1] + t * d[1], mx = Math.min(x - 5300, 5360 - x), my = Math.min(y, 30 - y);
      if (Math.abs(mx) < 5e-5 || Math.abs(my) < 5e-5) amb = true; if (mx < -eps || my < -eps) continue; if (Math.abs(t) < 1e-6) amb = true; if (t > 0) ts.push(t); }
    return { ts, amb };
  };
  const centre: P = [5330, 15, 3.4], radius = 34, L = radius * 2.5;
  const family = (): { o: P; d: P } => {
    const u = mrnd();
    if (u < 0.3) { const o = vadd(centre, vmul(rdir(), L)); return { o, d: vunit(vsub(vadd(centre, vmul(rdir(), radius * Math.cbrt(mrnd()))), o)) }; }
    if (u < 0.4) { const k = Math.floor(mrnd() * 3), sgn = mrnd() < 0.5 ? 1 : -1, d: P = [0, 0, 0]; d[k] = -sgn; const o: P = [5300 + 60 * (mrnd() * 1.1 - 0.05), 30 * (mrnd() * 1.1 - 0.05), 9 * (mrnd() * 1.2 - 0.1)]; o[k] = centre[k]! + sgn * L; return { o, d }; }
    if (u < 0.75) { const x = 5300 + 60 * mrnd(), y = 30 * mrnd(), slope = 27 * (1 - 2 * (x - 5300) / 60) / 60, n = vunit([-slope, 0, 1]), a = mrnd() * 2 * Math.PI;
      const tau = vunit(vadd(vmul(vunit([1, 0, slope]), Math.cos(a)), vmul([0, 1, 0], Math.sin(a)))), delta = (mrnd() < 0.5 ? 1 : -1) * 10 ** (-7 + 6.5 * mrnd());
      return { o: vsub(vadd([x, y, surf(x)], vmul(n, delta)), vmul(tau, L)), d: tau }; }
    if (u < 0.88) { const onX = mrnd() < 0.5, x = onX ? (mrnd() < 0.5 ? 5300 : 5360) : 5300 + 60 * mrnd(), y = onX ? 30 * mrnd() : (mrnd() < 0.5 ? 0 : 30), d = rdir(), off = mrnd() < 0.3 ? 0 : 10 ** (-8 + 7 * mrnd());
      return { o: vsub(vadd([x, y, surf(x)], vmul(vunit(vcross(d, rdir())), off)), vmul(d, L)), d }; }
    if (u < 0.95) return { o: vadd(centre, vmul(rdir(), radius * 0.6 * Math.cbrt(mrnd()))), d: rdir() };
    const dir = rdir(); return { o: vadd(vadd(centre, vmul(rdir(), radius * 0.8 * Math.cbrt(mrnd()))), vmul(dir, 10 ** (2 + 3 * mrnd()))), d: vmul(dir, -1) };
  };
  const sweep = { rays: 0, compared: 0, match: 0, wrongFlagged: 0, wrongUnflagged: 0, examples: [] as unknown[] };
  for (let k = 0; k < 64; k += 1) {
    const rays = Array.from({ length: 64 }, family);
    const result = await call(c, "plasticity_probe_surface", { id: sheet, rays: rays.map((ray) => ({ originMm: ray.o, direction: ray.d })), revision: (await status(c)).revision });
    result.rays.forEach((ray: any, i: number) => {
      sweep.rays += 1;
      const t = sheetTruth(rays[i]!.o, rays[i]!.d);
      if (t.amb || sheetTruth(rays[i]!.o, rays[i]!.d, 3e-5).ts.length !== t.ts.length || sheetTruth(rays[i]!.o, rays[i]!.d, -3e-5).ts.length !== t.ts.length) return;
      sweep.compared += 1;
      if (t.ts.length === ray.hits) sweep.match += 1; else if (flaggedRay(ray)) sweep.wrongFlagged += 1; else { sweep.wrongUnflagged += 1; if (sweep.examples.length < 5) sweep.examples.push({ ray: rays[i], truth: t.ts, got: ray.intersections.map((hit: any) => hit.distanceMm) }); }
    });
  }
  final.sheetSweep = sweep;
  check(ctx, "p1", "P1: sheet, 4,096 rays of the review's families against the closed form: zero unflagged wrong counts", sweep.wrongUnflagged === 0 && sweep.compared > 3000, sweep);
  // P1 parity: the pad's crown at (5645, 25); origins inside the bounds box but outside the body, above the crown surface.
  const crown = top.pointMm[2] as number;
  const padRays = await probe(pad.id, { rays: [{ originMm: [5601, 12, crown - 0.01], direction: [Math.cos(0.3), Math.sin(0.3), 0] }, { originMm: [5603, 12, crown - 0.001], direction: [Math.cos(0.3), Math.sin(0.3), 0] }] }, "P1 pad chords from inside the bounds box");
  final.padChords = padRays.rays.map((ray: any) => ({ hits: ray.hits, distances: ray.intersections.map((hit: any) => hit.distanceMm), code: ray.unresolvedCode, grazing: Boolean(ray.grazing) }));
  check(ctx, "p1", "P1: the reviewer's two pad chords (origin inside the bounds box, outside the body) return two hits or a flag", padRays.rays.every((ray: any) => ray.hits === 2 || flaggedRay(ray)), final.padChords);
  const inBox = { rays: 0, oddUnflagged: 0, oddFlagged: 0, flagged: 0 };
  const padBox = pad.boundsMm;
  while (inBox.rays < 1024) {
    const xy = Array.from({ length: 64 }, () => [padBox.min[0] + (padBox.max[0] - padBox.min[0]) * mrnd(), padBox.min[1] + (padBox.max[1] - padBox.min[1]) * mrnd()]);
    const heights = await call(c, "plasticity_probe_surface", { id: pad.id, gridMm: { at: xy }, revision: (await status(c)).revision });
    const rays = heights.rays.flatMap((ray: any, i: number) => {
      if (flaggedRay(ray)) return [];
      const low = Math.max((ray.hits === 0 ? padBox.min[2] - 1 : Math.max(...ray.intersections.map((hit: any) => hit.pointMm[2]))) + 0.05, padBox.min[2] + 0.001), high = padBox.max[2] - 0.001;
      return high > low ? [{ originMm: [xy[i]![0], xy[i]![1], low + (high - low) * mrnd()], direction: rdir() }] : [];
    });
    if (rays.length === 0) continue;
    const result = await call(c, "plasticity_probe_surface", { id: pad.id, rays, revision: (await status(c)).revision });
    for (const ray of result.rays) { inBox.rays += 1; if (flaggedRay(ray)) inBox.flagged += 1; if (ray.hits % 2 === 1) { if (flaggedRay(ray)) inBox.oddFlagged += 1; else inBox.oddUnflagged += 1; } }
  }
  final.padInsideBox = inBox;
  check(ctx, "p1", "P1: grip pad, 1,024 rays from inside the bounds box but outside the body: zero unflagged odd counts", inBox.oddUnflagged === 0, inBox);
  // P2: the torus (centre x = 6300) from 3,300 mm away.
  const farTorus = await probe(r3id("sf-torus"), { rays: [{ originMm: [9600, 0, 0], direction: [-1, 0, 0] }] }, "P2 torus from 3,300 mm");
  final.farTorus = farTorus.rays[0].intersections.map((hit: any) => hit.distanceMm);
  check(ctx, "p1", "P2: a torus probed from 3,300 mm away returns its four crossings (3275, 3285, 3315, 3325 mm, 1e-6)", worst(final.farTorus as number[], [3275, 3285, 3315, 3325]) <= tolerance && !flaggedRay(farTorus.rays[0]), final.farTorus);
  // P3: a box with all 12 edges filleted G2; the two rays that made the whole call throw.
  const beforeG2 = idsOf(await status(c));
  await batch(c, [
    { toolName: "plasticity_create_box", arguments: { originMm: [6600, 0, 0], sizeMm: [20, 20, 20], name: "sf-g2box" } },
    { toolName: "plasticity_find_edges", arguments: { query: { bodyIds: ["$0.added[0]"], line: true }, limit: 20 } },
    { toolName: "plasticity_fillet", arguments: { id: "$0.added[0]", edgeIds: "$1.result.matches[*].id", radiusMm: 3, shape: "g2" } },
  ]);
  const g2 = (await added(c, beforeG2)).find((body) => body.name === "sf-g2box")!;
  const g2Rays = [
    { originMm: [6654.051320346781, 19.59165853475149, 0.5950813275441331], direction: [-0.9994736189433314, 0.007211406105751431, 0.03163037556366067] },
    { originMm: [6644.901085281925, 19.809927035136237, 50.85746207249972], direction: [-0.6534572620412744, 0.004263707473651682, -0.7569514036476189] },
    { originMm: [6610, 10, 100], direction: [0, 0, -1] },
  ];
  const g2Probe = await tryCall(c, "plasticity_probe_surface", { id: g2.id, rays: g2Rays, revision: (await status(c)).revision });
  final.g2 = g2Probe.ok ? g2Probe.value.rays.map((ray: any) => ({ hits: ray.hits, code: ray.unresolvedCode, grazing: ray.grazing?.length })) : g2Probe.error;
  check(ctx, "p1", "P3: the two rays that threw on the G2-filleted box return (hits or flags), and a plain ray in the same call returns its two hits", g2Probe.ok && g2Probe.value.rays.length === 3 && g2Probe.value.rays[2].hits === 2 && !flaggedRay(g2Probe.value.rays[2]), final.g2);
  // P4: a ray just above a planar face, in it, and along a cylinder's ruling: grazing.
  const p4rays = await probe(byName("sf-cylinder"), { rays: [{ originMm: [5150, 3, 40.0005], direction: [-1, 0, 0] }, { originMm: [5150, 3, 40], direction: [-1, 0, 0] }, { originMm: [5110, 0, 100], direction: [0, 0, -1] }, { originMm: [5150, 3, 40.002], direction: [-1, 0, 0] }] }, "P4 coplanar and ruling rays");
  final.grazing = p4rays.rays.map((ray: any) => ({ hits: ray.hits, grazing: ray.grazing?.map((entry: any) => [entry.faceId, entry.minDistanceMm]) }));
  check(ctx, "p1", "P4: a ray 0.0005 mm above a planar face, a ray in it and a ray along a cylinder's ruling carry grazing; 0.002 mm above is clean", p4rays.rays.slice(0, 3).every((ray: any) => Boolean(ray.grazing)) && !flaggedRay(p4rays.rays[3]) && p4rays.rays[3].hits === 0, final.grazing);
  // unresolvedCode: a rim touched from outside is a parity flag with the stable code.
  const rim = await probe(byName("sf-cylinder"), { rays: [{ originMm: [5140, 0, 10], direction: [-1, 0, 1] }] }, "rim touch");
  final.rimTouch = { hits: rim.rays[0].hits, code: rim.rays[0].unresolvedCode, codes: rim.rays[0].unresolvedCodes, reason: rim.rays[0].unresolvedReason };
  check(ctx, "p1", "a rim touched from outside is flagged with unresolvedCode parity", rim.rays[0].unresolvedCode === "parity" && JSON.stringify(rim.rays[0].unresolvedCodes) === JSON.stringify(["parity"]), final.rimTouch);
  results.finalReview = final;
  ctx.evidence.p1.results = results;
}

// ---------------------------------------------------------------- P2 ----------------------------------------------------------------
async function p2(ctx: Ctx) {
  const c = ctx.client;
  const before = idsOf(await status(c));
  await batch(c, [
    { toolName: "plasticity_create_box", arguments: { originMm: [5000, 0, 0], sizeMm: [30, 20, 10], name: "sf-box" } },
    { toolName: "plasticity_create_box", arguments: { originMm: [5100, 0, 0], sizeMm: [20, 20, 20], name: "sf-filleted" } },
    { toolName: "plasticity_find_edges", arguments: { query: { bodyIds: ["$1.added[0]"], line: true, direction: { vector: [0, 0, 1] } }, limit: 10 } },
    { toolName: "plasticity_fillet", arguments: { id: "$1.added[0]", edgeIds: "$2.result.matches[*].id", radiusMm: 3 } },
    { toolName: "plasticity_create_control_point_curve", arguments: { pointsMm: [[5200, 0, 0], [5215, 0, 9], [5230, 0, 9], [5245, 0, 0]] } },
    { toolName: "plasticity_create_control_point_curve", arguments: { pointsMm: [[5200, 30, 0], [5215, 30, 4], [5230, 30, 4], [5245, 30, 0]] } },
    { toolName: "plasticity_loft_curves", arguments: { profileIds: ["$4.added[0]", "$5.added[0]"] } },
  ]);
  const { s2Reference, S2 } = await import("../discovery/bench-2026-11/reference.ts");
  await batch(c, s2Reference({ ...S2, x0: 5600 }).steps);
  const bodies = await added(c, before);
  const fixtures = {
    box: bodies.find((body) => body.name === "sf-box"),
    filleted: bodies.find((body) => body.name === "sf-filleted"),
    loft: bodies.find((body) => body.type === "Sheet"),
    pad: bodies.find((body) => body.name === "grip-pad"),
  };
  const ids = Object.values(fixtures).map((body) => body!.id as number);
  ctx.evidence.p2.boundsMethod = Object.fromEntries(Object.entries(fixtures).map(([name, body]) => [name, { id: body!.id, type: body!.type, boundsMethod: body!.boundsMethod, boundsMm: body!.boundsMm }]));
  check(ctx, "p2", "boundsMethod on 26.1.3 is native-box for the box, filleted box, lofted sheet and pad", Object.values(fixtures).every((body) => body!.boundsMethod === "native-box"), ctx.evidence.p2.boundsMethod);
  const exact = await unchanged(ctx, "p2", "exact_bounds", async () => await call(c, "plasticity_exact_bounds", { ids, revision: (await status(c)).revision }));
  ctx.evidence.p2.exactBounds = exact.bodies;
  const [box, filleted, loft, pad] = exact.bodies;
  const near = (a: number[], b: number[], tol = 1e-3) => a.every((value, i) => Math.abs(value - b[i]!) <= tol);
  check(ctx, "p2", "box and filleted box: exact extents equal their kernel box", near(box.boundsMm.min, [5000, 0, 0]) && near(box.boundsMm.max, [5030, 20, 10]) && near(filleted.boundsMm.max, [5120, 20, 20]) && box.exact && filleted.exact, { box: box.boundsMm, filleted: filleted.boundsMm });
  check(ctx, "p2", "lofted sheet: exact top 6.75 mm (control hull 9 mm), consistent at both radii", Math.abs(loft.boundsMm.max[2] - 6.75) <= 1e-3 && loft.exact && loft.overshootMm > 2, loft);
  check(ctx, "p2", "grip pad: exact extent inside the control hull, exact", pad.exact && pad.overshootMm > 0.4 && pad.boundsMm.max[2] < 14.1, pad);
  // Cross-check the pad's top with an exact probe ray at the support point's x, y.
  const support = await ctx.native.readNative<any>(nativeFunction`function (pk_default, args) {
    const kernel = pk_default.a; const evaluator = new kernel.Eval(kernel.Context.Get());
    let model = null; for (const [versionId, item] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(versionId) === args.id) model = item.model;
    const box = model.FindBox(); const c = [(box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2];
    const r = evaluator.DistancesToPoints(Int32Array.of(Number(model.Id())), Float64Array.of(c[0], c[1], c[2] + 1e5), Int32Array.of(0, 1));
    return Array.from(r.nearests).map(v => v * 1000);
  }`, ["pk_default"], [{ id: fixtures.pad!.id }]);
  const ray = await call(c, "plasticity_probe_surface", { id: fixtures.pad!.id, gridMm: { at: [[support[0], support[1]]] }, revision: (await status(c)).revision });
  const probeTop = ray.rays[0].intersections[0]?.pointMm[2];
  check(ctx, "p2", "pad support top agrees with an exact probe ray at its x, y within 1e-6 mm", Math.abs(probeTop - pad.boundsMm.max[2]) <= 1e-6 + 5e-7, { supportTop: pad.boundsMm.max[2], probeTop });
  const described = await call(c, "plasticity_describe_body", { ids });
  const flags = described.bodies.map((body: any) => body.boundsExact);
  ctx.evidence.p2.describe = described.bodies.map((body: any) => ({ id: body.id, boundsExact: body.boundsExact, boundsNote: body.boundsNote }));
  check(ctx, "p2", "describe_body boundsExact: box true, filleted true, lofted sheet false, pad false (with a note)", JSON.stringify(flags) === JSON.stringify([true, true, false, false]) && described.bodies.slice(2).every((body: any) => /control hull/.test(body.boundsNote ?? "")), ctx.evidence.p2.describe);
}

// ---------------------------------------------------------------- P3 ----------------------------------------------------------------
async function p3(ctx: Ctx) {
  const c = ctx.client;
  // Error 30: g1 on the edge loop of a Solid face whose walls stand perpendicular to the patch (the grip pad's top).
  await batch(c, [
    { toolName: "plasticity_create_box", arguments: { originMm: [6000, 0, 0], sizeMm: [90, 50, 8], name: "sf-pad30" } },
    { toolName: "plasticity_fillet", arguments: { id: "$0.added[0]", radiusMm: 12, edgeQuery: { line: true, direction: { vector: [0, 0, 1] } } } },
  ]);
  let st = await status(c);
  const pad = (st.bodies as any[]).find((body) => body.name === "sf-pad30");
  const top = await call(c, "plasticity_find_faces", { query: { bodyIds: [pad.id], planar: true, normal: { vector: [0, 0, 1] } }, revision: st.revision });
  const before = await viewState(ctx);
  const failed = await tryCall(c, "plasticity_xsided_patch", { edges: { bodyId: pad.id, edgeIds: top.matches[0].edgeIds }, continuity: "g1", intent: "error 30 reproduction", revision: st.revision });
  const after = await viewState(ctx);
  ctx.evidence.p3.error30 = failed;
  check(ctx, "p3", "error 30 reproduced: raw code kept and its meaning added", !failed.ok && /error `30`/.test(failed.error) && /incompatible at a corner or with the neighbouring faces/.test(failed.error) && /blend the rim first/.test(failed.error), failed);
  check(ctx, "p3", "error 30: nothing created, no Undo step", before.undoDepth === after.undoDepth && before.bodies === after.bodies, { before: [before.undoDepth, before.bodies], after: [after.undoDepth, after.bodies] });
  // Options on the benchmark's three-sheet hole (S3): centre height of the patch per variant.
  const { s3Reference, S3 } = await import("../discovery/bench-2026-11/reference.ts");
  const reference = s3Reference({ ...S3, cx: 6400 });
  const steps = reference.steps.slice(0, reference.steps.findIndex((step: any) => step.toolName === "plasticity_xsided_patch"));
  await batch(c, steps);
  st = await status(c);
  const joined = (st.bodies as any[]).filter((body) => body.type === "Sheet").sort((a, b) => b.id - a.id)[0];
  const rim: string[] = [];
  for (const step of steps.filter((entry: any) => entry.toolName === "plasticity_find_edges") as any[]) {
    const found = await call(c, "plasticity_find_edges", { ...step.arguments, query: { ...step.arguments.query, bodyIds: [joined.id] }, revision: st.revision });
    rim.push(found.matches[0].id);
  }
  // edgeContinuity, tension and quality through the tool (plasticity_xsided_patch's schema takes them).
  const height = async (args: Record<string, unknown>) => {
    const start = await status(c);
    const beforeIds = idsOf(start);
    await call(c, "plasticity_xsided_patch", { edges: { bodyId: joined.id, edgeIds: rim }, ...args, intent: "option measurement", revision: start.revision });
    const patch = (await added(c, beforeIds))[0];
    const probe = await call(c, "plasticity_probe_surface", { id: patch.id, gridMm: { at: [[6400, 30]] }, revision: (await status(c)).revision });
    await undoTo(c, start.undoDepth);
    return probe.rays[0].intersections[0].pointMm[2] as number;
  };
  const h = {
    g1: await height({ continuity: "g1" }),
    g0: await height({ continuity: "g0" }),
    g0OneEdgeG1: await height({ continuity: "g0", edgeContinuity: [{ edgeId: rim[0], continuity: "g1" }] }),
    g1Tension01: await height({ continuity: "g1", tension: 0.1 }),
    g1Tension10: await height({ continuity: "g1", tension: 1 }),
    g2Auto: await height({ continuity: "g2" }),
    g2High: await height({ continuity: "g2", quality: "high" }),
    g2Max: await height({ continuity: "g2", quality: "max" }),
    g0Tension01: await height({ continuity: "g0", tension: 0.1 }),
    g0Tension10: await height({ continuity: "g0", tension: 1 }),
  };
  ctx.evidence.p3.centreHeightsMm = h;
  check(ctx, "p3", "edgeContinuity changes the patch (one edge g1 differs from all g0 and all g1 by > 0.01 mm)", Math.abs(h.g0OneEdgeG1 - h.g0) > 0.01 && Math.abs(h.g0OneEdgeG1 - h.g1) > 0.01, h);
  check(ctx, "p3", "tension changes the patch (0.1 vs 1.0 differ by > 0.1 mm)", Math.abs(h.g1Tension01 - h.g1Tension10) > 0.1, h);
  check(ctx, "p3", "quality changes the patch (g2 high vs auto differ by > 0.01 mm)", Math.abs(h.g2High - h.g2Auto) > 0.01, h);
  check(ctx, "p3", "tension has no effect at g0 (0.1 and 1.0 within 1e-6 mm), as the description says", Math.abs(h.g0Tension01 - h.g0Tension10) < 1e-6 && Math.abs(h.g0Tension01 - h.g0) < 1e-6, h);
}

// ---------------------------------------------------------------- P4 ----------------------------------------------------------------
const SHADERS = ["isophotes", "draft", "faceDirection", "zebraVertical", "zebraHorizontal", "topo"] as const;
async function p4(ctx: Ctx) {
  const c = ctx.client;
  const before = idsOf(await status(c));
  await batch(c, [
    { toolName: "plasticity_create_sphere", arguments: { centerMm: [5000, 0, 10], radiusMm: 10, name: "sf-shot-sphere" } },
    { toolName: "plasticity_create_box", arguments: { originMm: [5015, -10, 0], sizeMm: [20, 20, 20], name: "sf-shot-box" } },
    { toolName: "plasticity_find_edges", arguments: { query: { bodyIds: ["$1.added[0]"], line: true, direction: { vector: [0, 0, 1] } }, limit: 10 } },
    { toolName: "plasticity_fillet", arguments: { id: "$1.added[0]", edgeIds: "$2.result.matches[*].id", radiusMm: 6 } },
  ]);
  const frame = { bodyIds: (await added(c, before)).map((body) => body.id) };
  const start = await viewState(ctx);
  const dir = join(ctx.output, "shots");
  await mkdir(dir, { recursive: true });
  const modes: Array<"window" | "viewport"> = [];
  const probeWindow = await tryCall(c, "plasticity_screenshot", { path: join(dir, "window-probe.png"), captureMode: "window" });
  modes.push(...(probeWindow.ok ? ["window" as const, "viewport" as const] : ["viewport" as const]));
  ctx.evidence.p4.modes = modes;
  const read = (path: string) => decodePng(readFileSync(path));
  for (const mode of modes) {
    // Warm-up: on a fresh instance the first framed capture can still show a frame from before the view settled
    // (mean abs diff 0.57 against later captures in one run); it is not used as the reference.
    await call(c, "plasticity_screenshot", { path: join(dir, `${mode}-warmup.png`), captureMode: mode, frame });
    const base = await call(c, "plasticity_screenshot", { path: join(dir, `${mode}-default.png`), captureMode: mode, frame });
    const reference = read(base.path);
    const stats: Record<string, unknown> = {};
    for (const shader of SHADERS) {
      const shot = await call(c, "plasticity_screenshot", { path: join(dir, `${mode}-${shader}.png`), captureMode: mode, frame, shader });
      const image = read(shot.path);
      const diff = pixelDiff(image, reference);
      stats[shader] = { ...diff, view: shot.view };
      check(ctx, "p4", `${mode} ${shader}: differs from the default (mean abs diff > 0.5) and reports the restore`, diff.meanAbsDiff > 0.5 && shot.view?.shader?.mode === shader && shot.view?.shader?.restored === start.shader && shot.view?.frame?.cameraRestored === true, { diff, view: shot.view });
      if (ctx.shots && mode === modes[0]) await writeFile(join(ctx.shots, `shader-${shader}.png`), encodePng(shrink(image, 4)), { flag: "wx" });
    }
    if (ctx.shots && mode === modes[0]) await writeFile(join(ctx.shots, "shader-default.png"), encodePng(shrink(reference, 4)), { flag: "wx" });
    const again = await call(c, "plasticity_screenshot", { path: join(dir, `${mode}-default-again.png`), captureMode: mode, frame });
    const restored = pixelDiff(read(again.path), reference);
    stats.defaultAgain = restored;
    check(ctx, "p4", `${mode}: the default capture afterwards matches the first (mean abs diff < 0.01)`, restored.meanAbsDiff < 0.01, restored);
    ctx.evidence.p4[mode] = stats;
  }
  const inline = await c.callTool({ name: "plasticity_screenshot", arguments: { shader: "zebraVertical", frame, maxWidth: 512 } });
  const inlineText = JSON.parse((inline.content as any[]).find((entry) => entry.type === "text")?.text ?? "{}");
  check(ctx, "p4", "inline JPEG with a shader returns an image and the view", !inline.isError && (inline.content as any[]).some((entry) => entry.type === "image") && inlineText.view?.shader?.mode === "zebraVertical" || (!probeWindow.ok && Boolean(inline.isError)), inlineText);
  // Review D6: a view change left by an interrupted call (applied, never restored) is undone by the next plain capture.
  await ctx.native.readNative(SCREENSHOT_VIEW_SOURCE, ["name2shader"], [{ op: "apply", shader: "zebraVertical", frame, tolerance: 1e-9 }], 15000);
  const leftOver = await viewState(ctx);
  const plain = await call(c, "plasticity_screenshot", { path: join(dir, "plain-after-interrupted.png"), captureMode: modes[0] });
  const afterPlain = await viewState(ctx);
  check(ctx, "p4", "a plain screenshot first restores a pending shader and camera left by an interrupted call", leftOver.shader === "zebraVertical" && leftOver.pendingView && plain.restoredPendingView === true && afterPlain.shader === start.shader && !afterPlain.pendingView && JSON.stringify(afterPlain.camera) === JSON.stringify(start.camera), { leftOver: { shader: leftOver.shader, pending: leftOver.pendingView }, plain, after: { shader: afterPlain.shader, pending: afterPlain.pendingView } });
  // Final review S1: the same interrupted call, then the user moves the camera: the plain capture must leave the camera
  // where the user put it, drop the stale record and say so; the shader is restored either way.
  const savedCamera = await ctx.native.read<unknown>(SAVE_CAMERA);
  await ctx.native.readNative(SCREENSHOT_VIEW_SOURCE, ["name2shader"], [{ op: "apply", shader: "zebraVertical", frame, tolerance: 1e-9, samePose: 1e-6 }], 15000);
  await call(c, "plasticity_set_camera", { eyeMm: [5200, -150, 120], targetMm: [5020, 0, 10], frameRadiusMm: 60 });
  // The camera eases to the new pose: wait until it holds still, so "the camera stayed" compares settled poses.
  let moved = await viewState(ctx);
  for (let i = 0; i < 40; i += 1) { await new Promise((resolve) => setTimeout(resolve, 100)); const now = await viewState(ctx); const still = JSON.stringify(now.camera) === JSON.stringify(moved.camera); moved = now; if (still) break; }
  const plainAfterMove = await call(c, "plasticity_screenshot", { path: join(dir, "plain-after-moved-camera.png"), captureMode: modes[0] });
  const afterMove = await viewState(ctx);
  check(ctx, "p4", "S1: a stale pending view does not override a camera moved afterwards (pendingViewDiscarded); the shader is restored", moved.pendingView && moved.shader === "zebraVertical" && plainAfterMove.pendingViewDiscarded === true && afterMove.shader === start.shader && !afterMove.pendingView && JSON.stringify(afterMove.camera) === JSON.stringify(moved.camera) && JSON.stringify(moved.camera) !== JSON.stringify(start.camera), { plain: { restoredPendingView: plainAfterMove.restoredPendingView, pendingViewDiscarded: plainAfterMove.pendingViewDiscarded }, shader: afterMove.shader, cameraKept: JSON.stringify(afterMove.camera) === JSON.stringify(moved.camera) });
  // Put the camera back where the section found it (the frame capture restores to the pose it starts from, so set it first).
  await ctx.native.read(RESTORE_CAMERA, [{ camera: savedCamera }], 15000);
  const forced = await tryCall(c, "plasticity_screenshot", { path: join(dir, `${modes[0]}-default.png`), captureMode: modes[0], shader: "topo", frame });
  const end = await viewState(ctx);
  check(ctx, "p4", "a forced capture failure still restores the shader and the camera, and leaves nothing pending", !forced.ok && end.shader === start.shader && JSON.stringify(end.camera) === JSON.stringify(start.camera) && end.pendingView === false, { forced, end: { shader: end.shader, pendingView: end.pendingView } });
  check(ctx, "p4", "undo depth unchanged by all captures", end.undoDepth === start.undoDepth, [start.undoDepth, end.undoDepth]);
  check(ctx, "p4", "camera exactly as before all captures", JSON.stringify(end.camera) === JSON.stringify(start.camera), { start: start.camera, end: end.camera });
}

// ---------------------------------------------------------------- P5 ----------------------------------------------------------------
async function p5(ctx: Ctx) {
  const c = ctx.client;
  const before = idsOf(await status(c));
  await batch(c, [
    { toolName: "plasticity_create_box", arguments: { originMm: [5800, 0, 0], sizeMm: [20, 20, 20], name: "sf-continuity" } },
    { toolName: "plasticity_find_edges", arguments: { query: { bodyIds: ["$0.added[0]"], line: true, direction: { vector: [0, 0, 1] } }, limit: 10 } },
    { toolName: "plasticity_fillet", arguments: { id: "$0.added[0]", edgeIds: "$1.result.matches[*].id", radiusMm: 3 } },
  ]);
  const box = (await added(c, before)).find((body) => body.name === "sf-continuity");
  const body = await info(c, box.id);
  const edges = body.edges.filter((edge: any) => edge.faceIds.length === 2).map((edge: any) => ({ bodyId: box.id, edgeId: edge.id }));
  const result = await unchanged(ctx, "p5", "continuity read", async () => await call(c, "plasticity_analyze_surface_continuity", { edges, revision: (await status(c)).revision }));
  const rows = result.analyses.map((row: any) => ({ edge: row.edge.edgeId, achieved: row.achievedContinuity, maxG0Mm: row.maximumPositionDeviationMm, maxG1Deg: row.maximumNormalAngleDeviationDeg, maxG2: row.maximumRelativeCurvatureDeviation, interior: row.interior, worstAt: row.worstAt, absoluteCurvature: row.absoluteCurvature }));
  ctx.evidence.p5.rows = rows;
  check(ctx, "p5", "every edge has interior and worstAt", rows.every((row: any) => row.interior && (row.worstAt === "corner" || row.worstAt === "interior")), rows.length);
  const corner = rows.find((row: any) => row.worstAt === "corner" && row.maxG0Mm > 0.01 && row.interior.g0Mm < 1e-6);
  check(ctx, "p5", "a corner case: the edge reads discontinuous from a corner spike while its run is G0-clean", Boolean(corner), corner ?? rows.slice(0, 4));
  const fillet = rows.filter((row: any) => row.maxG2 === 1 && row.absoluteCurvature);
  check(ctx, "p5", "plane-to-fillet edges: relative G2 1.0 with absolute curvature 0 and 1/3 per mm (R3)", fillet.length > 0 && fillet.every((row: any) => { const k: number[] = [row.absoluteCurvature.side1PerMm, row.absoluteCurvature.side2PerMm].map(Math.abs).sort((x: number, y: number) => x - y); return k[0]! < 1e-9 && Math.abs(k[1]! - 1 / 3) < 1e-9; }), fillet.slice(0, 2));
}

// ---------------------------------------------------------------- P6 ----------------------------------------------------------------
// Two NURBS sheets (the probe fixture): A is the reference; B starts 0.5 mm off A's end edge and leaves at another angle.
async function alignFixture(c: Client, x0: number) {
  const before = idsOf(await status(c));
  await batch(c, [
    { toolName: "plasticity_create_control_point_curve", arguments: { pointsMm: [[x0, 0, 0], [x0 + 10, 0, 0], [x0 + 20, 2, 0], [x0 + 30, 5, 0]] } },
    { toolName: "plasticity_extrude_curves", arguments: { ids: ["$0.added[0]"], distanceMm: 20, direction: [0, 0, 1] } },
    { toolName: "plasticity_create_control_point_curve", arguments: { pointsMm: [[x0 + 30.5, 5.3, 0], [x0 + 38, 12, 0], [x0 + 46, 20, 0], [x0 + 54, 30, 0]] } },
    { toolName: "plasticity_extrude_curves", arguments: { ids: ["$2.added[0]"], distanceMm: 20, direction: [0, 0, 1] } },
  ]);
  const sheets = (await added(c, before)).filter((body) => body.type === "Sheet").sort((a, b) => a.id - b.id);
  const A = await info(c, sheets[0].id), B = await info(c, sheets[1].id);
  const vertical = (body: any) => body.edges.filter((edge: any) => edge.tangent && Math.abs(Math.abs(edge.tangent[2]) - 1) < 1e-6);
  return {
    a: { bodyId: A.id as number, edgeId: vertical(A).sort((p: any, q: any) => q.centerMm[0] - p.centerMm[0])[0].id as string },
    b: { bodyId: B.id as number, edgeId: vertical(B).sort((p: any, q: any) => p.centerMm[0] - q.centerMm[0])[0].id as string },
  };
}
async function p6(ctx: Ctx) {
  const c = ctx.client;
  const operations = new PlasticityOperations(ctx.native);
  const classes = ["AlignEdgeCommand", "AlignEdgeDialog", "AlignAndRebuildFactory", "AlignEdgeFactory"];
  const fingerprint = async () => await ctx.native.readNative<Array<string | null>>(PROTOTYPE_FINGERPRINT, classes, [{}]);
  const printsBefore = await fingerprint();
  const globalsBefore = (await viewState(ctx)).globals;
  const fixture = await alignFixture(c, 7000);
  const fixtureDepth = (await status(c)).undoDepth;
  const results: Record<string, unknown> = {};
  const versions = async () => Object.fromEntries(((await status(c)).bodies as any[]).map((body) => [body.id, body.versionId]));
  const trial = async (name: string, moving: { bodyId: number; edgeId: string }, reference: { bodyId: number; edgeId: string }, continuity: "g0" | "g1" | "g2") => {
    const before = await versions();
    const aligned = await call(c, "plasticity_surface_align", { moving, reference, continuity, intent: `align ${name}`, revision: (await status(c)).revision });
    const after = await versions();
    await call(c, "plasticity_join_sheets", { ids: [moving.bodyId, reference.bodyId], intent: "read back the alignment", revision: (await status(c)).revision });
    const joined = ((await status(c)).bodies as any[]).find((body) => body.type === "Sheet" && body.faceCount === 2);
    const shared = (await info(c, joined.id)).edges.filter((edge: any) => edge.faceIds.length === 2);
    const row = (await call(c, "plasticity_analyze_surface_continuity", { edges: shared.map((edge: any) => ({ bodyId: joined.id, edgeId: edge.id })), revision: (await status(c)).revision })).analyses[0];
    results[name] = { undoSteps: aligned.undoSteps, readiness: aligned.readiness, maxGapMm: aligned.coincidence.maxGapMm, maxTangentPlaneAngleDeg: aligned.maxTangentPlaneAngleDeg, movedChanged: before[moving.bodyId] !== after[moving.bodyId], referenceKept: before[reference.bodyId] === after[reference.bodyId], joined: { achieved: row.achievedContinuity, gapMm: row.maximumPositionDeviationMm, angleDeg: row.maximumNormalAngleDeviationDeg, relG2: row.maximumRelativeCurvatureDeviation, interior: row.interior, worstAt: row.worstAt } };
    await undoTo(c, fixtureDepth);
    return { aligned, row, moved: before[moving.bodyId] !== after[moving.bodyId], kept: before[reference.bodyId] === after[reference.bodyId] };
  };
  // Review D8: one face of the reference Sheet selected by the user before the call stays selected afterwards.
  const referenceFace = (await info(c, fixture.a.bodyId)).faces[0].id;
  const selectReference = async () => await call(c, "plasticity_select_faces", { faces: [{ bodyId: fixture.a.bodyId, faceId: referenceFace }], revision: (await status(c)).revision });
  const selectedFaces = async () => ((await call(c, "plasticity_current_selection", {})).faces ?? []).map((face: any) => `${face.bodyId}:${face.faceId ?? face.id}`);
  await selectReference();
  const selectedBefore = await selectedFaces();
  const viaTool = await call(c, "plasticity_surface_align", { moving: fixture.b, reference: fixture.a, continuity: "g1", intent: "align with a user selection", revision: (await status(c)).revision });
  const selectedAfterSuccess = await selectedFaces();
  await undoTo(c, fixtureDepth);
  await selectReference();
  const refusedSel = await tryCall(c, "plasticity_surface_align", { moving: { bodyId: fixture.a.bodyId, edgeId: "no-such-edge" }, reference: fixture.b, continuity: "g1", revision: (await status(c)).revision });
  const selectedAfterRefusal = await selectedFaces();
  results.selection = { selectedBefore, verified: viaTool.coincidence, selectedAfterSuccess, refused: refusedSel, selectedAfterRefusal };
  check(ctx, "p6", "a face selected before the call is still selected after a verified align and after a refusal", selectedBefore.length === 1 && JSON.stringify(selectedAfterSuccess) === JSON.stringify(selectedBefore) && !refusedSel.ok && JSON.stringify(selectedAfterRefusal) === JSON.stringify(selectedBefore), results.selection);
  const activeAfterAlign = (await viewState(ctx)).activeCommand;
  check(ctx, "p6", "the align itself leaves no command active while the selection is back", activeAfterAlign === null, activeAfterAlign);
  // The selection is cleared before the next edits, so that this section checks the align alone. Before the selection
  // guard an edit with a face still selected did not return (Plasticity starts its default face command after any
  // command that finished); section p6select runs those edits with the selection kept, and they return now.
  await call(c, "plasticity_clear_selection", { revision: (await status(c)).revision });
  const g0 = await trial("g0", fixture.b, fixture.a, "g0");
  check(ctx, "p6", "G0: one step, edge on the reference (<= 0.001 mm), joined edge reads G0 or better", g0.aligned.undoSteps === 1 && g0.aligned.coincidence.maxGapMm <= 1e-3 && g0.row.passes.G0, results.g0);
  const g1 = await trial("g1", fixture.b, fixture.a, "g1");
  check(ctx, "p6", "G1: joined edge reads G1 or better", g1.row.passes.G1, results.g1);
  const g2 = await trial("g2", fixture.b, fixture.a, "g2");
  check(ctx, "p6", "G2: joined edge reads G2", g2.row.passes.G2, results.g2);
  const swapped = await trial("g1-swapped", fixture.a, fixture.b, "g1");
  check(ctx, "p6", "swapped order: the other sheet (A) moves, B stays, G1", swapped.moved && swapped.kept && swapped.row.passes.G1, results["g1-swapped"]);
  // Refused inputs: nothing changes.
  const refusedBefore = await viewState(ctx);
  const sameBody = await tryCall(c, "plasticity_surface_align", { moving: fixture.b, reference: { bodyId: fixture.b.bodyId, edgeId: fixture.b.edgeId }, continuity: "g1", revision: (await status(c)).revision });
  const beforeBox = idsOf(await status(c));
  await call(c, "plasticity_create_box", { originMm: [7100, 0, 0], sizeMm: [10, 10, 10], name: "sf-align-solid", revision: (await status(c)).revision });
  const solid = (await added(c, beforeBox))[0];
  const solidEdge = (await info(c, solid.id)).edges[0].id;
  const depthWithBox = (await status(c)).undoDepth;
  const boxState = await viewState(ctx);
  const solidRefused = await tryCall(c, "plasticity_surface_align", { moving: { bodyId: solid.id, edgeId: solidEdge }, reference: fixture.a, continuity: "g1", revision: (await status(c)).revision });
  const afterRefusals = await viewState(ctx);
  await undoTo(c, fixtureDepth);
  results.refused = { sameBody, solidRefused };
  check(ctx, "p6", "refused inputs (two edges of one Sheet; a Solid edge) change nothing", !sameBody.ok && !solidRefused.ok && /Sheet body/.test(solidRefused.error) && afterRefusals.undoDepth === boxState.undoDepth && afterRefusals.bodies === boxState.bodies && boxState.undoDepth === depthWithBox && refusedBefore.bodies + 1 === boxState.bodies, results.refused);
  // A 20 mm vertical edge aligned onto A's 30 mm bottom curve: Plasticity commits, the edge misses: a certain error, one undo restores.
  const aBody = await info(c, fixture.a.bodyId);
  const bottom = aBody.edges.filter((edge: any) => !(edge.tangent && Math.abs(Math.abs(edge.tangent[2]) - 1) < 1e-6)).sort((p: any, q: any) => p.centerMm[2] - q.centerMm[2])[0];
  const mismatchBefore = await viewState(ctx);
  const mismatch = await tryCall(c, "plasticity_surface_align", { moving: fixture.b, reference: { bodyId: fixture.a.bodyId, edgeId: bottom.id }, continuity: "g1", revision: (await status(c)).revision });
  const mismatchAfter = await viewState(ctx);
  results.mismatch = { ...mismatch, undo: [mismatchBefore.undoDepth, mismatchAfter.undoDepth] };
  await call(c, "plasticity_undo", { intent: "undo the mismatched align", revision: (await status(c)).revision });
  const mismatchUndone = await viewState(ctx);
  check(ctx, "p6", "a mismatched pair is a certain error with one Undo step that one plasticity_undo restores", !mismatch.ok && /plasticity_undo restores/.test(mismatch.error) && mismatchAfter.undoDepth === mismatchBefore.undoDepth + 1 && mismatchUndone.undoDepth === mismatchBefore.undoDepth && mismatchUndone.bodies === mismatchBefore.bodies && !ctx.native.isUncertain(), results.mismatch);
  const printsAfter = await fingerprint();
  const globalsAfter = (await viewState(ctx)).globals;
  check(ctx, "p6", "no prototype patch left on the Align classes and no new renderer globals", JSON.stringify(printsBefore) === JSON.stringify(printsAfter) && JSON.stringify(globalsBefore) === JSON.stringify(globalsAfter), { printsSame: JSON.stringify(printsBefore) === JSON.stringify(printsAfter), globalsBefore, globalsAfter });
  ctx.evidence.p6.results = results;
}

// Final review A1, as specified: an edit straight after an align with faces still selected, and the same edit with no align.
async function p6select(ctx: Ctx) {
  const c = ctx.client;
  const trials: Array<Record<string, unknown>> = [];
  const start = (await status(c)).undoDepth;
  const selectionCount = async () => { const now = await tryCall(c, "plasticity_current_selection", {}); return now.ok ? (now.value.faces ?? []).length as number : -1; };
  for (const [mode, faces, next] of [["align", 1, "join"], ["align", 1, "move"], ["align", 1, "fillet"], ["align", 2, "join"], ["align", 2, "move"], ["align", 2, "fillet"], ["no align", 2, "move"]] as Array<[string, number, string]>) {
    const before = idsOf(await status(c));
    // Without an align the sheets already touch, so the join can succeed.
    const [bx, by] = mode === "align" ? [30.5, 5.3] : [30, 5];
    await batch(c, [
      { toolName: "plasticity_create_control_point_curve", arguments: { pointsMm: [[7000, 0, 0], [7010, 0, 0], [7020, 2, 0], [7030, 5, 0]] } },
      { toolName: "plasticity_extrude_curves", arguments: { ids: ["$0.added[0]"], distanceMm: 20, direction: [0, 0, 1] } },
      { toolName: "plasticity_create_control_point_curve", arguments: { pointsMm: [[7000 + bx, by, 0], [7038, 12, 0], [7046, 20, 0], [7054, 30, 0]] } },
      { toolName: "plasticity_extrude_curves", arguments: { ids: ["$2.added[0]"], distanceMm: 20, direction: [0, 0, 1] } },
      { toolName: "plasticity_create_box", arguments: { originMm: [7100, 0, 0], sizeMm: [10, 10, 10], name: "sf-select-edit" } },
      { toolName: "plasticity_create_box", arguments: { originMm: [7150, 0, 0], sizeMm: [10, 10, 10], name: "sf-select-keep" } },
    ]);
    const fresh = await added(c, before);
    const sheets = fresh.filter((body) => body.type === "Sheet").sort((p, q) => p.id - q.id);
    const A = await info(c, sheets[0].id), B = await info(c, sheets[1].id), edit = await info(c, fresh.find((body) => body.name === "sf-select-edit")!.id), keep = await info(c, fresh.find((body) => body.name === "sf-select-keep")!.id);
    const vertical = (body: any) => body.edges.filter((edge: any) => edge.tangent && Math.abs(Math.abs(edge.tangent[2]) - 1) < 1e-6);
    const a = { bodyId: A.id, edgeId: vertical(A).sort((p: any, q: any) => q.centerMm[0] - p.centerMm[0])[0].id }, b = { bodyId: B.id, edgeId: vertical(B).sort((p: any, q: any) => p.centerMm[0] - q.centerMm[0])[0].id };
    // The user's selection: faces of a body that no later edit touches, so "still selected" has one meaning.
    await call(c, "plasticity_select_faces", { faces: keep.faces.slice(0, faces).map((face: any) => ({ bodyId: keep.id, faceId: face.id })), revision: (await status(c)).revision });
    let aligned: unknown = "not run";
    if (mode === "align") { const run = await tryCall(c, "plasticity_surface_align", { moving: b, reference: a, continuity: "g0", intent: "A1 check", revision: (await status(c)).revision }); aligned = run.ok ? "ok" : run.error.slice(0, 200); }
    const afterAlign = { selected: await selectionCount(), active: (await viewState(ctx)).activeCommand };
    const revision = (await status(c)).revision;
    const started = Date.now();
    const edited = next === "join" ? await tryCall(c, "plasticity_join_sheets", { ids: [A.id, B.id], revision })
      : next === "move" ? await tryCall(c, "plasticity_move", { ids: [edit.id], deltaMm: [0, 0, 1], revision })
        : await tryCall(c, "plasticity_fillet", { id: edit.id, edgeIds: [edit.edges[0].id], radiusMm: 1, revision });
    const ms = Date.now() - started;
    const after = await viewState(ctx);
    const selected = await selectionCount();
    const trial = { mode, faces, next, aligned, afterAlign, ms, ok: edited.ok, error: edited.ok ? undefined : edited.error.slice(0, 120), selectedAfter: selected, activeAfter: after.activeCommand };
    trials.push(trial);
    check(ctx, "p6select", `${mode}, ${faces} face${faces === 1 ? "" : "s"} selected, then ${next}: under 1 s, the selection still there, no command active`, edited.ok && ms < 1000 && selected === faces && after.activeCommand === null && (mode !== "align" || (aligned === "ok" && afterAlign.selected === faces && afterAlign.active === null)), trial);
    await ctx.native.mutate(CANCEL_ACTIVE, []).catch(() => undefined);
    await tryCall(c, "plasticity_reconcile", {});
    await undoTo(c, start);
  }
  ctx.evidence.p6select.trials = trials;
}

async function p6stall(ctx: Ctx) {
  const c = ctx.client;
  const operations = new PlasticityOperations(ctx.native);
  const fixture = await alignFixture(c, 7000);
  const fixtureDepth = (await status(c)).undoDepth;
  const results: Record<string, unknown> = {};
  // Stalls injected at the operations layer: short drive budgets, before and after finish().
  const stalls: Array<Record<string, unknown>> = [];
  let sawAfterFinish = false, sawBeforeFinish = false, bad = false;
  for (let ms = 1; ms <= 120 && !(sawAfterFinish && sawBeforeFinish); ms += ms < 10 ? 4 : 1) {
    console.log(`p6stall trying finishMs ${ms}`);
    const before = await viewState(ctx);
    const outcome = await operations.surfaceAlign({ moving: fixture.b, reference: fixture.a, continuity: "g1" }, (await status(c)).revision, { dialogMs: 3000, finishMs: ms, cancelMs: 3000, settleMs: 250 })
      .then(() => ({ kind: "committed", error: "" }), (error: Error) => ({ kind: ctx.native.isUncertain() ? "undetermined" : "certain-error", error: error.message }));
    if (ctx.native.isUncertain()) await ctx.native.reconcile();
    const after = await viewState(ctx);
    const unchanged = after.undoDepth === before.undoDepth && after.bodies === before.bodies;
    // A real stall after finish(): the dialog was finished and the commit did not settle in the budget ("finish phase").
    // A refused late finish() (the drive outlived its budget) is also undetermined, but it is not that case.
    const afterFinish = /finish phase|after its dialog was finished/.test(outcome.error);
    const lateFinish = /called finish\(\) after it had returned/.test(outcome.error);
    if (outcome.kind === "certain-error" && (!unchanged || afterFinish || lateFinish)) bad = true;
    // Before finish(): the drive is cancelled (certain, unchanged), or it outlives its budget and its finish() is refused
    // (no commit of ours can start; the classifier still says undetermined). Which one happens depends on timing.
    if ((outcome.kind === "certain-error" && unchanged) || (outcome.kind === "undetermined" && lateFinish && unchanged)) sawBeforeFinish = true;
    if (outcome.kind === "undetermined" && afterFinish) sawAfterFinish = true;
    stalls.push({ finishMs: ms, ...outcome, error: outcome.error.slice(0, 200), undo: [before.undoDepth, after.undoDepth], activeCommand: after.activeCommand });
    await undoTo(c, fixtureDepth);
  }
  results.stalls = stalls;
  check(ctx, "p6", "stalls: before finish() cancelled (certain, unchanged) or its late finish() refused; after finish() undetermined; never a certain unchanged after finish()", sawBeforeFinish && sawAfterFinish && !bad && stalls.every((entry) => entry.activeCommand === null), stalls);
  ctx.evidence.p6stall.results = results;
}

// ---------------------------------------------------------------- P7 ----------------------------------------------------------------
async function p7(ctx: Ctx) {
  const c = ctx.client;
  const results: Record<string, unknown> = {};
  const square = async (args: Record<string, unknown>) => await call(c, "plasticity_square_surface", { ...args, intent: "square", revision: (await status(c)).revision });
  // (a) Four cubic Bezier boundary curves; the patch edges are the curves, so probe rays just inside each edge read the
  // curve's own height: edge y=0 has z = 3*5*s(1-s) (3.75 at the middle), edge x=8040 has z = 3*(-4)*s(1-s) (-3).
  const before = idsOf(await status(c));
  await batch(c, [
    { toolName: "plasticity_create_control_point_curve", arguments: { pointsMm: [[8000, 0, 0], [8013.333333333333, 0, 5], [8026.666666666667, 0, 5], [8040, 0, 0]] } },
    { toolName: "plasticity_create_control_point_curve", arguments: { pointsMm: [[8040, 0, 0], [8040, 13.333333333333334, -4], [8040, 26.666666666666668, -4], [8040, 40, 0]] } },
    { toolName: "plasticity_create_control_point_curve", arguments: { pointsMm: [[8040, 40, 0], [8026.666666666667, 40, 6], [8013.333333333333, 40, 6], [8000, 40, 0]] } },
    { toolName: "plasticity_create_control_point_curve", arguments: { pointsMm: [[8000, 40, 0], [8000, 26.666666666666668, 3], [8000, 13.333333333333334, 3], [8000, 0, 0]] } },
  ]);
  const wires = (await added(c, before)).map((body) => body.id).sort((a: number, b: number) => a - b);
  const depthA = (await status(c)).undoDepth;
  const a = await square({ boundary: wires.map((id: number) => ({ wireId: id })) });
  const sheetA = await info(c, a.sheetId);
  const probe = await call(c, "plasticity_probe_surface", { id: a.sheetId, gridMm: { at: [[8020, 1e-4], [8040 - 1e-4, 20], [8020, 40 - 1e-4], [1e-4 + 8000, 20]] }, revision: (await status(c)).revision });
  const heights = probe.rays.map((ray: any) => ray.intersections[0]?.pointMm[2]);
  results.fourCurves = { undoSteps: a.undoSteps, type: sheetA.type, faces: sheetA.faces.length, edges: sheetA.edges.length, surface: sheetA.faces[0]?.surfaceType, edgeHeights: heights };
  const expected = [3.75, -3, 4.5, 2.25];
  check(ctx, "p7", "four curves: one Sheet, one face, four edges, one Undo step; probe heights at the four edges match the curves (0.01 mm)", a.undoSteps === 1 && sheetA.type === "Sheet" && sheetA.faces.length === 1 && sheetA.edges.length === 4 && heights.every((h: number, i: number) => Math.abs(h - expected[i]!) <= 0.01), results.fourCurves);
  await call(c, "plasticity_undo", { intent: "undo square", revision: (await status(c)).revision });
  const undone = await status(c);
  check(ctx, "p7", "one plasticity_undo removes the square and nothing else", undone.undoDepth === depthA && !idsOf(undone).has(a.sheetId) && wires.every((id: number) => idsOf(undone).has(id)), { undo: undone.undoDepth, depthA });
  // (b) A flat neighbour Sheet (z = 0, y -20..0) plus three curves that leave it horizontally.
  const beforeB = idsOf(await status(c));
  await batch(c, [
    { toolName: "plasticity_create_polyline", arguments: { pointsMm: [[8200, 0, 0], [8240, 0, 0]], closed: false } },
    { toolName: "plasticity_extrude_curves", arguments: { ids: ["$0.added[0]"], distanceMm: 20, direction: [0, -1, 0] } },
    { toolName: "plasticity_create_control_point_curve", arguments: { pointsMm: [[8240, 0, 0], [8240, 13, 0], [8240, 27, 5], [8240, 40, 5]] } },
    { toolName: "plasticity_create_control_point_curve", arguments: { pointsMm: [[8240, 40, 5], [8227, 40, 5], [8213, 40, 5], [8200, 40, 5]] } },
    { toolName: "plasticity_create_control_point_curve", arguments: { pointsMm: [[8200, 40, 5], [8200, 27, 5], [8200, 13, 0], [8200, 0, 0]] } },
  ]);
  const addedB = await added(c, beforeB);
  const neighbour = addedB.find((body) => body.type === "Sheet")!;
  const sideWires = addedB.filter((body) => body.type === "Wire" && body.id > neighbour.id).map((body) => body.id).sort((x: number, y: number) => x - y);
  const sharedEdge = (await info(c, neighbour.id)).edges.find((edge: any) => Math.abs(edge.centerMm[1]) < 1e-6 && Math.abs(edge.centerMm[0] - 8220) < 1e-6);
  const depthB = (await status(c)).undoDepth;
  const neighbourRun = async (name: string, continuity: "g0" | "g1") => {
    const made = await square({ boundary: [{ bodyId: neighbour.id, edgeId: sharedEdge.id }, ...sideWires.map((id: number) => ({ wireId: id }))], edgeContinuity: [{ edgeId: sharedEdge.id, continuity }] });
    await call(c, "plasticity_join_sheets", { ids: [neighbour.id, made.sheetId], intent: "read back the square", revision: (await status(c)).revision });
    const joined = ((await status(c)).bodies as any[]).find((body) => body.type === "Sheet" && body.faceCount === 2);
    const shared = (await info(c, joined.id)).edges.filter((edge: any) => edge.faceIds.length === 2);
    const row = (await call(c, "plasticity_analyze_surface_continuity", { edges: shared.map((edge: any) => ({ bodyId: joined.id, edgeId: edge.id })), revision: (await status(c)).revision })).analyses[0];
    results[name] = { undoSteps: made.undoSteps, achieved: row.achievedContinuity, gapMm: row.maximumPositionDeviationMm, angleDeg: row.maximumNormalAngleDeviationDeg, interior: row.interior, worstAt: row.worstAt };
    await undoTo(c, depthB);
    return row;
  };
  const g0 = await neighbourRun("neighbourG0", "g0");
  const g1 = await neighbourRun("neighbourG1", "g1");
  check(ctx, "p7", "neighbour + three curves: g0 joins with a G0 shared edge; g1 brings the interior normal angle down (G1)", g0.passes.G0 && g1.passes.G1 && g1.interior.g1Deg <= g0.interior.g1Deg, { g0: results.neighbourG0, g1: results.neighbourG1 });
  // (c) Refusals: an open box's top loop at g1 (error 30), three items, a G2 request. Nothing changes.
  const beforeC = idsOf(await status(c));
  await call(c, "plasticity_create_box", { originMm: [8300, 0, 0], sizeMm: [40, 40, 20], name: "sf-square-box", revision: (await status(c)).revision });
  const box = (await added(c, beforeC))[0];
  const top = (await info(c, box.id)).faces.find((face: any) => face.planar && Math.abs(face.normal[2] - 1) < 1e-9);
  await call(c, "plasticity_delete_faces", { faces: [{ bodyId: box.id, faceId: top.id }], intent: "open the box", revision: (await status(c)).revision });
  const rim = (await info(c, box.id)).edges.filter((edge: any) => edge.faceIds.length === 1).map((edge: any) => edge.id);
  const refuseBefore = await viewState(ctx);
  const e30 = await tryCall(c, "plasticity_square_surface", { boundary: rim.map((edgeId: string) => ({ bodyId: box.id, edgeId })), edgeContinuity: rim.map((edgeId: string) => ({ edgeId, continuity: "g1" })), revision: (await status(c)).revision });
  const three = await tryCall(c, "plasticity_square_surface", { boundary: rim.slice(0, 3).map((edgeId: string) => ({ bodyId: box.id, edgeId })), revision: (await status(c)).revision });
  const g2 = await tryCall(c, "plasticity_square_surface", { boundary: rim.map((edgeId: string) => ({ bodyId: box.id, edgeId })), edgeContinuity: [{ edgeId: rim[0], continuity: "g2" }], revision: (await status(c)).revision });
  const refuseAfter = await viewState(ctx);
  results.refusals = { e30, three, g2, undo: [refuseBefore.undoDepth, refuseAfter.undoDepth], bodies: [refuseBefore.bodies, refuseAfter.bodies] };
  check(ctx, "p7", "refusals (error 30 at g1 on an open box; three items; g2) leave undo depth and bodies unchanged", !e30.ok && /error `30`/.test(e30.error) && /incompatible at a corner/.test(e30.error) && !three.ok && !g2.ok && refuseAfter.undoDepth === refuseBefore.undoDepth && refuseAfter.bodies === refuseBefore.bodies, results.refusals);
  const g0box = await square({ boundary: rim.map((edgeId: string) => ({ bodyId: box.id, edgeId })) });
  const boxSquare = await info(c, g0box.sheetId);
  results.openBoxG0 = { undoSteps: g0box.undoSteps, faces: boxSquare.faces.length, edges: boxSquare.edges.length };
  check(ctx, "p7", "the same open box at g0 closes with one four-edged face", g0box.undoSteps === 1 && boxSquare.faces.length === 1 && boxSquare.edges.length === 4, results.openBoxG0);
  // Review D4: a boundary with a 0.005 mm or a 1 mm corner gap is refused before any edit, naming the gap.
  const T = 1 / 3, beforeGap = idsOf(await status(c));
  await batch(c, [
    { toolName: "plasticity_create_control_point_curve", arguments: { pointsMm: [[8039.995, 40, 0], [8000 + 80 * T, 40, 6], [8000 + 40 * T, 40, 6], [8000, 40, 0]] } },
    { toolName: "plasticity_create_control_point_curve", arguments: { pointsMm: [[8039, 40, 0], [8000 + 80 * T, 40, 6], [8000 + 40 * T, 40, 6], [8000, 40, 0]] } },
  ]);
  const [gap005, gap1] = (await added(c, beforeGap)).map((body) => body.id).sort((x: number, y: number) => x - y);
  const gapBefore = await viewState(ctx);
  const open005 = await tryCall(c, "plasticity_square_surface", { boundary: [wires[0], wires[1], gap005, wires[3]].map((id: number) => ({ wireId: id })), revision: (await status(c)).revision });
  const open1 = await tryCall(c, "plasticity_square_surface", { boundary: [wires[0], wires[1], gap1, wires[3]].map((id: number) => ({ wireId: id })), revision: (await status(c)).revision });
  const gapAfter = await viewState(ctx);
  results.gaps = { open005, open1 };
  check(ctx, "p7", "open boundaries (0.005 mm and 1 mm corner gaps) are refused before any edit with the gap size", !open005.ok && /0\.005 mm apart/.test(open005.error) && !open1.ok && /1 mm apart/.test(open1.error) && /nothing was changed/.test(open1.error) && gapAfter.undoDepth === gapBefore.undoDepth && gapAfter.bodies === gapBefore.bodies, results.gaps);
  ctx.evidence.p7.results = results;
}

// ---------------------------------------------------------------- main ----------------------------------------------------------------
async function main(): Promise<void> {
  const options = parseSurfacingArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const endpoint = process.env.PLASTICITY_CDP_URL;
  if (!endpoint) throw new Error("PLASTICITY_CDP_URL is mandatory and must name the isolated Plasticity instance; nothing was created");
  process.env.PLASTICITY_AUTO_LAUNCH = "0";
  process.env.PLASTICITY_HUD = "0";
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  if (options.shots) await mkdir(resolve(options.shots), { recursive: false });
  const evidence: Record<string, any> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target, endpoint };
  const failures: string[] = [];
  const stderr: string[] = [];
  const targets = await discoverPlasticityTargets(endpoint);
  const target = targets.find((candidate) => candidate.id === options.target);
  if (!target) throw new Error("Explicit Plasticity target was not found on PLASTICITY_CDP_URL; nothing was created");
  const native = await PlasticityRuntime.connect(target);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "scripts", "run-server.ts")],
    cwd: projectRoot,
    env: {
      PLASTICITY_MCP_STATE_DIR: join(output, "state"), PLASTICITY_CONSTRUCTION_HISTORY_ROOT: join(output, "history"),
      ...Object.fromEntries(["PATH", "HOME", "TMPDIR"].flatMap((key) => typeof process.env[key] === "string" ? [[key, process.env[key]!]] : [])),
      PLASTICITY_CDP_URL: endpoint, PLASTICITY_AUTO_LAUNCH: "0", PLASTICITY_HUD: "0", PLASTICITY_HUD_NOTIFY: "0",
      ...(process.env.PLASTICITY_EXPERIMENTAL_TOOLS ? { PLASTICITY_EXPERIMENTAL_TOOLS: process.env.PLASTICITY_EXPERIMENTAL_TOOLS } : {}),
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-surfacing-live", version: "1.0.0" });
  await client.connect(transport);
  const ctx: Ctx = { client, native, evidence, failures, output, ...(options.shots ? { shots: resolve(options.shots) } : {}) };
  let baseline: any, baselineView: any;
  try {
    await call(client, "plasticity_connect", { targetId: options.target });
    baseline = await status(client);
    baselineView = await viewState(ctx);
    evidence.baseline = { undoDepth: baseline.undoDepth, bodies: (baseline.bodies as any[]).map((body) => body.id), shader: baselineView.shader, camera: baselineView.camera, globals: baselineView.globals };
    if (baselineView.activeCommand) throw new Error(`A command is active (${baselineView.activeCommand}); nothing was created`);
    const run: Record<Section, (ctx: Ctx) => Promise<void>> = { p1, p2, p3, p4, p5, p6, p7, p6stall, p6select };
    for (const name of options.only ?? DEFAULT_SECTIONS) await section(ctx, name, async () => await run[name](ctx));
  } catch (error) {
    failures.push(`run: ${(error as Error).message.slice(0, 2000)}`);
  } finally {
    try { await native.mutate(CANCEL_ACTIVE, []); } catch { /* reported by the end state */ }
    try { await call(client, "plasticity_reconcile", {}); } catch { /* not uncertain */ }
    if (baseline) {
      try { await undoTo(client, baseline.undoDepth); } catch (error) { failures.push(`recover: ${(error as Error).message}`); }
      const end = await status(client);
      const endView = await viewState(ctx);
      evidence.end = { undoDepth: end.undoDepth, bodies: (end.bodies as any[]).map((body) => body.id), shader: endView.shader, camera: endView.camera, globals: endView.globals, activeCommand: endView.activeCommand };
      const same = end.undoDepth === baseline.undoDepth && JSON.stringify(evidence.end.bodies) === JSON.stringify(evidence.baseline.bodies) && endView.shader === baselineView.shader && JSON.stringify(endView.camera) === JSON.stringify(baselineView.camera) && endView.activeCommand === null && JSON.stringify(endView.globals) === JSON.stringify(baselineView.globals);
      if (!same) failures.push("end state differs from the baseline (undo depth, body set, shader, camera, active command or globals)");
      evidence.endMatchesBaseline = same;
    }
    evidence.failures = failures;
    evidence.serverStderrTail = stderr.join("").slice(-2000);
    await writeFile(join(output, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await client.close().catch(() => undefined);
    native.close();
  }
  console.log(failures.length === 0 ? "ALL PASS" : `FAILURES:\n${failures.join("\n")}`);
  if (failures.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error((error as Error).message.slice(0, 4000)); process.exitCode = 1; });
