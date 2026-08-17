import type { NextConfig } from 'next';
import {
  buildNextSecurityHeaderRules,
  securityHeaderOptionsFromEnv,
} from './src/lib/security-headers';

// Enable `output: 'standalone'` conditionally for Docker builds (#478).
//
// The Dockerfile sets DOCKER_BUILD=true during the builder stage, producing a
// minimal self-contained `.next/standalone` bundle for production deployment.
// Outside Docker (local dev/build/start), `output` is omitted to prevent
// breaking App Router behavior with standard `next start`.
const isDockerBuild = process.env.DOCKER_BUILD === 'true';

const nextConfig: NextConfig = {
  ...(isDockerBuild ? { output: 'standalone' as const } : {}),

  // Trace Prisma client artifacts into the standalone output
  outputFileTracingIncludes: {
    '/*': ['./node_modules/.prisma/client/**/*'],
  },

  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'placehold.co',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'picsum.photos',
        port: '',
        pathname: '/**',
      },
      // Add GitHub avatars here
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
        port: '',
        pathname: '/**',
      },
      // github.com/<user>.png fallback avatars used by the leaderboard
      {
        protocol: 'https',
        hostname: 'github.com',
        port: '',
        pathname: '/**',
      },
    ],
  },

  // Security response headers (#559).
  //
  // The policy itself lives in src/lib/security-headers.ts so it can be unit
  // tested without a server; this only decides where it is attached. Two rules
  // are emitted, most specific first: `/api/:path*` gets the locked-down
  // `default-src 'none'` policy plus `no-store`, and `/:path*` gets the
  // document policy. Next.js applies both to an API request, so the API rule's
  // values overwrite the catch-all's for the keys they share.
  //
  // Middleware short-circuits (the admin guard's 401/403, the rate limiter's
  // 429) never reach this layer, so src/proxy.ts applies the same header set to
  // the responses it builds itself.
  async headers() {
    return buildNextSecurityHeaderRules(securityHeaderOptionsFromEnv());
  },
};

export default nextConfig;