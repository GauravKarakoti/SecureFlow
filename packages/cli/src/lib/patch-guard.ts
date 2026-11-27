import { createHash } from "node:crypto";

export class PatchRateLimitExceededError extends Error {
  public resource: string;
  public retryAfterSeconds: number;
  public attempts: number;

  constructor(resource: string, retryAfterSeconds: number, attempts: number) {
    super(
      `Automated patching rate limit exceeded for resource '${resource}': ${attempts} attempts in the current window. Cooldown active for ${retryAfterSeconds}s.`,
    );
    this.name = "PatchRateLimitExceededError";
    this.resource = resource;
    this.retryAfterSeconds = retryAfterSeconds;
    this.attempts = attempts;
  }
}

export class PatchBoundaryViolationError extends Error {
  public resource: string;
  public reason: string;

  constructor(resource: string, reason: string) {
    super(`Patch boundary violation on resource '${resource}': ${reason}`);
    this.name = "PatchBoundaryViolationError";
    this.resource = resource;
    this.reason = reason;
  }
}

export class PatchLoopDetectedError extends Error {
  public resource: string;
  public details: string;

  constructor(resource: string, details: string) {
    super(
      `Infinite loop protection triggered on resource '${resource}': ${details}. Automated execution halted.`,
    );
    this.name = "PatchLoopDetectedError";
    this.resource = resource;
    this.details = details;
  }
}

export interface PatchGuardConfig {
  maxPerResourceInWindow?: number; // default: 5
  maxGlobalInWindow?: number; // default: 15
  windowMs?: number; // default: 60,000 (1 minute)
  maxPatchSizeBytes?: number; // default: 65,536 (64 KB)
  maxPatchLines?: number; // default: 500
  maxIdenticalRepeats?: number; // default: 3
  maxOscillations?: number; // default: 4
}

interface ActionRecord {
  hash: string;
  timestamp: number;
  actionType: string;
}

const FORBIDDEN_PATH_PATTERNS: RegExp[] = [
  /\.\./, // Traversal
  /^[/\\]/, // Root directory access
  /^[A-Za-z]:[/\\]/, // Windows absolute paths
  /(^|[/\\])\.env/i, // Environment files
  /(^|[/\\])\.git([/\\]|$)/i, // Git directory
  /(^|[/\\])\.ssh([/\\]|$)/i, // SSH keys
  /(^|[/\\])id_(?:rsa|ecdsa|ed25519)/i, // Private keys
  /(^|[/\\])node_modules([/\\]|$)/i, // Dependencies
  /^(etc|proc|sys|root|var[/\\]run)[/\\]/i, // System paths
];

export class PatchGuard {
  private config: Required<PatchGuardConfig>;
  private resourceTimestamps: Map<string, number[]> = new Map();
  private globalTimestamps: number[] = [];
  private resourceHistory: Map<string, ActionRecord[]> = new Map();

  constructor(config: PatchGuardConfig = {}) {
    this.config = {
      maxPerResourceInWindow: config.maxPerResourceInWindow ?? 5,
      maxGlobalInWindow: config.maxGlobalInWindow ?? 15,
      windowMs: config.windowMs ?? 60_000,
      maxPatchSizeBytes: config.maxPatchSizeBytes ?? 65_536,
      maxPatchLines: config.maxPatchLines ?? 500,
      maxIdenticalRepeats: config.maxIdenticalRepeats ?? 3,
      maxOscillations: config.maxOscillations ?? 4,
    };
  }

  /**
   * Resets all internal rate-limiting and history state.
   */
  public reset(): void {
    this.resourceTimestamps.clear();
    this.globalTimestamps = [];
    this.resourceHistory.clear();
  }

  /**
   * Cleans up expired timestamps outside the sliding window.
   */
  private pruneTimestamps(now: number): void {
    const cutoff = now - this.config.windowMs;

    this.globalTimestamps = this.globalTimestamps.filter((t) => t > cutoff);

    for (const [res, timestamps] of this.resourceTimestamps.entries()) {
      const active = timestamps.filter((t) => t > cutoff);
      if (active.length === 0) {
        this.resourceTimestamps.delete(res);
      } else {
        this.resourceTimestamps.set(res, active);
      }
    }

    for (const [res, history] of this.resourceHistory.entries()) {
      const active = history.filter((h) => h.timestamp > cutoff);
      if (active.length === 0) {
        this.resourceHistory.delete(res);
      } else {
        this.resourceHistory.set(res, active);
      }
    }
  }

  /**
   * Validates target path against security boundaries.
   */
  public validateResourcePath(resource: string): void {
    if (!resource || resource.trim().length === 0) {
      throw new PatchBoundaryViolationError(resource, "Resource target path must not be empty");
    }

    const normalized = resource.replace(/\\/g, "/").trim();
    for (const pattern of FORBIDDEN_PATH_PATTERNS) {
      if (pattern.test(normalized)) {
        throw new PatchBoundaryViolationError(
          resource,
          "Target path violates security boundaries (forbidden path, directory traversal, or sensitive credential location)",
        );
      }
    }
  }

