'use client';

/**
 * Shared UI primitives and the two hooks every screen needs.
 *
 * `usePoll` and `post` exist so that no page invents its own fetch/error
 * handling: every failure the API produces is already a structured
 * `{ ok:false, code, message, invariant }`, and it should always be rendered the
 * same way. Showing the *invariant* next to the refusal is what turns a demo
 * error message into an argument.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface ReasonBody {
  ok: false;
  code: string;
  message: string;
  invariant?: string;
  hint?: string;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly body: ReasonBody;
  readonly status: number;
  constructor(body: ReasonBody, status: number) {
    super(body.message);
    this.body = body;
    this.status = status;
  }
}

/** POST/GET helper that turns every refusal into an `ApiError` with the full body. */
export async function call<T = unknown>(
  url: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json: payload, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    method: rest.method ?? (payload ? 'POST' : 'GET'),
    headers: {
      ...(payload ? { 'content-type': 'application/json' } : {}),
      ...(rest.headers ?? {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { ok: false, code: 'bad_response', message: text.slice(0, 300) };
  }
  if (!res.ok) throw new ApiError(body as ReasonBody, res.status);
  return body as T;
}

/**
 * Poll an endpoint on an interval. Failures are surfaced, not swallowed.
 *
 * `initial` lets a server component hand over a first frame, so a projector
 * shows real numbers immediately instead of a "connecting…" placeholder while
 * the first poll is in flight. The interval then takes over as normal.
 */
export function usePoll<T>(url: string, intervalMs = 1000, initial: T | null = null) {
  const [data, setData] = useState<T | null>(initial);
  const [error, setError] = useState<ApiError | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await call<T>(url);
      if (mounted.current) {
        setData(next);
        setError(null);
      }
    } catch (err) {
      if (mounted.current) setError(err as ApiError);
    }
  }, [url]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), intervalMs);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh, intervalMs]);

  return { data, error, refresh };
}

/** Seconds remaining, recomputed locally against the server's clock offset. */
export function useCountdown(target: number | null | undefined, serverNow: number | null) {
  const offset = serverNow ? serverNow - Date.now() : 0;
  const [, tick] = useState(0);

  useEffect(() => {
    if (target == null) return;
    const timer = setInterval(() => tick((n) => n + 1), 200);
    return () => clearInterval(timer);
  }, [target]);

  if (target == null) return null;
  const remaining = target - (Date.now() + offset);
  return Math.max(0, remaining);
}

export function formatSeconds(ms: number | null): string {
  if (ms == null) return '—';
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

export function relative(at: number | null | undefined, serverNow?: number | null): string {
  if (!at) return '—';
  const now = Date.now() + (serverNow ? serverNow - Date.now() : 0);
  const delta = Math.round((now - at) / 1000);
  if (delta < 0) return `in ${-delta}s`;
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  return `${Math.floor(delta / 3600)}h ago`;
}

// ── Presentational bits ─────────────────────────────────────────────────────

export function Card({
  title,
  right,
  children,
  className = '',
}: {
  title?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 ${className}`}
    >
      {(title || right) && (
        <header className="mb-3 flex items-baseline justify-between gap-3">
          {title && (
            <h2 className="text-xs font-semibold tracking-[0.16em] text-[var(--color-muted)] uppercase">
              {title}
            </h2>
          )}
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

const TONES = {
  neutral: 'bg-[var(--color-panel-2)] text-[var(--color-muted)] border-[var(--color-line)]',
  live: 'bg-[color-mix(in_srgb,var(--color-live)_16%,transparent)] text-[var(--color-live)] border-[color-mix(in_srgb,var(--color-live)_40%,transparent)]',
  warn: 'bg-[color-mix(in_srgb,var(--color-warn)_16%,transparent)] text-[var(--color-warn)] border-[color-mix(in_srgb,var(--color-warn)_40%,transparent)]',
  alert:
    'bg-[color-mix(in_srgb,var(--color-alert)_16%,transparent)] text-[var(--color-alert)] border-[color-mix(in_srgb,var(--color-alert)_40%,transparent)]',
  brand:
    'bg-[color-mix(in_srgb,var(--color-brand)_16%,transparent)] text-[var(--color-brand)] border-[color-mix(in_srgb,var(--color-brand)_40%,transparent)]',
  violet:
    'bg-[color-mix(in_srgb,var(--color-violet)_16%,transparent)] text-[var(--color-violet)] border-[color-mix(in_srgb,var(--color-violet)_40%,transparent)]',
} as const;

export type Tone = keyof typeof TONES;

export function Badge({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-semibold tracking-wide ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  tone = 'neutral',
  size = 'md',
  className = '',
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: Tone;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  title?: string;
}) {
  const sizes = {
    sm: 'px-2.5 py-1 text-xs',
    md: 'px-3.5 py-2 text-sm',
    lg: 'px-5 py-3 text-base',
  } as const;
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${TONES[tone]} ${sizes[size]} hover:brightness-125 ${className}`}
    >
      {children}
    </button>
  );
}

/** A refusal, rendered with the invariant it protects. */
export function Refusal({ error, onDismiss }: { error: ApiError | ReasonBody | null; onDismiss?: () => void }) {
  if (!error) return null;
  const body: ReasonBody = 'body' in error ? error.body : error;
  return (
    <div className="rounded-lg border border-[color-mix(in_srgb,var(--color-alert)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-alert)_10%,transparent)] p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Badge tone="alert">REFUSED</Badge>
            <code className="mono text-xs text-[var(--color-alert)]">{body.code}</code>
          </div>
          <p className="mt-2 text-[var(--color-text)]">{body.message}</p>
          {body.invariant && (
            <p className="mt-1 text-xs text-[var(--color-warn)]">{body.invariant}</p>
          )}
          {body.hint && <p className="mt-1 text-xs text-[var(--color-muted)]">{body.hint}</p>}
        </div>
        {onDismiss && (
          <button type="button" onClick={onDismiss} className="text-xs text-[var(--color-muted)] hover:text-white">
            dismiss
          </button>
        )}
      </div>
    </div>
  );
}

export function Notice({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: Tone;
}) {
  return (
    <div className={`rounded-lg border p-3 text-sm ${TONES[tone]}`}>{children}</div>
  );
}

/** The permanent banner shown whenever the local IdP fallback is in use. */
export function DegradedBanner({ mode }: { mode: string }) {
  if (mode !== 'local') return null;
  return (
    <div className="border-b border-[color-mix(in_srgb,var(--color-warn)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-warn)_12%,transparent)] px-4 py-2 text-center text-xs text-[var(--color-warn)]">
      <strong>LOCAL IDP FALLBACK.</strong> No portal-issued OIDC credentials, so identity is
      simulated by <code className="mono">worldid/local.ts</code>. Every authorization check is
      still real: binding, freshness, one-time consumption. See{' '}
      <code className="mono">SPIKE_NOTES.md</code> (S-2).
    </div>
  );
}
