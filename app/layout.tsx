import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'HumanGate — verifiable authorization for AI agents',
  description:
    'An agent can do the work. It cannot authorize it. HumanGate asks a real human, verified with World ID, to authorize each protected action — and consumes that authorization exactly once.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
