// Activity HUD: a small badge drawn into the Plasticity window while the MCP server (or an external job such as a
// Blender render) is working, so a stall is visible. The state logic is pure (hudView); Hud drives it from tool-call
// hooks plus a heartbeat timer and hands each frame to an injector that draws it in the renderer.

export type HudTone = "active" | "slow" | "stuck" | "done" | "error";

export interface HudState {
  op: string | null;            // current tool or job name
  step: { index: number; total: number; name: string } | null;
  startedAt: number;            // ms epoch of the current job
  lastActivityAt: number;       // ms epoch of the last completed op or progress update
  finishedAt: number | null;    // set when the job ends (done or error)
  error: string | null;
  progress: string | null;      // free text from an external job, e.g. "Blender rendering 42%"
}

export interface HudFrame {
  visible: boolean;
  instant?: boolean;            // hide/show without the fade (used around screenshots)
  tone: HudTone;
  title: string;
  detail: string;
}

export const HUD_SLOW_MS = 30_000;
export const HUD_STUCK_MS = 120_000;
export const HUD_DONE_SHOW_MS = 4_000;
export const HUD_ERROR_SHOW_MS = 15_000;

const seconds = (ms: number) => `${Math.max(0, Math.round(ms / 1000))}s`;

export function hudView(state: HudState, now: number): HudFrame {
  if (state.finishedAt !== null) {
    const shown = now - state.finishedAt;
    if (state.error !== null) {
      return { visible: shown < HUD_ERROR_SHOW_MS, tone: "error", title: `${state.op ?? "job"} failed`, detail: state.error.slice(0, 140) };
    }
    return { visible: shown < HUD_DONE_SHOW_MS, tone: "done", title: `${state.op ?? "job"} done ✓`, detail: `took ${seconds(state.finishedAt - state.startedAt)}` };
  }
  if (state.op === null) return { visible: false, tone: "active", title: "", detail: "" };
  const idle = now - state.lastActivityAt;
  const tone: HudTone = idle >= HUD_STUCK_MS ? "stuck" : idle >= HUD_SLOW_MS ? "slow" : "active";
  const what = state.step ? `${state.op} step ${state.step.index + 1}/${state.step.total}: ${state.step.name}` : state.op;
  const parts = [`elapsed ${seconds(now - state.startedAt)}`, `last activity ${seconds(idle)} ago`];
  if (state.progress) parts.unshift(state.progress);
  if (tone === "stuck") parts.push("possibly stuck: check the Plasticity window/focus");
  return { visible: true, tone, title: what, detail: parts.join(" · ") };
}

export type HudInjector = (frame: HudFrame) => Promise<void> | void;

export interface HudOptions {
  enabled?: boolean;
  tickMs?: number;                 // heartbeat redraw interval while a job is shown
  now?: () => number;
  onLongJobEnd?: (op: string, ms: number, error: string | null) => void;
  longJobMs?: number;              // default 60 s
}

export class Hud {
  private state: HudState = { op: null, step: null, startedAt: 0, lastActivityAt: 0, finishedAt: null, error: null, progress: null };
  private depth = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastVisible = false;

  private readonly inject: HudInjector;
  private readonly options: HudOptions;

  constructor(inject: HudInjector, options: HudOptions = {}) {
    this.inject = inject;
    this.options = options;
  }

  get enabled(): boolean { return this.options.enabled ?? true; }
  private now(): number { return (this.options.now ?? Date.now)(); }

  /** Begin (or nest into) a job. Nested starts only refresh activity. */
  start(op: string): void {
    if (!this.enabled) return;
    const now = this.now();
    if (this.depth === 0) this.state = { op, step: null, startedAt: now, lastActivityAt: now, finishedAt: null, error: null, progress: null };
    else this.state.lastActivityAt = now;
    this.depth += 1;
    this.ensureTimer();
    this.render();
  }

  step(index: number, total: number, name: string): void {
    if (!this.enabled || this.depth === 0) return;
    this.state.step = { index, total, name };
    this.state.lastActivityAt = this.now();
    this.render();
  }

  /** Progress from a long external or internal job; counts as activity. */
  progress(text: string, op?: string): void {
    if (!this.enabled) return;
    const now = this.now();
    if (this.depth === 0 && (this.state.op === null || this.state.finishedAt !== null)) {
      this.state = { op: op ?? "job", step: null, startedAt: now, lastActivityAt: now, finishedAt: null, error: null, progress: text };
    } else {
      this.state.progress = text;
      this.state.lastActivityAt = now;
    }
    this.ensureTimer();
    this.render();
  }

