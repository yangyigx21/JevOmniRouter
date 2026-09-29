/**
 * AnimationController — ANIM-1/2/3/4 (T-6.6) + ANIM-5 (T-6.7).
 *
 * Single rAF loop (PERF-2).
 * Interrupt: calling startRun() while running discards current and starts fresh (ANIM-5).
 * prefers-reduced-motion: reduces effects but preserves complete event path (TREE-5).
 */
import { TOTAL_DUR, type ComputeRunResult, computeRun, type ComputeRunContext } from './computeRunFrontend.js';

export type AnimationListener = (result: ComputeRunResult, elapsed: number) => void;

export interface AnimationControllerOptions {
  speed?: number;
  reducedMotion?: boolean;
}

export class AnimationController {
  private running = false;
  private startTime = 0;
  private pauseTime = 0;
  private paused = false;
  private speed: number;
  private rafId = 0;
  private ctx: ComputeRunContext;
  private listeners = new Set<AnimationListener>();
  private onComplete?: () => void;
  private reducedMotion: boolean;

  constructor(options: AnimationControllerOptions = {}) {
    this.speed = options.speed ?? 1;
    this.reducedMotion = options.reducedMotion ?? false;
    this.ctx = {
      winnerIdx: 0,
      nodeCount: 6,
      probs: [],
      confidence: 0,
      tier: 'ROUTE',
    };
  }

  /** ANIM-5: Interrupt — start a new run, discarding current. */
  startRun(ctx: ComputeRunContext, onComplete?: () => void): void {
    this.ctx = ctx;
    this.onComplete = onComplete;
    this.running = true;
    this.paused = false;
    this.startTime = performance.now();
    this.pauseTime = 0;
    if (!this.rafId) this.tick();
  }

  /** Interrupt and restart (ANIM-5). */
  reroute(ctx: ComputeRunContext, onComplete?: () => void): void {
    // Discard current animation, start fresh
    this.startRun(ctx, onComplete);
  }

  pause(): void {
    if (this.running && !this.paused) {
      this.paused = true;
      this.pauseTime = performance.now();
    }
  }

  resume(): void {
    if (this.running && this.paused) {
      const pausedDuration = performance.now() - this.pauseTime;
      this.startTime += pausedDuration;
      this.paused = false;
    }
  }

  togglePause(): void {
    if (this.paused) this.resume();
    else this.pause();
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(0.1, Math.min(speed, 5));
  }

  /** Seek to specific time (ms). */
  seekTo(timeMs: number): void {
    if (!this.running) {
      this.running = true;
      this.paused = true;
    }
    const now = performance.now();
    this.startTime = now - timeMs / this.speed;
  }

  /** Replay from beginning. */
  replay(): void {
    this.startTime = performance.now();
    this.paused = false;
    if (!this.rafId) this.tick();
  }

  stop(): void {
    this.running = false;
    this.paused = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  isRunning(): boolean { return this.running; }
  isPaused(): boolean { return this.paused; }
  getSpeed(): number { return this.speed; }
  isReducedMotion(): boolean { return this.reducedMotion; }

  onFrame(listener: AnimationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private tick = (): void => {
    if (!this.running) {
      this.rafId = 0;
      return;
    }

    if (!this.paused) {
      const now = performance.now();
      const elapsed = (now - this.startTime) * this.speed;
      const t = Math.min(elapsed, TOTAL_DUR);

      const result = computeRun(t, this.ctx);

      for (const listener of this.listeners) {
        listener(result, elapsed);
      }

      if (t >= TOTAL_DUR) {
        this.running = false;
        this.onComplete?.();
      }
    }

    this.rafId = requestAnimationFrame(this.tick);
  };

  /** Check prefers-reduced-motion. */
  static checkReducedMotion(): boolean {
    if (typeof window === 'undefined') return false;
    return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  }
}
