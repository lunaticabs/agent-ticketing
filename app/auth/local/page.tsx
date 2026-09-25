import Link from 'next/link';
import { getAuthRequestRow } from '@/worldid';
import LocalApproveForm from './form';

/**
 * The local fallback's stand-in for the IdP consent screen.
 *
 * This page exists only because registering an OIDC client on the sandbox portal
 * needs a human with a Google account. It is deliberately styled like a consent
 * screen so nobody mistakes it for the product UI, and it always says out loud
 * that it is not World ID.
 */
export const dynamic = 'force-dynamic';

export default async function LocalAuthPage({
  searchParams,
}: {
  searchParams: Promise<{ request?: string }>;
}) {
  const { request } = await searchParams;
  const row = request ? getAuthRequestRow(request) : undefined;

  if (!row) {
    return (
      <main className="mx-auto max-w-xl p-10">
        <h1 className="text-2xl font-bold">Unknown authorization request</h1>
        <p className="mt-3 text-[var(--color-muted)]">
          This link is stale or was already used. Start again from the console.
        </p>
        <Link href="/" className="mt-4 inline-block underline">
          back to the console
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl p-6">
      <div className="rounded-xl border border-[color-mix(in_srgb,var(--color-warn)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-warn)_10%,transparent)] p-3 text-xs text-[var(--color-warn)]">
        <strong>LOCAL FALLBACK CONSENT SCREEN.</strong> This is not World ID. No portal-issued
        OIDC credentials are configured, so identity is simulated by{' '}
        <code className="mono">worldid/local.ts</code>. The assertion it mints is signed by the
        server and every authorization check downstream still runs.
      </div>

      <h1 className="mt-6 text-3xl font-black">Authorize this action</h1>
      <p className="mt-1 text-[var(--color-muted)]">
        A program is asking you to prove you are here, now, for one specific operation.
      </p>

      <dl className="mt-6 space-y-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 text-sm">
        <Field label="purpose" value={describeIntent(row.intent)} />
        <Field label="action" value={row.action} mono />
        <Field label="signal" value={row.signal} mono />
        <Field label="mode" value={row.mode} />
        <Field label="state" value={row.state} />
        <Field
          label="expires"
          value={`${Math.max(0, Math.round((row.expires_at - Date.now()) / 1000))}s from now`}
        />
        {row.continuity_id && <Field label="acting as" value={row.continuity_id} mono />}
      </dl>

      <LocalApproveForm
        requestId={row.id}
        intent={row.intent}
        existingHandle={row.continuity_id ? 'linked human' : null}
      />

      <p className="mt-6 text-xs text-[var(--color-muted)]">
        The <code className="mono">action</code> above is what makes one person one ticket: the
        nullifier is derived from it, so a second attempt at the same action cannot succeed.
      </p>
    </main>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className={`truncate text-right ${mono ? 'mono text-xs' : ''}`}>{value}</dd>
    </div>
  );
}

function describeIntent(intent: string): string {
  switch (intent) {
    case 'link':
      return 'Link your identity — establishes who you are, nothing more';
    case 'purchase':
      return 'Claim your slot — binds this purchase to you, once';
    case 'transfer':
      return 'Receive a transferred slot — only you can do this for yourself';
    default:
      return intent;
  }
}
