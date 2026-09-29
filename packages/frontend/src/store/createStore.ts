/**
 * createStore — ARCH-1 / ARCH-3 (T-6.2).
 *
 * Single state tree + pure reducer + subscription.
 * Animation clock is decoupled: animation progress SHALL NOT write to persistent state.
 *
 * Ported from jev-demo.html's vanilla JS createStore,
 * adapted to Vue 3 reactivity.
 */
import { reactive, readonly, type DeepReadonly } from 'vue';

export type Reducer<S, A> = (state: S, action: A) => S;

export interface Store<S, A> {
  state: DeepReadonly<S>;
  dispatch: (action: A) => void;
  subscribe: (listener: (state: S, action: A) => void) => () => void;
  getState: () => S;
}

/**
 * Create a Redux-pattern store with Vue 3 reactive state.
 *
 * - Pure reducer: same input → same output (ARCH-1).
 * - Render layer SHALL NOT directly mutate state; only via dispatch (ARCH-1).
 * - State container is decoupled from animation clock (ARCH-3).
 */
export function createStore<S extends object, A>(
  initialState: S,
  reducer: Reducer<S, A>,
): Store<S, A> {
  const state = reactive({ ...initialState }) as S;
  const listeners = new Set<(state: S, action: A) => void>();

  let current: S = state;

  function getState(): S {
    return current;
  }

  function dispatch(action: A): void {
    const prev = current;
    const next = reducer(prev, action);
    // Shallow merge into reactive proxy for Vue reactivity
    if (next !== prev) {
      Object.assign(state, next);
      current = state;
    }
    for (const listener of listeners) {
      listener(current, action);
    }
  }

  function subscribe(listener: (state: S, action: A) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    state: readonly(state) as DeepReadonly<S>,
    dispatch,
    subscribe,
    getState,
  };
}
