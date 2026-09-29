/**
 * Performance budget monitoring — T-7.4.
 *
 * Implements PERF-1 (startup), PERF-2 (rendering), PERF-3 (memory bounded)
 * per spec.md §PERF.
 *
 * - PERF-1: Startup performance — loading < 3s, FCP target
 * - PERF-2: Rendering performance — frame budget; single frame overhead measurable
 * - PERF-3: Memory bounded — 60s soak heap must stabilize
 *
 * Browser-only: relies on `performance.now()`, `requestAnimationFrame`,
 * and optionally `performance.memory` (Chrome). Falls back gracefully when
 * APIs are unavailable.
 */

// ---------------------------------------------------------------------------
// Types & budget
// ---------------------------------------------------------------------------

/**
 * Configurable performance budget thresholds.
 *
 * PERF-1 governs `startupMaxMs` / `fcpMaxMs`;
 * PERF-2 governs `frameBudgetMs`;
 * PERF-3 governs `heapGrowthMaxMb` / `soakDurationMs`.
 */
export interface PerformanceBudget {
  /** Maximum cold-start duration (ms). PERF-1 default: 3000 */
  startupMaxMs: number;
  /** Maximum First Contentful Paint duration (ms). PERF-1 default: 1800 */
  fcpMaxMs: number;
  /** Frame budget per frame (ms). PERF-2 default: 16.67 (60 fps) */
  frameBudgetMs: number;
  /** Maximum heap growth over soak (MB). PERF-3 default: 10 */
  heapGrowthMaxMb: number;
  /** Soak test duration (ms). PERF-3 default: 60000 */
  soakDurationMs: number;
}

/** Default budget aligned with spec PERF-1 / PERF-2 / PERF-3 thresholds. */
export const DEFAULT_BUDGET: PerformanceBudget = {
  startupMaxMs: 3000,
  fcpMaxMs: 1800,
  frameBudgetMs: 16.67,
  heapGrowthMaxMb: 10,
  soakDurationMs: 60000,
};

// ---------------------------------------------------------------------------
// PERF-1 — Startup
// ---------------------------------------------------------------------------

/** Report returned by {@link StartupMonitor.getReport}. */
export interface StartupReport {
  startToFCPMs: number | null;
  startToReadyMs: number | null;
  withinBudget: boolean;
  violations: string[];
}

/**
 * PERF-1 — Measures startup timing (load → FCP → interactive).
 *
 * Call {@link markStart} at app entry, {@link markFCP} when FCP fires,
 * and {@link markReady} when the app is fully interactive.
 */
export class StartupMonitor {
  private startMark = 0;
  private fcpMark: number | null = null;
  private readyMark: number | null = null;

  /** Mark the application start timestamp. */
  markStart(): void {
    this.startMark = performance.now();
  }

  /**
   * Mark First Contentful Paint.
   *
   * If the PerformancePaintTiming API is available this can be called
   * automatically; otherwise call it manually when the first meaningful
   * content appears.
   */
  markFCP(): void {
    this.fcpMark = performance.now();
  }

  /** Mark the point when the app is fully interactive. */
  markReady(): void {
    this.readyMark = performance.now();
  }

  /**
   * Produce a startup report measured against the given budget.
   *
   * PERF-1: loading < 3s, FCP within `budget.fcpMaxMs`.
   */
  getReport(budget: PerformanceBudget = DEFAULT_BUDGET): StartupReport {
    const violations: string[] = [];

    const startToFCPMs =
      this.fcpMark !== null ? this.fcpMark - this.startMark : null;
    const startToReadyMs =
      this.readyMark !== null ? this.readyMark - this.startMark : null;

    if (startToFCPMs !== null && startToFCPMs > budget.fcpMaxMs) {
      violations.push(
        `FCP ${startToFCPMs.toFixed(1)}ms exceeds budget ${budget.fcpMaxMs}ms (PERF-1)`,
      );
    }

    if (startToReadyMs !== null && startToReadyMs > budget.startupMaxMs) {
      violations.push(
        `Startup ${startToReadyMs.toFixed(1)}ms exceeds budget ${budget.startupMaxMs}ms (PERF-1)`,
      );
    }

    return {
      startToFCPMs,
      startToReadyMs,
      withinBudget: violations.length === 0,
      violations,
    };
  }
}

