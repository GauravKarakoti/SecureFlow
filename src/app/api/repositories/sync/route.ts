import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { syncUserRepositories } from "@/lib/github/sync-user-repos";
import {
  parseSyncTarget,
  singleRepositorySyncResponse,
} from "@/lib/github/repo-sync-request";
import { hashIdentifier } from "@/lib/audit/minimization";
import { createLogger } from "@/lib/logger";
import { scrubSensitiveData } from "@/lib/redaction";
import {
  TIERS,
  buildRateLimitHeaders,
  secondsUntilReset,
  withRateLimit,
} from "@/lib/middleware/rate-limit";
import { checkRateLimitDetailed } from "@/lib/redis";

/**
 * Trigger a GitHub repository sync for the signed-in user (#690).
 *
 * This is the most expensive authenticated endpoint in the application —
 * `syncUserRepositories` walks the caller's GitHub App installation, runs
 * `partitionByOwnership`, and upserts in chunks with `REPO_SYNC_CONCURRENCY` in
 * flight — and it was the only route under `src/app/api/` with no rate limit at
 * all. Every sibling is wrapped: `/api/og/heist`,
 * `/api/findings/[id]/explain-stream`, `/api/heist-transmission`,
 * `/api/leaderboard`. Authentication bounds *who* can call this, not how often,
 * and a signed-in user holding down a retry loop turns it into sustained
 * consumption of the installation's shared GitHub API budget plus a write storm
 * against Postgres.
 *
 * It also returned `error?.message` straight to the caller. Those messages come
 * from Octokit, from the `App` constructor reading `GITHUB_APP_PRIVATE_KEY`, or
 * from Prisma, and they carry request URLs with tokens in them, PEM parse
 * failures quoting the key material, and connection targets. This repository
 * already has `scrubSensitiveData` for exactly that, and this route used
 * neither it nor `withErrorHandler`.
 *
 * The `repositoryId` branch used to fabricate its result (#749): 4500 hardcoded
 * file paths, counted in a loop whose body was `totalSyncedFiles++`, answered
 * with `success: true, status: "COMPLETED", synchronizedFilesCount: 4500`. It
 * performed no query, no GitHub call and no write, it never validated or
 * ownership-checked the id it was given, and because it was entered on
 * truthiness it shadowed the real sync below for every request that named a
 * repository. It now resolves the repository against the caller and runs the
 * real sync, or says why it could not.
 */

export const dynamic = "force-dynamic";

const log = createLogger({ context: { component: "api-repo-sync" } });

/** Never cached: a POST result, and a per-user repository list. */
const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * The caller-visible message for an unexpected failure.
 *
 * Deliberately constant. There is one class of caller-visible outcome here, and
 * a constant is easier to assert against than a derivation.
 */
const GENERIC_FAILURE = "Failed to synchronize repositories";

async function handler(request: NextRequest) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: NO_STORE }
    );
  }

  const userId = session.user.id;

  // Keyed per user, not per IP. The IP tier below is the outer guard; several
  // developers behind one office NAT should not share a sync budget, and one
  // account rotating through addresses should not escape it. This mirrors the
  // two-tier arrangement `/api/findings/[id]/explain-stream` already uses.
  const limit = await checkRateLimitDetailed(
    `rate-limit:repo-sync:user:${userId}`,
    TIERS.REPO_SYNC.limit,
    TIERS.REPO_SYNC.windowSeconds,
    {
      fallbackStrategy: TIERS.REPO_SYNC.fallbackStrategy,
      timeoutMs: TIERS.REPO_SYNC.timeoutMs,
    }
  );

  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: "Too Many Requests",
        message: "Repository sync is rate limited. Please try again shortly.",
      },
      {
        status: 429,
        headers: {
          ...NO_STORE,
          ...buildRateLimitHeaders(limit),
          "Retry-After": String(secondsUntilReset(limit.resetAt)),
        },
      }
    );
  }

  // Hashed rather than logged raw, matching how the admin actions record an
  // actor. Correlation survives; the identifier does not leave the process.
  const actor = hashIdentifier(userId, "usr");
  const abortSignal = request.signal;

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const target = parseSyncTarget(body);
  if (!target.ok) {
    return NextResponse.json({ error: target.message }, { status: 400, headers: NO_STORE });
  }

  // Named-repository path. The id is resolved against the session user before
  // anything else happens, so a request naming someone else's repository — or
  // one that does not exist — is refused rather than answered with a
  // fabricated success.
  let namedRepository: { id: string; fullName: string; owner: string; isActive: boolean } | null =
    null;

  if (target.repositoryId) {
    namedRepository = await prisma.repository.findFirst({
      where: { id: target.repositoryId, userId },
      select: { id: true, fullName: true, owner: true, isActive: true },
    });

    if (!namedRepository) {
      return NextResponse.json(
        { error: "Repository not found" },
        { status: 404, headers: NO_STORE }
      );
    }

    if (abortSignal?.aborted) {
      log.warn("Sync aborted before it started", { actor });
      return NextResponse.json(
        { error: "Sync task aborted by client timeout signal" },
        { status: 408, headers: NO_STORE }
      );
    }
  }

  // Standard User Repository Sync Path
  try {
    const result = await syncUserRepositories(
      userId,
      (session.user as { githubLogin?: string | null }).githubLogin,
      (session as { accessToken?: string | null }).accessToken
    );

    log.info("Repository sync completed", {
      actor,
      synced: result.synced,
      skipped: result.skipped ?? 0,
      failed: result.failed ?? 0,
      hasInstallation: result.hasInstallation,
    });

    // `syncUserRepositories` reports a partial failure through `result.error`
    // rather than by throwing, and that field is `err?.message` from the same
    // provider errors the catch below guards against. The success path has to
    // be scrubbed too, or the leak simply moves.
    const outcome = result.error
      ? { ...result, error: scrubSensitiveData(result.error) }
      : result;

    if (namedRepository) {
      // Re-read so the caller sees the row as the sync left it — the name and
      // the active flag both track GitHub and can have just changed.
      const refreshed =
        (await prisma.repository.findFirst({
          where: { id: namedRepository.id, userId },
          select: { id: true, fullName: true, owner: true, isActive: true },
        })) ?? namedRepository;

      return NextResponse.json(singleRepositorySyncResponse(refreshed, outcome), {
        status: 200,
        headers: NO_STORE,
      });
    }

    return NextResponse.json(outcome, { status: 200, headers: NO_STORE });
  } catch (error: any) {
    if (error?.name === "AbortError" || error?.message?.includes("aborted")) {
      log.warn("Sync pipeline timed out or aborted by client", { actor, error: error?.message });
      return NextResponse.json({ error: "Sync pipeline timed out or aborted by client" }, { status: 408, headers: NO_STORE });
    }

    // The raw error stays in the log, where it is useful and where the logger's
    // own redaction and newline stripping apply. The caller gets a constant.
    log.error("Repository sync failed", { actor, error });

    return NextResponse.json(
      { error: GENERIC_FAILURE },
      { status: 500, headers: NO_STORE }
    );
  }
}

// IP tier as the outermost guard, matching every other route in this directory;
// the per-user tier inside is the one that actually bounds the cost.
export const POST = withRateLimit(
  handler as (req: NextRequest, ...args: unknown[]) => Promise<NextResponse>,
  { ...TIERS.REPO_SYNC, keyPrefix: "repo-sync:ip" }
) as (req: NextRequest) => Promise<NextResponse>;