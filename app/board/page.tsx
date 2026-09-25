import BoardClient from './board-client';
import { boardState } from '@/lib/board';
import { printStartupBanner } from '@/lib/startup';

/**
 * The board shell.
 *
 * Server-rendered so the projector shows real numbers on the very first paint —
 * a demo prop that says "connecting…" while a judge is already looking at it is
 * a worse prop. The client component then polls once a second and takes over.
 */
export const dynamic = 'force-dynamic';

export default async function BoardPage() {
  printStartupBanner();
  let initial: Awaited<ReturnType<typeof boardState>> | null = null;
  try {
    initial = boardState();
  } catch {
    // No event seeded yet. The client will surface the real error on its first
    // poll, with the remediation text.
  }
  return <BoardClient initial={initial} />;
}