  finish(): void { this.end(null); }
  fail(error: unknown): void { this.end(error instanceof Error ? error.message : String(error)); }

  /** End an external job started through progress() (no matching start()). */
  endExternal(error: string | null = null): void {
    if (!this.enabled || this.depth > 0 || this.state.op === null || this.state.finishedAt !== null) return;
    this.complete(error);
  }

  private end(error: string | null): void {
    if (!this.enabled || this.depth === 0) return;
    this.depth -= 1;
    if (error !== null && this.state.error === null && this.depth > 0) this.state.error = error;
    if (this.depth > 0) { this.state.lastActivityAt = this.now(); this.render(); return; }
    this.complete(this.state.error ?? error); // the first (root-cause) error wins over outer wrappers
  }

  private complete(error: string | null): void {
    const now = this.now();
    this.state.finishedAt = now;
    this.state.error = error;
    const ms = now - this.state.startedAt;
    if (ms >= (this.options.longJobMs ?? 60_000)) this.options.onLongJobEnd?.(this.state.op ?? "job", ms, error);
    this.render();
  }

  /** Current frame (exposed for tests and status tools). */
  frame(): HudFrame { return hudView(this.state, this.now()); }

  tick(): void { this.render(); }

  /** Hide the badge immediately and wait for it (screenshots must not capture it); tick() restores it. */
  async hideNow(): Promise<void> {
    if (!this.enabled) return;
    try { await this.inject({ ...this.frame(), visible: false, instant: true }); } catch { /* drawing never fails a tool */ }
  }

  private ensureTimer(): void {
    if (this.timer || !this.options.tickMs) return;
    this.timer = setInterval(() => this.render(), this.options.tickMs);
    this.timer.unref?.();
  }

  private render(): void {
    const frame = this.frame();
    if (!frame.visible && !this.lastVisible) {
      if (this.timer && this.depth === 0) { clearInterval(this.timer); this.timer = undefined; }
      return;
    }
    this.lastVisible = frame.visible;
    try { void Promise.resolve(this.inject(frame)).catch(() => undefined); } catch { /* drawing must never break a tool */ }
  }

  dispose(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}

const TONE_COLOURS: Record<HudTone, string> = {
  active: "#27d3e6",
  slow: "#f2b233",
  stuck: "#ff4d4d",
  done: "#3ddc84",
  error: "#ff4d4d",
};

/** Renderer-side script that creates or updates the badge; it re-creates the element if a reload removed it. */
export function hudScript(frame: HudFrame): string {
  const payload = JSON.stringify({ ...frame, colour: TONE_COLOURS[frame.tone] });
  return `(() => {
  const f = ${payload};
  let el = document.getElementById('plasticity-mcp-hud');
  if (!el) {
    el = document.createElement('div');
    el.id = 'plasticity-mcp-hud';
    el.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483647;pointer-events:none;max-width:420px;padding:8px 12px 8px 30px;border-radius:10px;background:rgba(14,16,20,0.86);color:#e8edf2;font:12px/1.35 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,0.45);transition:opacity 0.6s;';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.cssText = 'position:absolute;left:11px;top:13px;width:10px;height:10px;border-radius:50%;';
    const title = document.createElement('div'); title.className = 'title'; title.style.cssText = 'font-weight:600;';
    const detail = document.createElement('div'); detail.className = 'detail'; detail.style.cssText = 'opacity:0.75;';
    el.append(dot, title, detail);
    const style = document.createElement('style');
    style.textContent = '@keyframes plasticityMcpPulse{0%{transform:scale(0.8);opacity:0.6}50%{transform:scale(1.15);opacity:1}100%{transform:scale(0.8);opacity:0.6}}';
    el.append(style);
    document.body.appendChild(el);
  }
  const dot = el.querySelector('.dot');
  dot.style.background = f.colour;
  dot.style.boxShadow = '0 0 8px ' + f.colour;
  dot.style.animation = (f.tone === 'active' || f.tone === 'slow') ? 'plasticityMcpPulse 1.2s ease-in-out infinite' : 'none';
  el.querySelector('.title').textContent = f.title;
  el.querySelector('.detail').textContent = f.detail;
  el.style.borderLeft = '3px solid ' + f.colour;
  el.style.transition = f.instant ? 'none' : 'opacity 0.6s';
  el.style.opacity = f.visible ? '1' : '0';
})()`;
}
