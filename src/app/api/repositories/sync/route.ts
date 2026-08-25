import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { syncUserRepositories } from "@/lib/github/sync-user-repos";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await syncUserRepositories(
      session.user.id,
      (session.user as any).githubLogin,
      (session as any).accessToken
    );

    return NextResponse.json(result, { status: 200 });
  } catch (error: any) {
    console.error("[API Repo Sync] Error synchronizing repositories:", error);
    return NextResponse.json(
      { error: "Failed to synchronize repositories", message: error?.message },
      { status: 500 }
    );
  }
}