// ---------------------------------------------------------------------------
// PERF-2 — Frame / Rendering
// ---------------------------------------------------------------------------

/** Stats returned by {@link FrameMonitor.getStats}. */
export interface FrameStats {
  avgFrameMs: number;
  p95FrameMs: number;
  maxFrameMs: number;
  droppedFrames: number;
  totalFrames: number;
  withinBudget: boolean;
}

/**
 * PERF-2 — Monitors rendering frame timing via `requestAnimationFrame`.
 *
 * Measures per-frame deltas and computes average / p95 / max frame times
 * as well as the number of dropped frames that exceed the budget.
 */
export class FrameMonitor {
  private frameDurations: number[] = [];
  private running = false;
  private rafId = 0;
  private lastTimestamp = 0;
  private budget: PerformanceBudget;

  constructor(budget: PerformanceBudget = DEFAULT_BUDGET) {
    this.budget = budget;
  }

  /** Begin monitoring the rAF loop. PERF-2. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.frameDurations = [];
    this.lastTimestamp = 0;
    this.scheduleFrame();
  }

  /** Stop monitoring. */
  stop(): void {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  /** Compute rendering statistics. PERF-2: frame budget; single frame overhead. */
  getStats(): FrameStats {
    const frames = this.frameDurations;
    const totalFrames = frames.length;

    if (totalFrames === 0) {
      return {
        avgFrameMs: 0,
        p95FrameMs: 0,
        maxFrameMs: 0,
        droppedFrames: 0,
        totalFrames: 0,
        withinBudget: true,
      };
    }

    const sorted = [...frames].sort((a, b) => a - b);
    const sum = frames.reduce((acc, v) => acc + v, 0);
    const avgFrameMs = sum / totalFrames;
    const p95Index = Math.min(Math.ceil(totalFrames * 0.95) - 1, totalFrames - 1);
    const p95FrameMs = sorted[p95Index];
    const maxFrameMs = sorted[totalFrames - 1];
    const droppedFrames = frames.filter((d) => d > this.budget.frameBudgetMs).length;

    return {
      avgFrameMs,
      p95FrameMs,
      maxFrameMs,
      droppedFrames,
      totalFrames,
      withinBudget: p95FrameMs <= this.budget.frameBudgetMs,
    };
  }

  private scheduleFrame(): void {
    this.rafId = requestAnimationFrame((timestamp) => {
      if (!this.running) return;

      if (this.lastTimestamp > 0) {
        const delta = timestamp - this.lastTimestamp;
        this.frameDurations.push(delta);
      }
      this.lastTimestamp = timestamp;
      this.scheduleFrame();
    });
  }
}

// ---------------------------------------------------------------------------
// PERF-3 — Memory
// ---------------------------------------------------------------------------

/** Shape of Chrome's non-standard `performance.memory`. */
interface PerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

/**
 * Soak report returned by {@link MemoryMonitor.stopSoak}.
 *
 * PERF-3: 60s soak heap must stabilize within `heapGrowthMaxMb`.
 */
export interface SoakReport {
  startHeapMb: number | null;
  endHeapMb: number | null;
  peakHeapMb: number | null;
  growthMb: number | null;
  stabilized: boolean;
  withinBudget: boolean;
}

/**
 * PERF-3 — Memory bounded monitor.
 *
 * Periodically samples `performance.memory` (Chrome-only) during a soak
 * test and reports whether heap growth stays within budget.
 *
 * Falls back gracefully: all MB fields are `null` when
 * `performance.memory` is unavailable.
 */
export class MemoryMonitor {
  private samples: number[] = [];
  private soaking = false;
  private sampleTimer = 0;
  private soakTimer = 0;
  private budget: PerformanceBudget;
  /** Sample interval in ms (1 s by default). */
  private static readonly SAMPLE_INTERVAL_MS = 1000;

  constructor(budget: PerformanceBudget = DEFAULT_BUDGET) {
    this.budget = budget;
  }

