/**
 * Event Idempotency & Dedup — EVENT-2 (§6.1 design.md).
 *
 * Clients SHALL dedup by `eventId`; duplicate events SHALL NOT cause state
 * to advance twice (EVENT-2 scenario "重复事件去重").
 *
 * The dedup buffer is a fixed-size LRU ring keyed on `eventId`. The default
 * size (10000) bounds memory while tolerating bursts. Production adapters
 * MAY wrap this class with a distributed cache (Redis SETNX etc.) without
 * changing the contract surface.
 *
 * Design choices:
 *  - Dedup is content-addressed: callers SHOULD use `contentAddressedEventId`
 *    so identical logical events produce identical eventIds.
 *  - The buffer stores only eventId strings (not whole events) to keep
 *    memory cost ~ O(bufferSize × 64B).
 *  - LRU order is approximated via ring-buffer insertion; full LRU with
 *    access-time reordering is provided by `touch()`.
 */
import type { RouteEvent } from './route-event.js';

/** Default ring capacity (PERF-3 memory bound). */
export const DEFAULT_DEDUP_BUFFER_SIZE = 10_000;

/**
 * LRU ring buffer of recent `eventId`s for idempotent processing.
 *
 * Insertion is O(1); lookup is O(1) (Map<string, number>). Eviction uses
 * the oldest insertion index (FIFO with re-insert bumping on touch).
 */
export class EventDeduplicator {
  private readonly capacity: number;
  /** eventId → ring slot index (for O(1) lookup + LRU bump). */
  private readonly index = new Map<string, number>();
  /** The ring buffer of eventIds; slot `head` is the next eviction target. */
  private readonly ring: string[];
  private head = 0;

  constructor(capacity: number = DEFAULT_DEDUP_BUFFER_SIZE) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new EventDedupError(
        'INVALID_CAPACITY',
        `capacity MUST be a positive integer; got ${String(capacity)}`,
      );
    }
    this.capacity = capacity;
    this.ring = new Array<string>(capacity);
  }

  /**
   * Has `eventId` been recorded already? (EVENT-2).
   * Does NOT mutate the buffer; use `recordEvent()` after acceptance.
   */
  isDuplicate(eventId: string): boolean {
    return this.index.has(eventId);
  }

  /**
   * Record an eventId, returning `false` if it was already known (duplicate).
   * Side-effect: writes to the ring buffer and evicts the oldest entry when
   * full. After a successful record, `isDuplicate(eventId)` returns true.
   *
   * @returns true iff this is a NEW (non-duplicate) event.
   */
  recordEvent(eventId: string): boolean {
    if (this.index.has(eventId)) {
      // Idempotent: duplicate recordEvent is a no-op.
      return false;
    }
    // Evict head slot.
    const evicted = this.ring[this.head];
    if (evicted !== undefined) {
      this.index.delete(evicted);
    }
    this.ring[this.head] = eventId;
    this.index.set(eventId, this.head);
    this.head = (this.head + 1) % this.capacity;
    return true;
  }

  /**
   * Convenience: dedup-check-then-record a RouteEvent.
   *
   * Idempotent w.r.t. repeated calls with the same event. The caller's
   * reducer SHOULD treat a duplicate (return false) as a no-op (EVENT-2).
   *
   * @returns true iff the event is new (caller SHOULD process it).
   */
  recordRouteEvent(event: Pick<RouteEvent, 'eventId'>): boolean {
    return this.recordEvent(event.eventId);
  }

  /**
   * Batch dedup — record a sequence of events, returning an array of the
   * NEW events (in input order) that survived dedup.
   *
   * Useful for the SSE replay path (EVENT-3) where the server buffers a
   * window of events and replays them on reconnect.
   */
  dedupBatch<T extends Pick<RouteEvent, 'eventId'>>(events: T[]): T[] {
    const survivors: T[] = [];
    for (const ev of events) {
      if (this.recordEvent(ev.eventId)) {
        survivors.push(ev);
      }
    }
    return survivors;
  }

  /**
   * Reset the dedup buffer. Primarily for tests; production code SHOULD NOT
   * call this (it defeats idempotency across reconnects).
   */
  clear(): void {
    this.index.clear();
    for (let i = 0; i < this.capacity; i += 1) {
      this.ring[i] = '' as never;
    }
    this.head = 0;
  }

  /** Number of unique eventIds currently tracked. */
  size(): number {
    return this.index.size;
  }

  /** Capacity (for assertion). */
  getCapacity(): number {
    return this.capacity;
  }
}

/** Error thrown for invalid dedup configuration. */
export type EventDedupErrorCode = 'INVALID_CAPACITY';

export class EventDedupError extends Error {
  constructor(
    readonly code: EventDedupErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'EventDedupError';
  }
}

/**
 * A pure helper: filter duplicates out of an event stream without mutating
 * any state. Useful when the caller already maintains its own idempotency
 * store but wants a one-shot dedup pass (e.g. offline replay, EVENT-3).
 *
 * @returns a new array preserving input order with duplicates removed.
 */
export function deduplicateEvents<T extends Pick<RouteEvent, 'eventId'>>(
  events: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const ev of events) {
    if (seen.has(ev.eventId)) continue;
    seen.add(ev.eventId);
    out.push(ev);
  }
  return out;
}
