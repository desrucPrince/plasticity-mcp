// bench-2026-11: a REAL Claude model builds surfaced forms (suite S) and a multi-part assembly (suite M) through the Plasticity MCP
// server of the FROZEN tree. Measurement only. Same headless command line as discovery/speed-2026-11/agent-bench.ts:
//   claude -p "<prompt>" --mcp-config <tmp.json> --strict-mcp-config --output-format stream-json --verbose --tools ""
//          --allowedTools "mcp__plasticity" --setting-sources "" --permission-mode dontAsk --max-turns <N> --disable-slash-commands
//          --no-session-persistence       (default model, run from an empty temp cwd)
//
// Usage (Node 24):
//   node bench.ts --label baseline --parts S1,S2,S3,M --runs 2 [--smoke] [--max-turns 80]
//   node bench.ts --summarize baseline        (re-reads results-<label>.json, writes baseline-summary.json)
// The harness verifies every run itself through a fresh MCP session, saves a screenshot, then undoes back to the starting
// undo depth and asserts depth + body ids. Endpoint is hard-locked to 127.0.0.1:57291.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { ALLOWED_PORT, ENDPOINT, TARGET, FROZEN_TREE, serverEnv, makeCtx, withSession, restore, idsOf, facesOf, sum, median, byteLen, r3, near, type Ctx, type Check, type Status } from "./common.ts";
import { s3Builder, S3 } from "./reference.ts";
import { verifyS1, verifyS2, verifyS3 } from "./verify.ts";
import { verifyM } from "./verify-m.ts";

const HERE = dirname(new URL(import.meta.url).pathname);
const CLAUDE = process.env.BENCH_CLAUDE ?? `${process.env.HOME}/.local/bin/claude`;
const argv = process.argv.slice(2);
const arg = (name: string, dflt?: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const flag = (name: string) => argv.includes(`--${name}`);

// Scrub every home path (/Users/<name>) and the HOME value from anything written to disk.
export function scrub(text: string): string {
  let t = text.replace(new RegExp("/Us" + "ers/[^/\\s\"'\\\\]+", "g"), "~");
  const home = process.env.HOME;
  if (home) t = t.split(home).join("~");
  return t;
}

type ToolCall = { turn: number; name: string; routedTo?: string; reqBytes: number; respBytes: number; isError: boolean; startedMs: number; execMs: number | null; errorText?: string };

// ---------- the model run ----------
async function runClaude(ctx: Ctx, prompt: string, timeoutS: number, maxTurns: number, transcriptPath: string) {
  const dir = mkdtempSync(join(tmpdir(), "bench-2026-11-run-"));
  const cwd = join(dir, "cwd"); mkdirSync(cwd);
  const cfg = join(dir, "mcp.json");
  writeFileSync(cfg, JSON.stringify({ mcpServers: { plasticity: { command: process.execPath, args: [join(ctx.tree, "scripts/run-server.ts"), "--compact-tools"], env: serverEnv(ctx.endpoint, ctx.historyRoot) } } }));
  const args = ["-p", prompt, "--mcp-config", cfg, "--strict-mcp-config", "--output-format", "stream-json", "--verbose", "--tools", "", "--allowedTools", "mcp__plasticity", "--setting-sources", "", "--permission-mode", "dontAsk", "--max-turns", String(maxTurns), "--disable-slash-commands", "--no-session-persistence"];
  const commandLine = ["claude", ...args.map((a) => (a === prompt ? JSON.stringify("<prompt>") : /[\s"]/.test(a) || a === "" ? JSON.stringify(a) : a))].join(" ");
  const t0 = performance.now();
  const child: ChildProcess = spawn(CLAUDE, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: process.env });
  const lines: Array<{ t: number; e: any }> = [];
  let buf = ""; let stderr = ""; let timedOut = false;
  child.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try { lines.push({ t: performance.now() - t0, e: JSON.parse(line) }); } catch { /* ignore */ }
    }
  });
  child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });
  const killGroup = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } };
  const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutS * 1000);
  const exit: number | null = await new Promise((res) => child.on("close", (c) => res(c)));
  clearTimeout(timer);
  const wallMs = performance.now() - t0;
  killGroup(); // reap any MCP server child left in the process group before verification starts
  await new Promise((r) => setTimeout(r, 400));
  rmSync(dir, { recursive: true, force: true });
  // Persist a scrubbed transcript (drop init/rate-limit events: they carry local paths and account usage).
  const keep = lines.filter(({ e }) => !(e.type === "system" && e.subtype === "init") && e.type !== "rate_limit_event");
  writeFileSync(transcriptPath, scrub(keep.map(({ t, e }) => JSON.stringify({ tMs: Math.round(t), ...e })).join("\n") + "\n"));
  return { lines, wallMs, exit, timedOut, stderr: scrub(stderr.slice(0, 2000)), commandLine };
}

