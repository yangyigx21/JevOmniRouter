/**
 * SSE Event Stream & Reconnection Compensation — EVENT-3 / API-2 (§6.1, §9 design.md).
 *
 * The system SHALL provide an SSE event stream (`GET /v1/routes/:id/events`)
 * supporting `Last-Event-ID` reconnection; the loss rate SHALL be 0
 * (EVENT-3 scenario "重连补事件"). On reconnect, the server SHALL replay
 * all buffered events whose `sequence > lastSeen`.
 *
 * This module is HTTP-agnostic: it produces chunks of `text/event-stream`
 * bytes and consumes a source of RouteEvents. Concrete HTTP servers
 * (Express / Hono / Node http) wrap `createSSEStream()` to push bytes
 * to a writable.
 *
 * SSE wire format (one event):
 *
 * ```
 * id: <eventId>
 * event: <type>
 * data: <json>
 *
 * ```
 *
 * Heartbeat (comment line `:keepalive\n\n`) is sent every
 * `heartbeatMs` to keep the connection alive through proxies that
 * close idle sockets.
 */
import type { RouteEvent } from './route-event.js';
import { serializeEvent } from './route-event.js';

/** Default heartbeat interval (15s; below typical proxy idle timeouts). */
export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;
/** Default replay buffer window (number of events retained per request). */
export const DEFAULT_SSE_REPLAY_BUFFER = 1000;
/** SSE comment marker. */
const SSE_COMMENT = ':';
const SSE_FIELD_ID = 'id';
const SSE_FIELD_EVENT = 'event';
const SSE_FIELD_DATA = 'data';
const SSE_LINE_TERM = '\n';
const SSE_EVENT_TERM = '\n';

// ---------------------------------------------------------------------------
// Last-Event-ID parsing
// ---------------------------------------------------------------------------

/**
 * Parse the `Last-Event-ID` request header (EVENT-3).
 *
 * Per WHATWG spec, the value is the most recent `id:` field the client
 * received. Returns -1 when absent (client is fresh); the caller uses this
 * to compute the replay cursor.
 *
 * We accept either the eventId string OR a numeric `sequence` value as
 * Last-Event-ID. When the value is numeric we return that number directly;
 * when it is non-numeric we look up the corresponding sequence via the
 * `resolveSequence` callback (default: parse fails → -1).
 */
export function parseLastEventId(
  rawHeader: string | undefined | null,
  resolveSequence?: (eventId: string) => number | undefined,
): number {
  if (rawHeader === undefined || rawHeader === null) return -1;
  const trimmed = rawHeader.trim();
  if (trimmed === '') return -1;
  // Numeric → use directly as sequence cursor.
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && Number.isInteger(numeric) && numeric >= 0) {
    return numeric;
  }
  // Non-numeric → attempt external resolution.
  if (resolveSequence) {
    const seq = resolveSequence(trimmed);
    if (seq !== undefined && Number.isInteger(seq) && seq >= 0) return seq;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// SSE formatting
// ---------------------------------------------------------------------------

/**
 * Format a RouteEvent as an SSE chunk (bytes-ready string).
 *
 * Emits `id:` (eventId), `event:` (type), and one or more `data:` lines
 * (split on \n per the SSE spec). The chunk ends with a blank line.
 */
export function formatSSEData(event: RouteEvent): string {
  const json = serializeEvent(event);
  const dataLines = json.split(/\r?\n/).map((l) => `${SSE_FIELD_DATA}: ${l}`);
  return (
    `${SSE_FIELD_ID}: ${event.eventId}${SSE_LINE_TERM}` +
    `${SSE_FIELD_EVENT}: ${event.type}${SSE_LINE_TERM}` +
    `${dataLines.join(SSE_LINE_TERM)}${SSE_LINE_TERM}` +
    SSE_EVENT_TERM
  );
}

/** Format a heartbeat comment line. */
export function formatHeartbeat(comment: string = 'keepalive'): string {
  return `${SSE_COMMENT} ${comment}${SSE_LINE_TERM}${SSE_EVENT_TERM}`;
}

/** Format a terminal error event (closes the stream). */
export function formatSSError(message: string, eventId?: string): string {
  const parts: string[] = [];
  if (eventId) parts.push(`${SSE_FIELD_ID}: ${eventId}${SSE_LINE_TERM}`);
  parts.push(`${SSE_FIELD_EVENT}: error${SSE_LINE_TERM}`);
  parts.push(`${SSE_FIELD_DATA}: ${JSON.stringify({ message })}${SSE_LINE_TERM}`);
  parts.push(SSE_EVENT_TERM);
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Replay buffer
// ---------------------------------------------------------------------------

/**
 * Per-request replay buffer for SSE reconnection (EVENT-3).
 *
 * Keeps the last `capacity` events (by `sequence`) per `requestId` so that
 * `replay(requestId, lastSequence)` returns the events the client missed.
 */
export class SSEReplayBuffer {
  private readonly capacity: number;
  private readonly buffers = new Map<string, RouteEvent[]>();

  constructor(capacity: number = DEFAULT_SSE_REPLAY_BUFFER) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new SSEStreamError(
        'INVALID_CAPACITY',
        `capacity MUST be a positive integer; got ${String(capacity)}`,
      );
    }
    this.capacity = capacity;
  }

  /** Append an event to the per-request ring. */
  append(event: RouteEvent): void {
    let buf = this.buffers.get(event.requestId);
    if (!buf) {
      buf = [];
      this.buffers.set(event.requestId, buf);
    }
    buf.push(event);
    if (buf.length > this.capacity) {
      buf.splice(0, buf.length - this.capacity);
    }
  }

  /** Replay events with `sequence > lastSequence`, ascending. */
  replay(requestId: string, lastSequence: number): RouteEvent[] {
    const buf = this.buffers.get(requestId) ?? [];
    return buf.filter((e) => e.sequence > lastSequence).sort((a, b) => a.sequence - b.sequence);
  }

  /** Drop buffered events for a request (after route completion). */
  drop(requestId: string): void {
    this.buffers.delete(requestId);
  }

  /** Current buffer length for a request (test helper). */
  length(requestId: string): number {
    return this.buffers.get(requestId)?.length ?? 0;
  }
}

