/**
 * A tiny HTTP client for the agent process.
 *
 * Deliberately dumb: cookies for the browser-style flow, a bearer token for the
 * headless flow, and every error surfaced as the server's structured refusal body
 * rather than a generic throw. The agent's whole job is to relay those reasons
 * to a terminal that a room full of people is reading.
 */
export interface Refusal {
  ok: false;
  code: string;
  message: string;
  invariant?: string;
  hint?: string;
  details?: Record<string, unknown>;
}

export class AgentHttpError extends Error {
  readonly status: number;
  readonly body: Refusal;
  constructor(status: number, body: Refusal) {
    super(body.message ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export class AgentClient {
  private cookies = new Map<string, string>();
  private bearer: string | null = null;

  constructor(readonly baseUrl: string) {}

  setBearer(token: string): void {
    this.bearer = token;
  }

  async call<T>(
    path: string,
    opts: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: opts.method ?? (opts.body ? 'POST' : 'GET'),
        headers: {
          ...(opts.body ? { 'content-type': 'application/json' } : {}),
          ...(this.bearer ? { authorization: `Bearer ${this.bearer}` } : {}),
          ...(this.cookies.size
            ? { cookie: [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ') }
            : {}),
        },
        ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
        signal: controller.signal,
        redirect: 'manual',
      });

      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const idx = pair.indexOf('=');
        if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }

      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { ok: false, code: 'bad_response', message: text.slice(0, 400) };
      }

      if (!res.ok) throw new AgentHttpError(res.status, body as Refusal);
      return body as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