// ---------- stream-json analysis ----------
function analyze(lines: Array<{ t: number; e: any }>, wallMs: number) {
  const initT = lines.find((l) => l.e.type === "system" && l.e.subtype === "init")?.t ?? 0;
  const msgs = new Map<string, { firstT: number; lastT: number; toolUses: Array<{ id: string; name: string; input: any }>; textBlocks: string[]; thinkingChars: number }>();
  const order: string[] = [];
  const results = new Map<string, { t: number; isError: boolean; bytes: number; text: string }>();
  let lastUserT = initT; const turnBoundary = new Map<string, number>();
  for (const { t, e } of lines) {
    if (e.type === "assistant" && e.message?.id) {
      const id = e.message.id as string;
      if (!msgs.has(id)) { msgs.set(id, { firstT: t, lastT: t, toolUses: [], textBlocks: [], thinkingChars: 0 }); order.push(id); turnBoundary.set(id, lastUserT); }
      const m = msgs.get(id)!; m.lastT = t;
      for (const b of e.message.content ?? []) {
        if (b.type === "tool_use") m.toolUses.push({ id: b.id, name: b.name, input: b.input });
        else if (b.type === "text") m.textBlocks.push(b.text);
        else if (b.type === "thinking") m.thinkingChars += (b.thinking ?? "").length;
      }
    } else if (e.type === "user") {
      const content = e.message?.content;
      if (Array.isArray(content)) for (const b of content) if (b.type === "tool_result") {
        const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((p: any) => p.text ?? "").join("") : JSON.stringify(b.content ?? "");
        results.set(b.tool_use_id, { t, isError: b.is_error === true, bytes: Buffer.byteLength(text), text });
        lastUserT = t;
      }
    }
  }
  const resultEvent = lines.map((l) => l.e).reverse().find((e) => e.type === "result");
  const iterations: Array<{ input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }> = resultEvent?.usage?.iterations ?? [];
  const calls: ToolCall[] = [];
  order.forEach((id, turnIdx) => {
    for (const u of msgs.get(id)!.toolUses) {
      const r = results.get(u.id);
      const routed = u.name.endsWith("plasticity_call") ? String(u.input?.toolName ?? "") : u.name.endsWith("plasticity_batch") ? `batch(${Array.isArray(u.input?.steps) ? u.input.steps.length : "?"} steps: ${(Array.isArray(u.input?.steps) ? u.input.steps : []).slice(0, 12).map((s: any) => String(s?.toolName ?? "").replace("plasticity_", "")).join(",")})` : undefined;
      calls.push({ turn: turnIdx + 1, name: u.name.replace("mcp__plasticity__", ""), ...(routed ? { routedTo: routed } : {}), reqBytes: byteLen(u.input ?? {}), respBytes: r?.bytes ?? 0, isError: r?.isError ?? false, startedMs: Math.round(msgs.get(id)!.lastT), execMs: r ? Math.round(r.t - msgs.get(id)!.lastT) : null, ...(r?.isError ? { errorText: scrub(r.text.slice(0, 400)) } : {}) });
    }
  });
  const turns = order.map((id, i) => {
    const m = msgs.get(id)!;
    const it = iterations.length === order.length ? iterations[i] : undefined;
    return { turn: i + 1, modelMs: Math.round(m.lastT - turnBoundary.get(id)!), outputTokens: it?.output_tokens ?? null, inputTokens: it?.input_tokens ?? null, cacheRead: it?.cache_read_input_tokens ?? null, toolCalls: m.toolUses.length, respBytes: sum(calls.filter((c) => c.turn === i + 1).map((c) => c.respBytes)), execMs: sum(calls.filter((c) => c.turn === i + 1).map((c) => c.execMs ?? 0)), thinkingChars: m.thinkingChars, textChars: sum(m.textBlocks.map((s) => s.length)) };
  });
  let errors = 0, retries = 0;
  calls.forEach((c, i) => { if (c.isError) { errors += 1; if (calls.slice(i + 1).some((n) => n.turn > c.turn)) retries += 1; } });
  const byName: Record<string, number> = {};
  for (const c of calls) { const k = c.routedTo && !c.routedTo.startsWith("batch(") ? `plasticity_call:${c.routedTo}` : c.name; byName[k] = (byName[k] ?? 0) + 1; }
  const u = resultEvent?.usage ?? {};
  const execTotal = sum(calls.map((c) => c.execMs ?? 0));
  return {
    wallMs: Math.round(wallMs), startupMs: Math.round(initT), turns: order.length, toolCalls: calls.length, toolCallsByName: byName,
    errors, retries, requestBytes: sum(calls.map((c) => c.reqBytes)), responseBytes: sum(calls.map((c) => c.respBytes)),
    serverExecMs: execTotal, serverTimeShare: wallMs ? Math.round((execTotal / wallMs) * 1000) / 1000 : null,
    calls, perTurn: turns,
    tokens: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
    costUsd: resultEvent?.total_cost_usd ?? null, resultSubtype: resultEvent?.subtype ?? null, isErrorResult: resultEvent?.is_error ?? null,
    terminalReason: resultEvent?.terminal_reason ?? null, permissionDenials: resultEvent?.permission_denials?.length ?? 0,
    model: Object.keys(resultEvent?.modelUsage ?? {})[0] ?? null,
    finalText: scrub(String(resultEvent?.result ?? "").slice(0, 1200)),
  };
}

