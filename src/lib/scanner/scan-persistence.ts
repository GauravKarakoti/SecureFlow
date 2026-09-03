/**
 * The mapping between what a scan produces and what Prisma will accept (#747).
 *
 * `src/lib/scanner/scanEngine.ts` cannot be unit tested — it constructs an
 * Octokit app, talks to the LLM and writes through the shared Prisma client — so
 * every decision it makes about the *shape* of a database write lives here
 * instead, where it can be exercised directly.
 *
 * There is a specific reason this module exists rather than the engine simply
 * calling the normalizers inline. Three columns the engine writes are Postgres
 * enums, and `scanEngine.ts` was reaching all three of them with values that are
 * not members:
 *
 *  - `ScanResult.policyDecision` and `ScanJob.policyDecision` are
 *    `PolicyDecision` (`PASS | REVIEW | BLOCK`), and `iq.evaluateFindings`
 *    answers `'PASS' | 'REVIEW REQUIRED' | 'BLOCKED'`. Two of the three
 *    answers are rejected.
 *  - `Finding.type` is `FindingType` (`SECRET | VULNERABILITY | MISCONFIG`) and
 *    `scanner.ts` stores display labels — `'Secret'`, `'Vulnerability'`,
 *    `'Misconfig'` — via `normalizeFindingTypeLabel`. All three are rejected.
 *
 * `src/lib/queue/worker.ts` has been converting these since #633 with
 * `normalizePolicyDecisionEnum` and `normalizeFindingTypeEnum`; the async engine
 * added in #712 passed `as any` instead. `as any` silences the compiler and
 * changes nothing about what Postgres does with the value, and because the
 * engine's persistence phase is wrapped in a `catch` that only logs, the
 * rejection was invisible: the job reported `COMPLETED` and no row appeared.
 *
 * So the conversions are centralised, named, and covered.
 */

import type { ScanFinding } from '@/lib/armor/scanner';
import {
  normalizeFindingTypeEnum,
  normalizePolicyDecisionEnum,
} from '@/lib/finding-taxonomy';
import { toStoredSeverity, totalRiskScore } from '@/lib/severity';

/** The `PolicyDecision` members, mirroring `prisma/schema.prisma`. */
export type StoredPolicyDecision = 'PASS' | 'REVIEW' | 'BLOCK';

/** The `FindingType` members, mirroring `prisma/schema.prisma`. */
export type StoredFindingType = 'SECRET' | 'VULNERABILITY' | 'MISCONFIG';

/**
 * A finding after the engine has been over it.
 *
 * `ScanFinding` is what the scanner returns. The engine then adds a fingerprint
 * in phase 3 and, for findings that survive suppression, an AI explanation and
 * remediation in phase 4 — none of which `ScanFinding` declares, which is why
 * `scanEngine.ts` produced eight `TS2339`/`TS7006` errors against it and why
 * `npm run typecheck` was red on `main`.
 *
 * The added fields are optional rather than required because the engine's
 * enrichment step has a `catch` that returns the un-enriched finding, and
 * suppressed findings skip enrichment entirely. A required field would be a
 * claim the pipeline does not make.
 */
export interface EnrichedScanFinding extends ScanFinding {
  /** Stable content hash, assigned in phase 3. See `computeFingerprint`. */
  fingerprint?: string;
  /** AI explanation, masked. Absent when enrichment failed or was skipped. */
  explanation?: string;
  /** AI remediation suggestion, masked. */
  remediation?: string;
  /** Whether the explanation flow suspected prompt injection in the snippet. */
  promptInjectionSuspected?: boolean;
}

/**
 * Thrown when a job carries an installation id that cannot address GitHub.
 *
 * Distinguished from a generic `Error` so the worker can tell "this job is
 * malformed and will never succeed" from "GitHub was unreachable this time".
 */
export class InvalidInstallationIdError extends Error {
  constructor(value: unknown) {
    super(`Scan job carries an unusable GitHub installation id: ${JSON.stringify(value)}`);
    this.name = 'InvalidInstallationIdError';
  }
}