  /**
   * Begin a memory soak measurement. PERF-3.
   *
   * @param durationMs - Soak duration (defaults to `budget.soakDurationMs`).
   * After this duration elapses, the soak completes automatically and
   * `stopSoak()` will return the final report. If `stopSoak()` is called
   * early the report reflects whatever data has been collected so far.
   */
  startSoak(durationMs?: number): void {
    const duration = durationMs ?? this.budget.soakDurationMs;
    this.samples = [];
    this.soaking = true;

    // Collect an initial sample immediately
    this.takeSample();

    // Sample every second
    this.sampleTimer = window.setInterval(() => {
      if (this.soaking) this.takeSample();
    }, MemoryMonitor.SAMPLE_INTERVAL_MS);

    // Auto-stop after duration
    this.soakTimer = window.setTimeout(() => {
      if (this.soaking) {
        this.stopSoak();
      }
    }, duration);
  }

  /**
   * Stop the soak and return the report. PERF-3.
   *
   * If `performance.memory` is not available the MB fields are `null`.
   */
  stopSoak(): SoakReport {
    this.soaking = false;
    clearInterval(this.sampleTimer);
    clearTimeout(this.soakTimer);

    // Take one final sample
    this.takeSample();

    return this.buildReport();
  }

  // ---- helpers ----

  private takeSample(): void {
    const heap = this.getUsedHeapMb();
    if (heap !== null) {
      this.samples.push(heap);
    }
  }

  private getUsedHeapMb(): number | null {
    const mem = (performance as unknown as { memory?: PerformanceMemory }).memory;
    if (mem && typeof mem.usedJSHeapSize === 'number') {
      return mem.usedJSHeapSize / (1024 * 1024);
    }
    return null;
  }

  private buildReport(): SoakReport {
    if (this.samples.length === 0) {
      return {
        startHeapMb: null,
        endHeapMb: null,
        peakHeapMb: null,
        growthMb: null,
        stabilized: false,
        withinBudget: false,
      };
    }

    const startHeapMb = this.samples[0];
    const endHeapMb = this.samples[this.samples.length - 1];
    const peakHeapMb = Math.max(...this.samples);
    const growthMb = endHeapMb - startHeapMb;

    // Stabilized: last 10 samples have < 1 MB range
    const tail = this.samples.slice(-10);
    const tailStabilized =
      tail.length >= 5 ? Math.max(...tail) - Math.min(...tail) < 1 : false;

    return {
      startHeapMb,
      endHeapMb,
      peakHeapMb,
      growthMb,
      stabilized: tailStabilized,
      withinBudget: growthMb <= this.budget.heapGrowthMaxMb,
    };
  }
}

// ---------------------------------------------------------------------------
// Aggregated reporter
// ---------------------------------------------------------------------------

/** Combined audit report covering PERF-1, PERF-2, and PERF-3. */
export interface PerformanceAuditReport {
  budget: PerformanceBudget;
  startup: StartupReport;
  frame: FrameStats;
  memory: SoakReport;
}

/**
 * Aggregated performance reporter.
 *
 * Runs a full audit (startup + frame + memory) and pretty-prints results
 * to the console. Each section references PERF-1 / PERF-2 / PERF-3.
 */
export class PerformanceReporter {
  private budget: PerformanceBudget;
  private startupMonitor: StartupMonitor;
  private frameMonitor: FrameMonitor;
  private memoryMonitor: MemoryMonitor;

  constructor(budget: PerformanceBudget = DEFAULT_BUDGET) {
    this.budget = budget;
    this.startupMonitor = new StartupMonitor();
    this.frameMonitor = new FrameMonitor(budget);
    this.memoryMonitor = new MemoryMonitor(budget);
  }

  /** Access the underlying startup monitor (to call markStart/markFCP/markReady). */
  get startup(): StartupMonitor {
    return this.startupMonitor;
  }

  /** Access the underlying frame monitor. */
  get frame(): FrameMonitor {
    return this.frameMonitor;
  }

  /** Access the underlying memory monitor. */
  get memory(): MemoryMonitor {
    return this.memoryMonitor;
  }

