import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // `better-sqlite3` is a native module: keep it external so Next.js does not try
  // to bundle the .node binary into server components / route handlers.
  serverExternalPackages: ['better-sqlite3'],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