/**
 * Thrown when the scan itself succeeded but its results could not be stored.
 *
 * The distinction matters to the worker: the GitHub check run and PR comment
 * have already been posted at this point, so a retry duplicates them. The engine
 * raises this only after finishing, and the worker treats it as terminal rather
 * than as a reason to re-run the scan.
 */
export class ScanPersistenceError extends Error {
  constructor(reason: string) {
    super(`Scan completed but its results could not be persisted: ${reason}`);
    this.name = 'ScanPersistenceError';
  }
}

/**
 * Coerce `ScanJobData.installationId` to the number Octokit requires.
 *
 * The field is typed `number | string` because `/api/findings` accepts either
 * and BullMQ round-trips job data through JSON, where a large id supplied as a
 * string stays a string. `App.getInstallationOctokit` takes a `number` and
 * nothing narrowed it, which is the `TS2769` at `scanEngine.ts:86`.
 *
 * Parsed strictly. `Number('')` is `0` and `Number('12abc')` is `NaN`; both
 * would reach Octokit and produce a confusing 404 from the GitHub API rather
 * than a clear failure here. `parseInt` is avoided for the same reason — it
 * would accept `'123abc'`.
 */
export function parseInstallationId(value: number | string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) throw new InvalidInstallationIdError(value);
    return value;
  }

  if (typeof value !== 'string') throw new InvalidInstallationIdError(value);

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) throw new InvalidInstallationIdError(value);

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new InvalidInstallationIdError(value);

  return parsed;
}

/**
 * The stored `PolicyDecision` for a scanner verdict.
 *
 * A thin alias over `normalizePolicyDecisionEnum` so the engine reads as
 * converting rather than asserting, and so this module owns the one import.
 */
export function storedPolicyDecision(decision: unknown): StoredPolicyDecision {
  return normalizePolicyDecisionEnum(decision);
}

/**
 * The GitHub check-run conclusion for a scanner verdict.
 *
 * Was an inline ternary chained on the exact strings `'PASS'` and
 * `'REVIEW REQUIRED'`, so any change to `iq.evaluateFindings`' phrasing would
 * silently start reporting every scan as `failure`. Routing through the same
 * normalizer as the database write means the check run and the stored row can
 * no longer disagree.
 */
export function checkRunConclusion(
  decision: unknown
): 'success' | 'action_required' | 'failure' {
  switch (storedPolicyDecision(decision)) {
    case 'PASS':
      return 'success';
    case 'BLOCK':
      return 'failure';
    default:
      return 'action_required';
  }
}

/** A `Finding` row as `scanResult.create` nests it. */
export interface FindingCreateInput {
  type: StoredFindingType;
  severity: ReturnType<typeof toStoredSeverity>;
  fileLocation: string;
  lineStart: number | null;
  lineEnd: number | null;
  codeSnippet: string | null;
  explanation: string | null;
  remediation: string | null;
  promptInjectionSuspected: boolean;
  fingerprint: string;
}

/**
 * Map one finding onto its `Finding` row.
 *
 * Mirrors `src/lib/queue/worker.ts:871-885` deliberately: the synchronous
 * webhook path and the queued path must produce identical rows, or the
 * dashboard's counts depend on which pipeline happened to run.
 *
 * `toStoredSeverity`, not `normalizeSeverity`: the latter can answer `'NONE'`
 * for a scanner verdict of clean/pass/ok, and `NONE` is not a `FindingSeverity`
 * member, so the insert fails outright (#686).
 *
 * `lineStart` / `lineEnd` are guarded on `typeof === 'number'` because the
 * scanner leaves them `undefined` when the model did not report a line, and
 * `undefined` in a Prisma `create` means "omit the column", which for a nullable
 * column is the same as null but for a required one is a silent difference. An
 * explicit null says what is meant.
 */
