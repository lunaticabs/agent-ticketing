'use client';

import { useParams } from 'next/navigation';
import { TransferView } from './transfer-view';

/**
 * The routing shell, kept to two lines on purpose.
 *
 * `useParams` needs a mounted Next router, so it is confined here and the view
 * takes the token as a prop. Next also restricts what a page module may export,
 * which is why the view lives in its own file.
 */
export default function TransferPage() {
  const params = useParams<{ token: string }>();
  return <TransferView token={params.token} />;
}
