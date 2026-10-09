import type { NextConfig } from "next";
import {
  buildNextSecurityHeaderRules,
  securityHeaderOptionsFromEnv,
} from "./src/lib/security-headers";

const isDockerBuild = process.env.DOCKER_BUILD === "true";

const nextConfig: NextConfig = {
  ...(isDockerBuild ? { output: "standalone" as const } : {}),

  // Trace Prisma client artifacts into the standalone output
  outputFileTracingIncludes: {
    "/*": ["./node_modules/.prisma/client/**/*"],
    // `/api/openapi` reads the spec off disk at request time so the playground
    // always serves the committed file. Without this the root-level YAML is not
    // part of the deployment and the route 500s in production.
    "/api/openapi": ["./openapi.yaml"],
  },

  // Never ignore TypeScript errors during production build
  typescript: {
    ignoreBuildErrors: false,
  },

  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "placehold.co",
        port: "",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "images.unsplash.com",
        port: "",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "picsum.photos",
        port: "",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "avatars.githubusercontent.com",
        port: "",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "github.com",
        port: "",
        pathname: "/**",
      },
    ],
  },

  async headers() {
    return buildNextSecurityHeaderRules(securityHeaderOptionsFromEnv());
  },
};

export default nextConfig;
