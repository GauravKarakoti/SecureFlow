import type { NextConfig } from 'next';

// Only enable `output: 'standalone'` during Docker builds.
//
// The Dockerfile sets DOCKER_BUILD=true in the builder stage, which triggers
// Next.js output tracing and produces a self-contained `.next/standalone`
// bundle. That bundle is what the runner stage copies into the final image
// (no full node_modules needed → much smaller image).
//
// When DOCKER_BUILD is NOT set — i.e. local `npm run dev`, `npm run build`,
// or `npm run start` — `output` is omitted so the standard Next.js server
// and App Router work exactly as expected. Hardcoding `output: 'standalone'`
// unconditionally breaks app routing when running outside Docker because
// `next start` doesn't consume the standalone bundle the way
// `node .next/standalone/server.js` does.
const isDockerBuild = process.env.DOCKER_BUILD === 'true';

const nextConfig: NextConfig = {
  ...(isDockerBuild ? { output: 'standalone' as const } : {}),

  // Make sure the Prisma generated client (produced by `prisma generate` at
  // build time) is pulled into the standalone trace. Only relevant when
  // `output: 'standalone'` is active (Docker builds), but harmless otherwise.
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
};

export default nextConfig;