  /**
   * Run a full performance audit.
   *
   * - PERF-1: collects startup report (marks must have been set beforehand).
   * - PERF-2: runs a 5-second frame sampling window.
   * - PERF-3: runs a memory soak (defaults to `budget.soakDurationMs`).
   *
   * **Note:** This method is asynchronous because the frame window and
   * memory soak require elapsed wall-clock time. It resolves when all
   * three checks are complete.
   */
  async runFullAudit(): Promise<PerformanceAuditReport> {
    // PERF-1 — startup (synchronous; marks should already be recorded)
    const startup = this.startupMonitor.getReport(this.budget);

    // PERF-2 — frame sampling for 5 seconds
    const FRAME_SAMPLE_MS = 5000;
    this.frameMonitor.start();
    await delay(FRAME_SAMPLE_MS);
    this.frameMonitor.stop();
    const frame = this.frameMonitor.getStats();

    // PERF-3 — memory soak
    this.memoryMonitor.startSoak(this.budget.soakDurationMs);
    const memory = await new Promise<SoakReport>((resolve) => {
      // Check every second whether soaking has finished
      const check = window.setInterval(() => {
        if (!this.memoryMonitor['soaking']) {
          clearInterval(check);
        }
      }, 1000);

      // Resolve after full duration + small buffer
      window.setTimeout(() => {
        clearInterval(check);
        const report = this.memoryMonitor.stopSoak();
        resolve(report);
      }, this.budget.soakDurationMs + 200);
    });

    return { budget: this.budget, startup, frame, memory };
  }

  /**
   * Pretty-print the audit report to the browser console.
   *
   * Groups output by PERF-1 / PERF-2 / PERF-3 with ✓/✗ indicators.
   */
  toConsole(report: PerformanceAuditReport): void {
    const { budget, startup, frame, memory } = report;

    console.group('%c⚡ Performance Audit Report', 'font-weight:bold;font-size:14px');

    // PERF-1
    console.group(
      `%cPERF-1 Startup  ${startup.withinBudget ? '✓' : '✗'}`,
      `color:${startup.withinBudget ? 'green' : 'red'}`,
    );
    console.log(`FCP:        ${fmtMs(startup.startToFCPMs)} (budget ${budget.fcpMaxMs}ms)`);
    console.log(`Ready:      ${fmtMs(startup.startToReadyMs)} (budget ${budget.startupMaxMs}ms)`);
    if (startup.violations.length) {
      console.log('Violations:', startup.violations);
    }
    console.groupEnd();

    // PERF-2
    console.group(
      `%cPERF-2 Rendering  ${frame.withinBudget ? '✓' : '✗'}`,
      `color:${frame.withinBudget ? 'green' : 'red'}`,
    );
    console.log(`Avg frame:  ${frame.avgFrameMs.toFixed(2)}ms`);
    console.log(`P95 frame:  ${frame.p95FrameMs.toFixed(2)}ms (budget ${budget.frameBudgetMs}ms)`);
    console.log(`Max frame:  ${frame.maxFrameMs.toFixed(2)}ms`);
    console.log(`Dropped:    ${frame.droppedFrames} / ${frame.totalFrames} frames`);
    console.groupEnd();

    // PERF-3
    const memOk = memory.withinBudget && memory.stabilized;
    console.group(
      `%cPERF-3 Memory  ${memOk ? '✓' : '✗'}`,
      `color:${memOk ? 'green' : 'red'}`,
    );
    if (memory.startHeapMb !== null) {
      console.log(`Start heap: ${memory.startHeapMb.toFixed(2)} MB`);
      console.log(`End heap:   ${memory.endHeapMb !== null ? memory.endHeapMb.toFixed(2) : 'N/A'} MB`);
      console.log(`Peak heap:  ${memory.peakHeapMb !== null ? memory.peakHeapMb.toFixed(2) : 'N/A'} MB`);
      console.log(`Growth:     ${memory.growthMb !== null ? memory.growthMb.toFixed(2) : 'N/A'} MB (budget ${budget.heapGrowthMaxMb} MB)`);
      console.log(`Stabilized: ${memory.stabilized}`);
    } else {
      console.log('performance.memory unavailable (non-Chrome browser)');
    }
    console.groupEnd();

    console.groupEnd();
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function fmtMs(value: number | null): string {
  return value !== null ? `${value.toFixed(1)}ms` : 'N/A';
}
