import type { NextConfig } from 'next';

const backend = process.env.BACKEND_ORIGIN ?? 'http://127.0.0.1:4000';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Proxy the API through Next so the session cookie stays same-origin:
  // no cross-site cookie, and the CSRF double-submit works unchanged.
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${backend}/api/v1/:path*` }];
  },
};

export default nextConfig;
