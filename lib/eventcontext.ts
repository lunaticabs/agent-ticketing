/**
 * ============================================================================
 *  Which event is *this request* about — carried ambiently, so nothing has to
 *  thread it by hand.
 * ============================================================================
 *
 * The demo was written for one event and said so out loud: `primaryEvent()` means
 * "the event", and roughly forty call sites rely on that (`lib/humans.ts`).
 * Making every visitor their own event therefore has two possible shapes:
 *
 *   ① thread an `eventId` argument through every function that touches an event;
 *   ② establish the event once, at the edge of the request, and let the existing
 *      call sites keep asking "which event?" and get the right answer.
 *
 * ② is the one taken here. `middleware.ts` resolves a visitor's event and puts it
 * in an `AsyncLocalStorage` store; `primaryEvent()` reads that store first and
 * falls back to "the only event" when there is no store. That means:
 *
 *   · no route handler, library function, or test had to change shape;
 *   · every caller that *does* pass an explicit `eventId` still wins, because
 *     explicit arguments are resolved before this store is ever consulted;
 *   · a process with no HTTP request at all — `npm run seed`, `npm run bots`,
 *     the test suite — sees no store and behaves exactly as before.
 *
 * The store is per-request, and `AsyncLocalStorage` survives every `await`
 * inside that request. That is the whole reason this works in a Next.js route
 * handler rather than leaking between concurrent visitors.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

interface EventScope {
  eventId: string;
  /** `sandbox` — a visitor's private event. `seed` — the event `npm run seed` made. */
  kind: 'sandbox' | 'seed';
}

const storage = new AsyncLocalStorage<EventScope>();

/** Run `fn` with `eventId` as the ambient event. */
export function runWithEvent<T>(scope: EventScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** The ambient event, or null outside a request that established one. */
export function currentEventScope(): EventScope | null {
  return storage.getStore() ?? null;
}

/** The ambient event id, or null. */
export function currentEventId(): string | null {
  return storage.getStore()?.eventId ?? null;
}
