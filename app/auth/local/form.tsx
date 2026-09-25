'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Refusal, call, type ReasonBody } from '../../_components/ui';

/**
 * The approve form.
 *
 * Note the two checkboxes. They are not decoration — they are how T-3.2 is
 * demonstrated without waiting an hour:
 *
 *   · "old session" mints an assertion whose `auth_time` is an hour in the past,
 *     so the freshness check has something real to refuse. A gate that accepted
 *     it would be accepting a session established long before the slot existed.
 *   · "deny" exercises the failure path, where the slot must defer rather than
 *     execute.
 */
/**
 * The routing shell. Same reasoning as the transfer page: `useRouter` needs a
 * mounted Next router, so the form itself takes a `navigate` function and the
 * shell supplies the real one.
 */
export default function LocalApproveForm(props: Omit<ApproveFormProps, 'navigate'>) {
  const router = useRouter();
  return <ApproveForm {...props} navigate={(href) => router.push(href)} />;
}

export interface ApproveFormProps {
  requestId: string;
  intent: string;
  existingHandle: string | null;
  navigate: (href: string) => void;
}

export function ApproveForm({ requestId, intent, existingHandle, navigate }: ApproveFormProps) {
  const [handle, setHandle] = useState(existingHandle ? '' : 'alice');
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReasonBody | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const isLink = intent === 'link';

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      const result = await call<{ ok: true; continuityId: string; degraded: boolean; note: string }>(
        '/api/auth/local',
        { json: { requestId, handle, stale } },
      );
      setDone(result.continuityId);
      if (isLink) {
        navigate('/?linked=1');
      } else {
        setTimeout(() => navigate('/'), 1200);
      }
    } catch (err) {
      setError((err as { body: ReasonBody }).body);
    } finally {
      setBusy(false);
    }
  }

  async function deny() {
    setBusy(true);
    setError(null);
    try {
      await call('/api/auth/deny', { json: { requestId, reason: 'denied by the human' } });
      setDone('denied');
      setTimeout(() => navigate('/'), 800);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="mt-6 rounded-xl border border-[color-mix(in_srgb,var(--color-live)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-live)_10%,transparent)] p-4">
        <Badge tone="live">submitted</Badge>
        <p className="mt-2 text-sm">
          {done === 'denied'
            ? 'Not approved. The action will not execute and the slot will defer when its window closes.'
            : 'The server now verifies the proof itself — binding, freshness and one-time use.'}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-4">
      {isLink && (
        <label className="block">
          <span className="text-xs font-semibold tracking-[0.16em] text-[var(--color-muted)] uppercase">
            your handle
          </span>
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="alice"
            className="mono mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] px-3 py-2 outline-none focus:border-[var(--color-brand)]"
          />
          <span className="mt-1 block text-xs text-[var(--color-muted)]">
            Simulates the World App account. The same handle always resolves to the same continuity
            id — that stability is what the whole audit trail hangs on.
          </span>
        </label>
      )}

      {!isLink && (
        <label className="flex items-start gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] p-3">
          <input
            type="checkbox"
            checked={stale}
            onChange={(e) => setStale(e.target.checked)}
            className="mt-1"
          />
          <span className="text-sm">
            <strong>Simulate an old session</strong>
            <span className="block text-xs text-[var(--color-muted)]">
              Mints an assertion with <code className="mono">auth_time</code> an hour in the past.
              The gate must refuse it as <code className="mono">not_fresh</code> — that is the
              difference between &ldquo;you logged in once&rdquo; and &ldquo;you are here now&rdquo;.
            </span>
          </span>
        </label>
      )}

      {error && <Refusal error={error} onDismiss={() => setError(null)} />}

      <div className="flex gap-3">
        <Button tone="live" size="lg" onClick={approve} disabled={busy || (isLink && !handle.trim())}>
          {busy ? 'working…' : stale ? 'Approve with an old session' : 'Approve'}
        </Button>
        <Button tone="alert" size="lg" onClick={deny} disabled={busy}>
          Deny
        </Button>
      </div>
    </div>
  );
}
