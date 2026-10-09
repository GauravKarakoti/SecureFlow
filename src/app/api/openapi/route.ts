import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const SPEC_PATH = path.join(process.cwd(), "openapi.yaml");

/** Serves openapi.yaml for /docs/api-playground. */
export async function GET() {
  try {
    let spec = await readFile(SPEC_PATH, "utf8");
    // The spec is written in 3.0 syntax, so serve it as 3.0.3.
    spec = spec.replace(/^openapi:\s*3\.1\.\d+/m, "openapi: 3.0.3");

    return new NextResponse(spec, {
      status: 200,
      headers: {
        "Content-Type": "application/yaml; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "The OpenAPI specification is unavailable." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