// ---------- screenshot (harness-made, evidence only) ----------
const CAMERA: Record<string, { eye: number[]; target: number[]; radius: number }> = {
  S1: { eye: [2170, -130, 110], target: [2060, 0, 30], radius: 85 },
  S2: { eye: [2045, -85, 75], target: [2045, 25, 7], radius: 70 },
  S3: { eye: [2040, -30, 70], target: [2040, 30, 22], radius: 55 },
  M: { eye: [2105, -75, 85], target: [2031, 20, 8], radius: 60 },
};
async function screenshot(ctx: Ctx, part: string, run: number, shotsDir: string): Promise<{ path?: string; mode?: string; error?: string }> {
  const cam = CAMERA[part]!;
  const path = join(shotsDir, `${part.startsWith("S") ? "S" : "M"}-${part}-r${run}.png`.replace(/^S-S/, "S-S").replace(/^M-M/, "M-M"));
  const name = `${part}-r${run}.png`;
  const full = join(shotsDir, name);
  void path;
  if (existsSync(full)) rmSync(full);
  try {
    return await withSession(ctx, async (s) => {
      await s.call("plasticity_set_camera", { eyeMm: cam.eye, targetMm: cam.target, frameRadiusMm: cam.radius });
      await new Promise((r) => setTimeout(r, 1200));
      try { await s.raw("plasticity_screenshot", { path: full, captureMode: "window", maxWidth: 1600, quality: 80 }); return { path: `shots/${name}`, mode: "window" }; }
      catch (e1) {
        try { if (existsSync(full)) rmSync(full); await s.raw("plasticity_screenshot", { path: full, captureMode: "viewport", maxWidth: 1600, quality: 80 }); return { path: `shots/${name}`, mode: "viewport", error: `window mode failed: ${scrub(String(e1)).slice(0, 200)}` }; }
        catch (e2) { return { error: scrub(`window: ${String(e1).slice(0, 200)}; viewport: ${String(e2).slice(0, 200)}`) }; }
      }
    });
  } catch (e) { return { error: scrub(String(e).slice(0, 300)) }; }
}

