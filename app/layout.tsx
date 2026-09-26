import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agent Ticketing Demo — agent queueing with fresh human authorization',
  description:
    'Your agent queues for you. The moment a slot is handed over, it asks a real human to prove they are there. If nobody answers, the slot moves on.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