export function findingCreateInput(finding: EnrichedScanFinding): FindingCreateInput {
  return {
    type: normalizeFindingTypeEnum(finding.type),
    severity: toStoredSeverity(finding.severity),
    fileLocation: finding.fileLocation,
    lineStart: typeof finding.lineStart === 'number' ? finding.lineStart : null,
    lineEnd: typeof finding.lineEnd === 'number' ? finding.lineEnd : null,
    codeSnippet: finding.codeSnippet || null,
    explanation: finding.explanation || null,
    remediation: finding.remediation || null,
    promptInjectionSuspected: Boolean(finding.promptInjectionSuspected),
    fingerprint: finding.fingerprint || '',
  };
}

/**
 * The risk score as the `Int` column will take it.
 *
 * `totalRiskScore` sums `riskWeight` values, which are integers today. Rounding
 * here is a guard against that changing under us: a fractional value reaches
 * Postgres as a rejected insert, and the rejection is currently swallowed.
 */
export function storedRiskScore(findings: readonly EnrichedScanFinding[]): number {
  return Math.round(totalRiskScore(findings));
}

/** The `data` for the `scanResult.create` a completed scan writes. */
export interface ScanResultCreateData {
  pullRequestId: string;
  riskScore: number;
  policyDecision: StoredPolicyDecision;
  findings: { create: FindingCreateInput[] };
}

/**
 * Assemble the `ScanResult` write for a finished scan.
 *
 * `riskScore` is computed from `scoredFindings` while the rows come from
 * `findingsToPersist`, because the two sets are deliberately different:
 * suppressed findings are still stored, so the history survives a triage
 * decision being reversed, but they must not count toward the score or the
 * risk trend. Passing them separately makes that explicit instead of leaving it
 * to whichever array the caller happened to have in scope.
 */
export function scanResultCreateData(args: {
  pullRequestId: string;
  decision: unknown;
  scoredFindings: readonly EnrichedScanFinding[];
  findingsToPersist: readonly EnrichedScanFinding[];
}): ScanResultCreateData {
  return {
    pullRequestId: args.pullRequestId,
    riskScore: storedRiskScore(args.scoredFindings),
    policyDecision: storedPolicyDecision(args.decision),
    findings: { create: args.findingsToPersist.map(findingCreateInput) },
  };
}

/** The `ScanJob` update that closes out a successful run. */
export interface ScanJobCompletion {
  status: 'COMPLETED';
  scannedFiles: number;
  vulnerabilitiesFound: number;
  riskScore: number;
  policyDecision: StoredPolicyDecision;
  completedAt: Date;
}

/**
 * The completion update for a finished scan job.
 *
 * This is the write that turned a successful scan into a failed one.
 * `workerPool.processJob` passed `result.policyDecision` — the raw
 * `'REVIEW REQUIRED'` / `'BLOCKED'` verdict — into `ScanJob.policyDecision`,
 * which is the same `PolicyDecision` enum. The update threw, the surrounding
 * `catch` marked the job `FAILED` and re-threw, and BullMQ retried the whole
 * scan: another round of LLM calls, a second check run and a second PR comment.
 * Only a `PASS` ever completed.
 */
export function scanJobCompletion(
  result: {
    scannedFiles: number;
    vulnerabilitiesFound: number;
    riskScore: number;
    policyDecision: unknown;
  },
  completedAt: Date = new Date()
): ScanJobCompletion {
  return {
    status: 'COMPLETED',
    scannedFiles: result.scannedFiles,
    vulnerabilitiesFound: result.vulnerabilitiesFound,
    riskScore: Math.round(result.riskScore),
    policyDecision: storedPolicyDecision(result.policyDecision),
    completedAt,
  };
}

/**
 * Progress as a whole percentage, clamped to 0-100.
 *
 * `Math.round((scanned / total) * 100)` is `NaN` when `total` is 0, and `NaN`
 * into an `Int` column is another rejected write. The engine's chunk loop also
 * advances `scannedFiles` by a fixed `CHUNK_SIZE`, so the last chunk of a
 * partial batch can overshoot `totalFiles` and report more than 100%.
 */
export function progressPercent(scannedFiles: number, totalFiles: number): number {
  if (!Number.isFinite(scannedFiles) || !Number.isFinite(totalFiles) || totalFiles <= 0) {
    return 0;
  }

  return Math.min(100, Math.max(0, Math.round((scannedFiles / totalFiles) * 100)));
}
