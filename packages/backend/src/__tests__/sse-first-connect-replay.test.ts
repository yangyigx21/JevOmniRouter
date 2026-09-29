/**
 * SSE 首连全量补发 + 重连游标解析测试（EVENT-3）。
 *
 * 回归缺陷：服务端此前只在 `Last-Event-ID >= 0` 时补发事件，而浏览器
 * `EventSource` 首次连接不携带该头 —— 于是 POST /v1/routes 响应回来之前
 * 已推送的事件（含全部 `MODEL_STREAMING` 增量）永久丢失，前端「结果」区空白。
 *
 * 修复：首连（无游标）按 `sequence > -1` 全量补发；带游标重连时把 SSE `id:`
 * 里的 eventId 解析回 sequence，避免重复补发。
 */
import { describe, it, expect } from 'vitest';
import { EventBus } from '../route-event.js';
import { parseLastEventId } from '../sse-stream.js';

/** 复刻 server.ts 中 `/v1/routes/:id/events` 的游标解析逻辑。 */
function resolveCursor(
  rawLastEventId: string | undefined,
  bus: EventBus,
  requestId: string,
): number {
  const hasCursor = typeof rawLastEventId === 'string' && rawLastEventId.trim() !== '';
  return hasCursor
    ? parseLastEventId(rawLastEventId, (eventId) =>
        bus.getEvents(requestId).find((e) => e.eventId === eventId)?.sequence,
      )
    : -1;
}

function seed(bus: EventBus, requestId: string): void {
  bus.emit({ requestId, type: 'ROUTE_CREATED', payload: { promptSummary: 'p' } });
  bus.emit({ requestId, type: 'EXPERIENCE_RETRIEVED', payload: { sampleCount: 0 } });
  bus.emit({ requestId, type: 'JEV_CALL_STARTED', payload: {} });
  bus.emit({ requestId, type: 'MODEL_STREAMING', payload: { modelId: 'm1', delta: 'O' } });
  bus.emit({ requestId, type: 'MODEL_STREAMING', payload: { modelId: 'm1', delta: 'K' } });
  bus.emit({ requestId, type: 'MODEL_COMPLETED', payload: { modelId: 'm1', result: 'OK' } });
}

describe('SSE 首连游标', () => {
  it('无 Last-Event-ID → 游标 -1 → 全量补发', () => {
    const bus = new EventBus();
    seed(bus, 'r1');
    const cursor = resolveCursor(undefined, bus, 'r1');
    expect(cursor).toBe(-1);
    expect(bus.replaySince('r1', cursor)).toHaveLength(6);
  });

  it('空字符串视同无游标', () => {
    const bus = new EventBus();
    seed(bus, 'r1');
    expect(resolveCursor('   ', bus, 'r1')).toBe(-1);
  });

  it('首连补发包含全部 MODEL_STREAMING 增量', () => {
    const bus = new EventBus();
    seed(bus, 'r1');
    const replayed = bus.replaySince('r1', resolveCursor(undefined, bus, 'r1'));
    const text = replayed
      .filter((e) => e.type === 'MODEL_STREAMING')
      .map((e) => e.payload.delta as string)
      .join('');
    expect(text).toBe('OK');
  });
});

describe('SSE 重连游标', () => {
  it('eventId 游标解析为对应 sequence，只补后续事件', () => {
    const bus = new EventBus();
    seed(bus, 'r1');
    const all = bus.getEvents('r1');
    const cursorEventId = all[2].eventId; // sequence = 2
    const cursor = resolveCursor(cursorEventId, bus, 'r1');
    expect(cursor).toBe(2);
    const replayed = bus.replaySince('r1', cursor);
    expect(replayed).toHaveLength(3);
    expect(replayed.every((e) => e.sequence > 2)).toBe(true);
  });

  it('游标指向最后一条事件时补发 0 条（不重复）', () => {
    const bus = new EventBus();
    seed(bus, 'r1');
    const last = bus.getEvents('r1').at(-1)!;
    expect(bus.replaySince('r1', resolveCursor(last.eventId, bus, 'r1'))).toHaveLength(0);
  });

  it('数字游标直接作为 sequence 使用', () => {
    const bus = new EventBus();
    seed(bus, 'r1');
    expect(resolveCursor('3', bus, 'r1')).toBe(3);
    expect(bus.replaySince('r1', 3)).toHaveLength(2);
  });

  it('未知 eventId 回落到全量补发（宁可重发也不丢）', () => {
    const bus = new EventBus();
    seed(bus, 'r1');
    expect(resolveCursor('evt-does-not-exist', bus, 'r1')).toBe(-1);
    expect(bus.replaySince('r1', -1)).toHaveLength(6);
  });
});
