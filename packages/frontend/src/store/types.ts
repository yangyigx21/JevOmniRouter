/**
 * RouteEvent types — EVENT-1 (T-5.1).
 *
 * 12 event types per design.md §6.1 / ANIM-6.
 * Sequence monotonically increasing per request.
 */

export type RouteEventType =
  | 'ROUTE_CREATED'
  | 'EXPERIENCE_RETRIEVED'
  | 'JEV_CALL_STARTED'
  | 'JEV_DECISION_READY'
  | 'JEV_FALLBACK'
  | 'CONSTRAINT_FILTERED'
  | 'MODEL_CALL_STARTED'
  | 'MODEL_SELECTED'
  | 'MODEL_STREAMING'
  | 'MODEL_COMPLETED'
  | 'EXPERIENCE_SAVED'
  | 'CONSTRAINT_GATE_PASSED'
  | 'ROUTE_ESCALATED'
  | 'ROUTE_FAILED';

export interface RouteEvent {
  eventId: string;
  requestId: string;
  decisionId?: string;
  executionId?: string;
  type: RouteEventType;
  timestamp: string;
  sequence: number;
  payload: Record<string, unknown>;
}

export interface RouteEventStream {
  events: RouteEvent[];
  lastEventId: string | null;
}
