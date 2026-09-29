/**
 * Unit tests for the MCP server's protocol glue: the SSE parser and the
 * event→outcome summarizer. These are deterministic and need no network.
 *
 * The wire format mirrors `packages/backend/src/sse-stream.ts::formatSSEData`:
 *
 *   id: <eventId>
 *   event: <type>
 *   data: <json>
 *
 * (blank line)
 */
import { describe, expect, it } from 'vitest';
import { parseSSE, summarize, type RouteEvent } from '../backend-client.js';

/** Build the exact byte stream the backend would emit for `events`. */
function toSSEStream(events: RouteEvent[]): ReadableStream<Uint8Array> {
  const chunks = events.map(
    (e) =>
      `id: ${e.eventId}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`,
  );
  // Two TCP-ish chunks to exercise cross-chunk buffering.
  const mid = Math.ceil(chunks.length / 2);
  const parts = [chunks.slice(0, mid).join(''), chunks.slice(mid).join('')];
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= parts.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(parts[i++]));
    },
  });
}

function evt(
  type: string,
  sequence: number,
  payload: Record<string, unknown>,
  extra?: { decisionId?: string; executionId?: string },
): RouteEvent {
  return {
    eventId: `evt-${sequence}`,
    requestId: 'req-test',
    type,
    timestamp: '2026-10-10T00:00:00.000Z',
    sequence,
    payload,
    ...(extra?.decisionId ? { decisionId: extra.decisionId } : {}),
    ...(extra?.executionId ? { executionId: extra.executionId } : {}),
  };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<RouteEvent[]> {
  const out: RouteEvent[] = [];
  for await (const e of parseSSE(stream)) out.push(e);
  return out;
}

describe('parseSSE', () => {
  it('parses events split across chunk boundaries', async () => {
    const events = [
      evt('ROUTE_CREATED', 0, { promptSummary: 'hi' }),
      evt('MODEL_SELECTED', 1, { modelId: 'gpt-6-sol' }),
      evt('MODEL_COMPLETED', 2, { modelId: 'gpt-6-sol', result: 'ok' }),
    ];
    const parsed = await collect(toSSEStream(events));
    expect(parsed.map((e) => e.type)).toEqual([
      'ROUTE_CREATED',
      'MODEL_SELECTED',
      'MODEL_COMPLETED',
    ]);
    expect(parsed[2].payload.result).toBe('ok');
  });

  it('ignores heartbeat comments and non-data fields', async () => {
    const encoder = new TextEncoder();
    const raw =
      ': keepalive\n\n' +
      'id: evt-1\nevent: MODEL_COMPLETED\ndata: {"eventId":"evt-1","requestId":"r","type":"MODEL_COMPLETED","timestamp":"t","sequence":1,"payload":{}}\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(raw));
        c.close();
      },
    });
    const parsed = await collect(stream);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].type).toBe('MODEL_COMPLETED');
  });

  it('skips malformed JSON data blocks without throwing', async () => {
    const encoder = new TextEncoder();
    const raw =
      'event: X\ndata: {not json}\n\n' +
      'event: MODEL_COMPLETED\ndata: {"eventId":"e","requestId":"r","type":"MODEL_COMPLETED","timestamp":"t","sequence":1,"payload":{}}\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(raw));
        c.close();
      },
    });
    const parsed = await collect(stream);
    expect(parsed.map((e) => e.type)).toEqual(['MODEL_COMPLETED']);
  });
});

