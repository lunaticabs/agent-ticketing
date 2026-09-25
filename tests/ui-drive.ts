/**
 * ============================================================================
 *  A harness that drives the pages the way a person does
 * ============================================================================
 *
 * ── Why this exists, in one paragraph ─────────────────────────────────────
 *
 * Three bugs reached a human before anything caught them, and all three had the
 * same shape: two places held a copy of the same state and nothing asserted they
 * agreed. A React variable typed as the queue-status payload holding a health
 * response. A public base URL and a registered redirect URI on different schemes.
 * An approval id that lived in React state and did not survive a redirect to the
 * consent screen.
 *
 * Every one of them was invisible to a suite that drove the API and read JSON,
 * because the API was fine — it was the *journey* that was broken. So this
 * harness does the thing the earlier tests did not: it renders the real
 * components and clicks the real buttons, then reads the real DOM. The network
 * is stubbed, because the network already has its own coverage in `npm run e2e`;
 * what is new here is the user.
 *
 * ── The rule that keeps it from hanging ───────────────────────────────────
 *
 * Never wrap an unbounded wait in React's `act()`. `act` drains pending effects,
 * and a page that polls on an interval never finishes draining, so the call
 * blocks forever. Every wait in here is bounded, and `settle()` is the only way
 * time advances.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import type { ReactNode } from 'react';

// ── DOM ─────────────────────────────────────────────────────────────────────

/**
 * Navigation attempts are captured rather than performed.
 *
 * The console sends the browser to the consent screen with
 * `window.location.href = url`, and `window.location` is non-configurable in
 * jsdom so it cannot be wrapped. jsdom answers such an assignment with a
 * "Not implemented: navigation" error on its virtual console instead of
 * throwing — which is exactly the hook needed to assert that a control did try
 * to navigate.
 */
export const navigationAttempts: string[] = [];

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (err: Error) => {
  if (/not implemented.*navigation/i.test(err.message)) {
    navigationAttempts.push(err.message);
    return;
  }
  // Anything else is a real error in the page and should not be swallowed.
  queueMicrotask(() => {
    throw err;
  });
});

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:3000/',
  pretendToBeVisual: true,
  virtualConsole,
});

function install(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

install('window', dom.window);
install('document', dom.window.document);
install('navigator', dom.window.navigator);
install('HTMLElement', dom.window.HTMLElement);
install('HTMLInputElement', dom.window.HTMLInputElement);
install('Node', dom.window.Node);
install('Event', dom.window.Event);
install('MouseEvent', dom.window.MouseEvent);
install('CustomEvent', dom.window.CustomEvent);
install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
// Next's client runtime (request-idle-callback, use-intersection) reaches for `self`.
install('self', dom.window);
install('IS_REACT_ACT_ENVIRONMENT', true);
install('requestAnimationFrame', (cb: (t: number) => void) =>
  setTimeout(() => cb(Date.now()), 0) as unknown as number,
);
install('cancelAnimationFrame', (id: number) => clearTimeout(id));

export { dom };

// ── Network ─────────────────────────────────────────────────────────────────

interface Route {
  status?: number;
  body: unknown;
  /** Set when a handler wants to answer differently on each call. */
  once?: boolean;
}

const routes = new Map<string, Route>();
export const calls: { method: string; path: string; body: unknown }[] = [];

/**
 * Stub an endpoint. `body` may be a function, which receives the parsed request
 * body and may return a different response per call — enough to model a poll
 * that changes, without pulling in a mock server.
 */
export function stub(
  path: string,
  body: unknown | ((req: { body: unknown; call: number }) => unknown),
  status = 200,
  method: 'GET' | 'POST' | 'ANY' = 'ANY',
): void {
  if (method !== 'ANY') {
    // Keyed by method too: the transfer route answers GET (preview) and POST
    // (open / request / complete) on one path, and a method-blind map silently
    // makes one of them unreachable.
    routes.set(`${method} ${path}`, {
      status,
      body: typeof body === 'function' ? null : body,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ dynamic: typeof body === 'function' ? body : undefined } as any),
    });
    return;
  }
  const counter = { n: 0 };
  if (typeof body === 'function') {
    const fn = body as (req: { body: unknown; call: number }) => unknown;
    routes.set(path, {
      status,
      body: null,
      // Re-evaluated on every request.
      get once() {
        counter.n += 1;
        return undefined;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ dynamic: (req: unknown) => fn({ body: req, call: counter.n }) } as any),
    });
  } else {
    routes.set(path, { body, status });
  }
}

export function resetNetwork(): void {
  routes.clear();
  calls.length = 0;
}

