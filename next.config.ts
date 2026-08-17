import type { NextConfig } from 'next';

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
};

export default nextConfig;