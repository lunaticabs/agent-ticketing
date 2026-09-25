import { json, route } from '@/lib/api';
import { getDb } from '@/lib/db';
import { primaryEvent } from '@/lib/humans';
import { activeGrants, describeScope } from '@/lib/grants';

/**
 * The human directory.
 *
 * Used by the transfer UI to address an offer at a specific person, and by the
 * demo to show the collapse of many accounts onto few humans. This is the visible
 * payoff of keying everything on continuity ids: the list is *people*, and the
 * inbound counter beside each one is what a new account cannot reset.
 */
export const GET = route(async () => {
  const event = primaryEvent();
  const rows = getDb()
    .prepare(
      `SELECT h.continuity_id, h.issuer, h.subject, h.created_at, h.last_fresh_auth_at,
              (SELECT COUNT(*) FROM dev_army a WHERE a.continuity_id = h.continuity_id) AS dev_accounts,
              (SELECT COUNT(*) FROM slot s
                WHERE s.holder_continuity_id = h.continuity_id
                  AND s.state = 'CONFIRMED') AS holds
         FROM human h
        ORDER BY h.created_at DESC
        LIMIT 200`,
    )
    .all() as {
    continuity_id: string;
    issuer: string;
    subject: string;
    created_at: number;
    last_fresh_auth_at: number | null;
    dev_accounts: number;
    holds: number;
  }[];

  return json({
    ok: true,
    eventId: event.id,
    humans: rows.map((r) => ({
      continuityId: r.continuity_id,
      short: r.continuity_id.replace(/^cid_/, '').slice(0, 8),
      issuer: r.issuer,
      subject: r.subject,
      simulated: r.issuer.startsWith('local:'),
      accounts: r.dev_accounts,
      holds: r.holds,
      lastFreshAuthAt: r.last_fresh_auth_at,
      grants: activeGrants(r.continuity_id, event.id).map((g) => ({
        id: g.id,
        scope: g.scope,
        description: describeScope(g.scope),
        expiresAt: g.expires_at,
      })),
    })),
    note:
      'Everything here is keyed on the continuity id. `accounts` is how many simulated signups ' +
      'map onto that one human — the collapse demo beat 4 is about.',
  });
});