// ---------------------------------------------------------------------------
// SSE stream controller
// ---------------------------------------------------------------------------

/** Sink that consumes string chunks (e.g. a Node Writable / Response). */
export interface SSESink {
  write(chunk: string): void | Promise<void>;
  close(): void | Promise<void>;
  /** Returns false to signal backpressure (slow consumer). */
  isBackpressured?(): boolean;
}

export interface SSEStreamOptions {
  /** Per-request replay buffer (defaults to a new SSEReplayBuffer). */
  replayBuffer?: SSEReplayBuffer;
  /** Heartbeat interval in ms (0 disables). */
  heartbeatMs?: number;
  /** Maximum in-flight chunks before backpressure is asserted. */
  backpressureHighWatermark?: number;
}

/**
 * SSE stream controller (EVENT-3).
 *
 * Lifecycle:
 *  1. `createSSEStream(sink, requestId, options)` opens the stream and
 *     returns a controller.
 *  2. Caller invokes `replay(lastEventId)` to flush any buffered events
 *     the client missed; then attaches the sink to the EventBus.
 *  3. `send(event)` pushes a live event.
 *  4. `heartbeat()` MAY be called on a timer to send keepalives.
 *  5. `close()` terminates the stream (sends an `error` event then closes
 *     the sink).
 *
 * Backpressure: when the sink reports `isBackpressured()` true, the stream
 * drops heartbeat events (live events are still sent; callers SHOULD pause
 * their producer if the sink is consistently slow).
 */
export interface SSEStream {
  readonly requestId: string;
  /** Flush buffered events with `sequence > lastSequence` and return count. */
  replay(lastSequence: number): number;
  /** Send a live event. Returns false on backpressure (event still sent). */
  send(event: RouteEvent): Promise<boolean> | boolean;
  /** Send a heartbeat comment. */
  heartbeat(): Promise<void> | void;
  /** Send a terminal error and close the stream. */
  closeWithError(message: string): Promise<void> | void;
  /** Graceful close. */
  close(): Promise<void> | void;
  /** True once `close()` / `closeWithError()` has been invoked. */
  isClosed(): boolean;
}

/**
 * Create an SSE stream controller backed by the given sink.
 *
 * Does NOT subscribe to the EventBus automatically — the caller wires that
 * up so that the SSE controller can be unit-tested in isolation.
 */
export function createSSEStream(
  sink: SSESink,
  requestId: string,
  options: SSEStreamOptions = {},
): SSEStream {
  const replayBuffer = options.replayBuffer ?? new SSEReplayBuffer();
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS;
  const highWatermark = options.backpressureHighWatermark ?? 256;
  let closed = false;
  let inFlight = 0;

  const assertOpen = (): void => {
    if (closed) throw new SSEStreamError('STREAM_CLOSED', 'SSE stream is closed');
  };

  const writeChunk = async (chunk: string): Promise<boolean> => {
    if (closed) return false;
    inFlight += 1;
    try {
      await sink.write(chunk);
    } finally {
      inFlight -= 1;
    }
    const backpressured =
      (typeof sink.isBackpressured === 'function' && sink.isBackpressured()) ||
      inFlight >= highWatermark;
    return !backpressured;
  };

  const stream: SSEStream = {
    requestId,
    replay(lastSequence: number): number {
      assertOpen();
      const events = replayBuffer.replay(requestId, lastSequence);
      for (const ev of events) {
        // Synchronous write path for replay (buffered in-process).
        sink.write(formatSSEData(ev));
      }
      return events.length;
    },
    async send(event: RouteEvent): Promise<boolean> {
      assertOpen();
      // Buffer for future reconnects (EVENT-3).
      replayBuffer.append(event);
      return writeChunk(formatSSEData(event));
    },
    async heartbeat(): Promise<void> {
      if (closed) return;
      if (heartbeatMs <= 0) return;
      // Drop heartbeat under backpressure (PERF-2 frame budget).
      if (typeof sink.isBackpressured === 'function' && sink.isBackpressured()) return;
      await sink.write(formatHeartbeat());
    },
    async closeWithError(message: string): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await sink.write(formatSSError(message));
      } finally {
        await sink.close();
        replayBuffer.drop(requestId);
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await sink.write(formatHeartbeat('stream-end'));
      } finally {
        await sink.close();
        replayBuffer.drop(requestId);
      }
    },
    isClosed(): boolean {
      return closed;
    },
  };
  return stream;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SSEStreamErrorCode = 'STREAM_CLOSED' | 'INVALID_CAPACITY' | 'INVALID_HEADER';

export class SSEStreamError extends Error {
  constructor(
    readonly code: SSEStreamErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'SSEStreamError';
  }
}