describe('summarize', () => {
  it('folds a successful route into a COMPLETED outcome', () => {
    const events = [
      evt('ROUTE_CREATED', 0, {}),
      evt('CONSTRAINT_FILTERED', 1, {
        excludedModelIds: ['glm-5.2'],
        reason: { 'glm-5.2': 'CONTEXT_LIMIT_EXCEEDED' },
        remainingCount: 5,
      }),
      evt(
        'JEV_DECISION_READY',
        2,
        {
          confidence: 1,
          calibratedConfidence: 1,
          routeTier: 'ROUTE',
          thresholds: { high: 0.82, mid: 0.6 },
          decisionSource: 'TYPE_SAFE_JEV',
          rationale: 'intent code matched',
          winnerReason: 'intentMatch',
          answers: [{ tag: 'INTENT', type: 'choice', value: 'code' }],
          candidateScores: [
            { modelId: 'gpt-6-sol', raw: 1.2, probability: 0.07, rankIndex: 0, priorDelta: 0.063 },
          ],
          priorDeltas: [0.063],
        },
        { decisionId: 'dec-1' },
      ),
      evt('MODEL_SELECTED', 3, { modelId: 'gpt-6-sol', selectionMode: 'TYPE_SAFE_JEV' }),
      evt('MODEL_STREAMING', 4, { modelId: 'gpt-6-sol', delta: 'hel' }),
      evt('MODEL_STREAMING', 5, { modelId: 'gpt-6-sol', delta: 'lo' }),
      evt(
        'MODEL_COMPLETED',
        6,
        {
          modelId: 'gpt-6-sol',
          latencyMs: 1234,
          promptTokens: 10,
          completionTokens: 2,
          costUsd: 0.0001,
          usageSource: 'provider',
          result: 'hello',
        },
        { decisionId: 'dec-1', executionId: 'exec-1' },
      ),
    ];
    const o = summarize('req-test', events, 'hello');
    expect(o.status).toBe('COMPLETED');
    expect(o.tier).toBe('ROUTE');
    expect(o.confidence).toBe(1);
    expect(o.selectedModelId).toBe('gpt-6-sol');
    expect(o.decisionId).toBe('dec-1');
    expect(o.executionId).toBe('exec-1');
    expect(o.result).toBe('hello');
    expect(o.eliminated).toEqual([
      { modelId: 'glm-5.2', reason: 'CONTEXT_LIMIT_EXCEEDED' },
    ]);
    expect(o.usage?.latencyMs).toBe(1234);
    expect(o.jevAnswers).toHaveLength(1);
    expect(o.thresholds).toEqual({ high: 0.82, mid: 0.6 });
  });

  it('marks a route ESCALATED when no completion follows the escalation', () => {
    const events = [
      evt(
        'JEV_DECISION_READY',
        0,
        { confidence: 0.41, routeTier: 'ESCALATE' },
        { decisionId: 'dec-2' },
      ),
      evt('ROUTE_ESCALATED', 1, { reason: 'low_confidence', escalateTo: 'fallback_model' }),
    ];
    const o = summarize('req-test', events, '');
    expect(o.status).toBe('ESCALATED');
    expect(o.escalationReason).toBe('low_confidence');
  });

  it('prefers the terminal result over partial streamed text', () => {
    const events = [
      evt('MODEL_STREAMING', 0, { delta: 'partial' }),
      evt('MODEL_COMPLETED', 1, { modelId: 'm', result: 'the full answer' }),
    ];
    const o = summarize('req-test', events, 'partial');
    expect(o.result).toBe('the full answer');
  });

  it('falls back to streamed text when the terminal event has no result', () => {
    const events = [
      evt('MODEL_STREAMING', 0, { delta: 'abc' }),
      evt('MODEL_COMPLETED', 1, { modelId: 'm', latencyMs: 5 }),
    ];
    const o = summarize('req-test', events, 'abc');
    expect(o.result).toBe('abc');
  });

  it('marks a failed route FAILED and surfaces the error', () => {
    const events = [
      evt('ROUTE_FAILED', 0, { reason: 'provider_error', message: 'boom' }),
    ];
    const o = summarize('req-test', events, '');
    expect(o.status).toBe('FAILED');
    expect(o.errorReason).toBe('provider_error');
    expect(o.errorMessage).toBe('boom');
  });
});