// ---------- verification dispatch ----------
async function verify(ctx: Ctx, part: string, pre: Status["bodies"], finalText: string, s3geom?: ReturnType<typeof s3Builder>["geometry"]): Promise<{ checks: Check[]; bodyId: number | null; scale: { bodies: number; totalFaces: number }; note?: string }> {
  return withSession(ctx, async (s) => {
    const now = await s.status();
    const scale = { bodies: now.bodies.length, totalFaces: sum(now.bodies.map((b) => b.faceCount)) };
    if (part === "M") { const v = await verifyM(s); return { checks: v.checks, bodyId: null, scale: v.scale }; }
    const before = new Set(pre.map((b) => b.id));
    const said = Number(/DONE\D*(\d+)/i.exec(finalText)?.[1] ?? NaN);
    const volBox = (b: Status["bodies"][number]) => (b.boundsMm.max[0]! - b.boundsMm.min[0]!) * (b.boundsMm.max[1]! - b.boundsMm.min[1]!) * (b.boundsMm.max[2]! - b.boundsMm.min[2]!);
    if (part === "S3") {
      // candidates: any non-wire body; prefer the one named in DONE, then the one that carries the hole edges, then the largest face count
      const cands = now.bodies.filter((b) => b.type !== "Wire").sort((a, b) => (b.id === said ? 1 : 0) - (a.id === said ? 1 : 0) || b.faceCount - a.faceCount);
      const geom = s3geom!;
      let chosen = cands[0]; let how = chosen ? (chosen.id === said ? "id from DONE line" : "largest non-wire body") : "";
      for (const c of cands) {
        const es = await (await import("./common.ts")).edgesOf(s, c.id);
        if (geom.holeMid.some((m) => es.some((e) => Math.hypot(e.centerMm[0]! - m[0]!, e.centerMm[1]! - m[1]!, e.centerMm[2]! - m[2]!) <= 0.01))) { chosen = c; how = c.id === said ? "id from DONE line" : "body that carries the hole edges"; break; }
      }
      const checks: Check[] = [{ check: "a result body exists", ok: !!chosen, actual: { said: Number.isNaN(said) ? null : said, how, candidates: cands.map((c) => `${c.id}:${c.type}:${c.faceCount}f`) } }];
      checks.push({ check: "DONE id names the result body", soft: true, ok: !!chosen && chosen.id === said });
      if (!chosen) return { checks, bodyId: null, scale };
      checks.push(...(await verifyS3(s, chosen.id, geom.holeMid)));
      return { checks, bodyId: chosen.id, scale, note: how };
    }
    const fresh = now.bodies.filter((b) => !before.has(b.id) && b.type === "Solid");
    let chosen = fresh.find((b) => b.id === said); let how = chosen ? "id from DONE line" : "";
    if (!chosen && fresh.length) { chosen = [...fresh].sort((a, b) => volBox(b) - volBox(a))[0]; how = "largest new solid (DONE id missing or wrong)"; }
    const checks: Check[] = [{ check: "a new solid body exists", ok: !!chosen, actual: { newSolids: fresh.map((b) => b.id), said: Number.isNaN(said) ? null : said, how } }];
    checks.push({ check: "DONE id names the result body", soft: true, ok: !!chosen && chosen.id === said });
    checks.push({ check: "no stray new solids (only the result)", soft: true, ok: fresh.length === 1, actual: fresh.length });
    if (!chosen) return { checks, bodyId: null, scale };
    checks.push(...(part === "S1" ? await verifyS1(s, chosen.id) : await verifyS2(s, chosen.id)));
    return { checks, bodyId: chosen.id, scale, note: how };
  });
}

