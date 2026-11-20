import { releaseLock } from "./lock";
import { postScanCancelledCheckRun } from "../scanner/check-run";
import { getGitHubAppCredentials } from "@/lib/github/app-auth";
import { App } from "octokit";

export interface ActiveScan {
  id: string;
  job?: any;
  repositoryFullName: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha?: string;
  installationId?: number | string;
  checkRunId?: number;
  lockKey?: string;
  lockToken?: string;
  lockHeartbeat?: { stop: () => void };
  cancelCheckRun?: (reason?: string) => Promise<void>;
  requeueJob?: () => Promise<void>;
}

const activeScans = new Map<string, ActiveScan>();

/**
 * Register an in-flight scan for graceful shutdown tracking.
 */
export function registerInFlightScan(scan: ActiveScan): void {
  activeScans.set(scan.id, scan);
}

/**
 * Unregister a completed or failed scan.
 */
export function unregisterInFlightScan(id: string): void {
  activeScans.delete(id);
}

/**
 * Return all currently active in-flight scans.
 */
export function getInFlightScans(): ActiveScan[] {
  return Array.from(activeScans.values());
}

/**
 * Return the number of currently active in-flight scans.
 */
export function getInFlightScanCount(): number {
  return activeScans.size;
}

/**
 * Clear the in-flight scans registry (used primarily in tests).
 */
export function clearInFlightScans(): void {
  activeScans.clear();
}

export interface HandleInterruptedScansOptions {
  markCheckRun?: boolean;
  requeue?: boolean;
  conclusion?: "neutral" | "cancelled";
}

/**
 * Clean up scans that could not complete within the graceful shutdown grace period (#1894).
 *
 * For each in-flight scan:
 * 1. Stops the lock heartbeat and releases the per-PR lock so subsequent workers can run.
 * 2. Marks the GitHub Check Run as neutral/cancelled with a clear explanatory notice,
 *    ensuring PRs are never left in an indefinite "in progress" state.
 * 3. Re-queues the job with queue-level deduplication so another worker can complete the scan.
 */
export async function handleInterruptedScans(
  reason: string = "Worker container was stopped or rescheduled before the scan could complete. The scan has been re-queued.",
  options: HandleInterruptedScansOptions = {},
): Promise<void> {
  const scans = getInFlightScans();
  if (scans.length === 0) return;

  console.log(`[Shutdown] Handling ${scans.length} interrupted in-flight scan(s)...`);

  for (const scan of scans) {
    try {
      // 1. Stop heartbeat so lock renewal ceases immediately
      if (scan.lockHeartbeat && typeof scan.lockHeartbeat.stop === "function") {
        scan.lockHeartbeat.stop();
      }

      // 2. Release distributed lock so another worker or retry can acquire it immediately
      if (scan.lockKey && scan.lockToken) {
        try {
          await releaseLock(scan.lockKey, scan.lockToken);
          console.log(`[Shutdown] Released lock ${scan.lockKey} for PR #${scan.prNumber}`);
        } catch (lockErr) {
          console.error(`[Shutdown] Failed to release lock ${scan.lockKey}:`, lockErr);
        }
      }

      // 3. Mark check run as neutral/cancelled (never left "in progress")
      if (options.markCheckRun !== false) {
        try {
          if (scan.cancelCheckRun) {
            await scan.cancelCheckRun(reason);
          } else if (scan.installationId && scan.owner && scan.repo && scan.headSha) {
            const { appId, privateKey, Octokit: customOctokit } = getGitHubAppCredentials();
            const appClient = new App({
              appId,
              privateKey,
              ...(customOctokit ? { Octokit: customOctokit } : {}),
            });
            const octokit = await appClient.getInstallationOctokit(Number(scan.installationId));
            await postScanCancelledCheckRun(octokit as any, {
              owner: scan.owner,
              repo: scan.repo,
              headSha: scan.headSha,
              checkRunId: scan.checkRunId,
              reason,
              conclusion: options.conclusion ?? "neutral",
            });
          }
          console.log(
            `[Shutdown] Marked check run as ${options.conclusion ?? "neutral"} for ${scan.repositoryFullName}#${scan.prNumber}`,
          );
        } catch (checkErr) {
          console.error(
            `[Shutdown] Failed to mark check run for ${scan.repositoryFullName}#${scan.prNumber}:`,
            checkErr,
          );
        }
      }

      // 4. Re-queue the job with existing deduplication so another worker completes the scan
      if (options.requeue !== false) {
        try {
          if (scan.requeueJob) {
            await scan.requeueJob();
          } else if (scan.job?.queue && typeof scan.job.queue.add === "function") {
            await scan.job.queue.add(scan.job.name, scan.job.data, {
              jobId: scan.job.id,
              priority: 1,
            });
          }
          console.log(
            `[Shutdown] Re-queued scan job for ${scan.repositoryFullName}#${scan.prNumber}`,
          );
        } catch (requeueErr) {
          console.error(
            `[Shutdown] Failed to re-queue job for ${scan.repositoryFullName}#${scan.prNumber}:`,
            requeueErr,
          );
        }
      }
    } finally {
      activeScans.delete(scan.id);
    }
  }
}
