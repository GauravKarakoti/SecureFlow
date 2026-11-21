declare module "@next/bundle-analyzer" {
  import type { NextConfig } from "next";

  export default function withBundleAnalyzer(options?: {
    enabled?: boolean;
    openAnalyzer?: boolean;
  }): (config: NextConfig) => NextConfig;
}