// ---------- main ----------
async function bench() {
  const tree = arg("server-tree", FROZEN_TREE)!;
  if (tree !== FROZEN_TREE) throw new Error(`refusing: the server under test is the frozen tree ${FROZEN_TREE}`);
  if (new URL(ENDPOINT).port !== ALLOWED_PORT || new URL(ENDPOINT).hostname !== "127.0.0.1") throw new Error(`refusing: endpoint must be 127.0.0.1:${ALLOWED_PORT}`);
  const label = arg("label", flag("smoke") ? "smoke" : "baseline")!;
  const parts = (arg("parts", "S1,S2,S3,M")!).split(",").map((s) => s.trim()).filter(Boolean);
  const runs = Number(arg("runs", "1"));
  const maxTurns = Number(arg("max-turns", "80"));
  const tFlag = arg("timeout-s");
  const prompts = JSON.parse(readFileSync(join(HERE, "prompts.json"), "utf8"));
  const out = HERE;
  const shotsDir = join(out, "shots"); mkdirSync(shotsDir, { recursive: true });
  const tdir = join(out, `transcripts-${label}`); mkdirSync(tdir, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "bench-2026-11-"));
  const emptyCwd = join(scratch, "cwd"); mkdirSync(emptyCwd);
  const historyRoot = join(scratch, "history"); mkdirSync(historyRoot);
  const ctx = makeCtx(tree, historyRoot, emptyCwd);
  const start = await withSession(ctx, (s) => s.status());
  ctx.base = { undoDepth: start.undoDepth, ids: idsOf(start), bodyCount: start.bodies.length };
  console.error(`start: target ${start.targetId} undoDepth ${start.undoDepth} bodies ${start.bodies.length} (${ctx.base.ids}); tree ${tree}`);

  const results: any[] = [];
  const file = join(out, `results-${label}.json`);
  const flush = () => writeFileSync(file, scrub(JSON.stringify({ label, model: "default", serverTree: "plasticity-mcp-bench (frozen, commit 496c478)", endpoint: ENDPOINT, target: TARGET, measuredAt: new Date().toISOString(), startUndoDepth: ctx.base.undoDepth, startBodyCount: ctx.base.bodyCount, maxTurns, runs: results }, null, 1)));
  try {
    for (const part of parts) for (let run = 1; run <= runs; run++) {
      const def = prompts.parts[part]; if (!def) throw new Error(`unknown part ${part}`);
      const prompt = `${def.text} ${prompts.closing[def.closing]}`;
      const timeoutS = Number(tFlag ?? (part === "M" ? 1200 : 600));
      let s3b: ReturnType<typeof s3Builder> | undefined; let setupError: string | undefined;
      if (part === "S3") {
        try {
          s3b = s3Builder(S3);
          await withSession(ctx, async (s) => { await s.batch(s3b!.steps, { undoOnError: true }); });
        } catch (e) { setupError = scrub((e as Error).message.slice(0, 600)); }
      }
      let record: any;
      if (setupError) record = { part, run, error: `S3 neighbour sheets failed to build: ${setupError}` };
      else {
        const pre = await withSession(ctx, (s) => s.status());
        console.error(`[${label}] ${part} run ${run}: starting model (timeout ${timeoutS}s, max-turns ${maxTurns})`);
        const transcript = join(tdir, `${part}-r${run}.jsonl`);
        const res = await runClaude(ctx, prompt, timeoutS, maxTurns, transcript);
        const a = analyze(res.lines, res.wallMs);
        let ver: Awaited<ReturnType<typeof verify>> | { checks: Check[]; bodyId: null; scale: { bodies: number; totalFaces: number }; error: string };
        try { ver = await verify(ctx, part, pre.bodies, a.finalText, s3b?.geometry); } catch (e) { ver = { checks: [], bodyId: null, scale: { bodies: -1, totalFaces: -1 }, error: scrub((e as Error).message.slice(0, 600)) }; }
        const shot = await screenshot(ctx, part, run, shotsDir);
        const hard = ver.checks.filter((c) => !c.soft);
        record = { part, run, label, prompt, commandLine: res.commandLine, exit: res.exit, timedOut: res.timedOut, stderr: res.stderr || undefined, ...a, documentScaleAtEnd: ver.scale, verification: { passed: hard.filter((c) => c.ok).length, of: hard.length, failed: hard.filter((c) => !c.ok).map((c) => c.check), bodyId: ver.bodyId, checks: ver.checks, ...("error" in ver ? { error: (ver as any).error } : {}) }, screenshot: shot, transcript: `transcripts-${label}/${part}-r${run}.jsonl` };
      }
      let restored: Awaited<ReturnType<typeof restore>>;
      try { restored = await restore(ctx); } catch (e) { restored = { ok: false, undoDepth: -1, bodyCount: -1, redoDepth: -1, error: scrub((e as Error).message) } as never; }
      record.restored = restored;
      results.push(record); flush();
      console.error(`[${label}] ${part} run ${run}: wall ${record.wallMs ?? "-"} ms, turns ${record.turns ?? "-"}, calls ${record.toolCalls ?? "-"}, errors ${record.errors ?? "-"}, checks ${record.verification?.passed}/${record.verification?.of}, cost $${record.costUsd?.toFixed?.(3) ?? "-"}, restored ${JSON.stringify(restored)}`);
      if (!restored.ok) throw new Error(`document not restored after ${part} run ${run}: ${JSON.stringify(restored)}`);
    }
  } finally { flush(); }
  const finalState = await withSession(ctx, (s) => s.status());
  rmSync(scratch, { recursive: true, force: true });
  console.error(`end: undoDepth ${finalState.undoDepth} (start ${ctx.base.undoDepth}), bodies ${finalState.bodies.length} (start ${ctx.base.bodyCount})`);
  summarize(label, { undoDepth: finalState.undoDepth, bodyCount: finalState.bodies.length });
}