const realFetch = globalThis.fetch;
let activeFetch: typeof fetch = realFetch;

export function installFetch(): void {
  install('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, 'http://localhost:3000');
    const path = url.pathname;
    const method = init?.method ?? (init?.body ? 'POST' : 'GET');

    let parsed: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        parsed = JSON.parse(init.body);
      } catch {
        parsed = init.body;
      }
    }
    calls.push({ method, path, body: parsed });

    const route = routes.get(`${method} ${path}`) ?? routes.get(path);
    if (!route) {
      // A missing stub is a bug in the test, and silence would hide it.
      return new Response(JSON.stringify({ ok: false, code: 'not_stubbed', message: path }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dynamic = (route as any).dynamic as
      | ((req: unknown) => unknown)
      | undefined;
    const payload = dynamic ? dynamic(parsed) : route.body;

    return new Response(JSON.stringify(payload), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch);
}

installFetch();

// ── Rendering ───────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyComponent = (props: any) => ReactNode;

export interface Screen {
  container: HTMLElement;
  /** Visible text, whitespace collapsed. */
  text(): string;
  /** All button labels currently rendered. */
  buttons(): string[];
  /** Click the first button whose text matches. Throws with the available labels if absent. */
  click(label: string | RegExp): Promise<void>;
  /** Check or uncheck a checkbox by its surrounding label text. */
  toggle(label: string | RegExp, checked: boolean): Promise<void>;
  /** Type into an input identified by its placeholder. */
  type(placeholder: string, value: string): Promise<void>;
  /** Let the page's timers run for `ms`, in bounded slices. */
  settle(ms?: number): Promise<void>;
  /** Poll the DOM until `predicate` holds. Bounded; throws rather than hanging. */
  waitFor(predicate: (screen: Screen) => boolean, what: string, timeoutMs?: number): Promise<void>;
  html(): string;
  unmount(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function render(
  Component: AnyComponent,
  props: Record<string, unknown> = {},
): Promise<Screen> {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);

  /** Bounded flush. This is the ONLY way time advances. */
  const settle = async (ms = 120): Promise<void> => {
    const slice = 25;
    for (let waited = 0; waited < ms; waited += slice) {
      await React.act(async () => {
        await sleep(Math.min(slice, ms - waited));
      });
    }
  };

  await React.act(async () => {
    root.render(React.createElement(Component, props));
  });
  await settle(30);

  const screen: Screen = {
    container,
    text: () => (container.textContent ?? '').replace(/\s+/g, ' ').trim(),
    buttons: () =>
      [...container.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()).filter(Boolean),
    html: () => container.innerHTML,

    async click(label) {
      const buttons = [...container.querySelectorAll('button')];
      const match = buttons.find((b) => {
        const text = (b.textContent ?? '').trim();
        return typeof label === 'string' ? text === label : label.test(text);
      });
      if (!match) {
        throw new Error(
          `no button matching ${String(label)}. Rendered buttons: ${JSON.stringify(screen.buttons())}`,
        );
      }
      await React.act(async () => {
        match.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      await settle(60);
    },

    async toggle(label, checked) {
      const labels = [...container.querySelectorAll('label')];
      const match = labels.find((l) =>
        typeof label === 'string'
          ? (l.textContent ?? '').includes(label)
          : label.test(l.textContent ?? ''),
      );
      const input = match?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      if (!input) throw new Error(`no checkbox near ${String(label)}`);
      if (input.checked !== checked) {
        await React.act(async () => {
          input.click();
        });
        await settle(30);
      }
    },

    async type(placeholder, value) {
      const input = container.querySelector(
        `input[placeholder="${placeholder}"]`,
      ) as HTMLInputElement | null;
      if (!input) throw new Error(`no input with placeholder "${placeholder}"`);
      // React tracks the previous value on the node; bypass its setter so the
      // synthetic change event is not swallowed.
      const setter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        'value',
      )?.set;
      await React.act(async () => {
        setter?.call(input, value);
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
      await settle(30);
    },

    settle,

    async waitFor(predicate, what, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(screen)) return;
        await settle(60);
      }
      throw new Error(
        `timed out waiting for ${what}.\n  buttons: ${JSON.stringify(screen.buttons())}\n  text: ${screen
          .text()
          .slice(0, 400)}`,
      );
    },

    async unmount() {
      await React.act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };

  return screen;
}

// ── Teardown ────────────────────────────────────────────────────────────────

export function teardown(): void {
  activeFetch = realFetch;
  install('fetch', realFetch);
  dom.window.close();
}
