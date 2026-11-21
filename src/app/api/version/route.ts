import { NextResponse } from "next/server";
import { getVersionInfo } from "@/lib/version";

/**
 * GET /api/version
 *
 * Returns the running SecureFlow package version, build commit SHA, and build date.
 * Exposes zero secrets, dependency lists, or internal filesystem paths.
 */
export async function GET() {
  const versionInfo = getVersionInfo();

  return NextResponse.json(versionInfo, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    },
  });
}