// ---------- summary ----------
function summarize(label: string, endState?: { undoDepth: number; bodyCount: number }) {
  const d = JSON.parse(readFileSync(join(HERE, `results-${label}.json`), "utf8"));
  const rows: any[] = [];
  for (const part of [...new Set(d.runs.map((r: any) => r.part))] as string[]) {
    const rs = d.runs.filter((r: any) => r.part === part);
    const ok = rs.filter((r: any) => r.turns != null);
    rows.push({
      part, runs: rs.length,
      wallS: ok.map((r: any) => Math.round(r.wallMs / 1000)),
      turns: ok.map((r: any) => r.turns), toolCalls: ok.map((r: any) => r.toolCalls), errors: ok.map((r: any) => r.errors),
      costUsd: ok.map((r: any) => (r.costUsd == null ? null : Math.round(r.costUsd * 1000) / 1000)),
      checks: ok.map((r: any) => `${r.verification.passed}/${r.verification.of}`),
      failedChecks: ok.map((r: any) => r.verification.failed),
      finalText: ok.map((r: any) => r.finalText),
      timedOut: ok.map((r: any) => r.timedOut), setupErrors: rs.filter((r: any) => r.error).map((r: any) => r.error),
      documentScaleAtEnd: ok.map((r: any) => r.documentScaleAtEnd),
    });
  }
  const mRuns = d.runs.filter((r: any) => r.part === "M" && r.turns != null);
  const mScale = mRuns.map((r: any) => ({ run: r.run, turnLatencyMsByTurn: r.perTurn.map((t: any) => t.modelMs), respBytesByTurn: r.perTurn.map((t: any) => t.respBytes), execMsByTurn: r.perTurn.map((t: any) => t.execMs), serverTimeShare: r.serverTimeShare, documentScaleAtEnd: r.documentScaleAtEnd }));
  const summary = { label, measuredAt: d.measuredAt, serverTree: d.serverTree, startUndoDepth: d.startUndoDepth, startBodyCount: d.startBodyCount, endState: endState ?? null, rows, mScaleSeries: mScale };
  writeFileSync(join(HERE, label === "baseline" ? "baseline-summary.json" : `${label}-summary.json`), scrub(JSON.stringify(summary, null, 1)));
  console.log(JSON.stringify(rows.map((r) => ({ part: r.part, runs: r.runs, wallS: r.wallS, turns: r.turns, calls: r.toolCalls, errors: r.errors, cost: r.costUsd, checks: r.checks })), null, 0));
}

if (arg("summarize")) summarize(arg("summarize")!);
else await bench();
void median; void near; void r3; void facesOf;
