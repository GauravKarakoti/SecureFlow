import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const SCHEMA_PATH = path.join(process.cwd(), "public", "schema.json");

/**
 * Serves the JSON Schema for .secureflow.json at /schema.json
 * Enables editor autocompletion and schema validation for SecureFlow configuration.
 */
export async function GET() {
  try {
    const schema = await fs.readFile(SCHEMA_PATH, "utf8");
    return new NextResponse(schema, {
      status: 200,
      headers: {
        "Content-Type": "application/schema+json; charset=utf-8",
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Configuration schema is unavailable" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