  /**
   * Validates patch size and line count constraints.
   */
  public validatePatchDiff(resource: string, patchDiff?: string): void {
    if (!patchDiff) return;

    const byteLength = Buffer.byteLength(patchDiff, "utf8");
    if (byteLength > this.config.maxPatchSizeBytes) {
      throw new PatchBoundaryViolationError(
        resource,
        `Patch diff size (${byteLength} bytes) exceeds maximum limit of ${this.config.maxPatchSizeBytes} bytes`,
      );
    }

    const lineCount = patchDiff.split("\n").length;
    if (lineCount > this.config.maxPatchLines) {
      throw new PatchBoundaryViolationError(
        resource,
        `Patch diff line count (${lineCount} lines) exceeds maximum limit of ${this.config.maxPatchLines} lines`,
      );
    }
  }

  /**
   * Enforces sliding-window rate limit for a given resource and globally.
   */
  public checkRateLimit(resource: string, now: number = Date.now()): void {
    this.pruneTimestamps(now);

    // Global rate limit check
    if (this.globalTimestamps.length >= this.config.maxGlobalInWindow) {
      const oldest = this.globalTimestamps[0] ?? now;
      const retryAfter = Math.max(1, Math.ceil((oldest + this.config.windowMs - now) / 1000));
      throw new PatchRateLimitExceededError("*GLOBAL*", retryAfter, this.globalTimestamps.length);
    }

    // Per-resource rate limit check
    const perResource = this.resourceTimestamps.get(resource) || [];
    if (perResource.length >= this.config.maxPerResourceInWindow) {
      const oldest = perResource[0] ?? now;
      const retryAfter = Math.max(1, Math.ceil((oldest + this.config.windowMs - now) / 1000));
      throw new PatchRateLimitExceededError(resource, retryAfter, perResource.length);
    }
  }

  /**
   * Detects loops and oscillations for automated actions on a resource.
   */
  public checkLoopDetection(resource: string, actionType: string, patchDiff?: string): void {
    const history = this.resourceHistory.get(resource) || [];
    if (history.length === 0) return;

    const hash = patchDiff
      ? createHash("sha256").update(patchDiff).digest("hex").slice(0, 16)
      : actionType;

    // 1. Identical repeat check: check if the exact same patch or action was applied repeatedly
    const identicalCount = history.filter((h) => h.hash === hash).length;
    if (identicalCount >= this.config.maxIdenticalRepeats - 1) {
      throw new PatchLoopDetectedError(
        resource,
        `Identical action attempted ${identicalCount + 1} times within the current window without resolution`,
      );
    }

    // 2. Oscillation check: check if actions alternate repeatedly (e.g. A -> B -> A -> B)
    if (history.length >= 3) {
      const first = history[history.length - 3];
      const second = history[history.length - 2];
      const third = history[history.length - 1];
      if (first && second && third) {
        const isAlternating =
          first.hash !== second.hash && first.hash === third.hash && second.hash === hash;

        if (isAlternating) {
          throw new PatchLoopDetectedError(
            resource,
            "Oscillating patch loop detected (alternating patch states detected within window)",
          );
        }
      }
    }
  }

  /**
   * Pre-execution validation check. Verifies boundaries, rate limits, and loop hazards.
   */
  public assertCanApply(params: {
    resource: string;
    actionType?: string;
    patchDiff?: string;
    now?: number;
  }): void {
    const now = params.now ?? Date.now();
    const actionType = params.actionType ?? "REMEDIATION_PATCH";

    this.validateResourcePath(params.resource);
    this.validatePatchDiff(params.resource, params.patchDiff);
    this.checkLoopDetection(params.resource, actionType, params.patchDiff);
    this.checkRateLimit(params.resource, now);
  }

  /**
   * Records a committed action for rate-limiting and loop detection tracking.
   */
  public recordAction(params: {
    resource: string;
    actionType?: string;
    patchDiff?: string;
    now?: number;
  }): void {
    const now = params.now ?? Date.now();
    const actionType = params.actionType ?? "REMEDIATION_PATCH";
    const hash = params.patchDiff
      ? createHash("sha256").update(params.patchDiff).digest("hex").slice(0, 16)
      : actionType;

    // Record timestamp
    this.globalTimestamps.push(now);

    const perResource = this.resourceTimestamps.get(params.resource) || [];
    perResource.push(now);
    this.resourceTimestamps.set(params.resource, perResource);

    // Record history
    const history = this.resourceHistory.get(params.resource) || [];
    history.push({ hash, timestamp: now, actionType });
    this.resourceHistory.set(params.resource, history);
  }
}

/**
 * Default global singleton PatchGuard for the CLI.
 */
export const defaultPatchGuard = new PatchGuard();
