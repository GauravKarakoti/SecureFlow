/**
 * Inline Source-Code Pragma Suppression Parser & Evaluator (#2203).
 *
 * Supports:
 *   // secureflow-ignore[CWE-79,XSS] reason="Sanitized upstream" expires=2027-01-01
 *   # secureflow-ignore-next-line[SECRET] reason="Test fixture token"
 *   /* secureflow-ignore[SQL_INJECTION] reason="Parameterized" *\/
 */

export interface InlinePragmaDirective {
  /** 1-based line number where the pragma comment appears. */
  commentLine: number;
  /** 1-based line number that this pragma suppresses. */
  targetLine: number;
  /** Whether this used `-next-line`. */
  isNextLine: boolean;
  /** Optional rule IDs / CWEs / finding types scoped by `[...]`. Empty = all rules. */
  ruleIds: string[];
  /** Optional human-readable justification from `reason="..."`. */
  reason?: string;
  /** Optional `YYYY-MM-DD` expiration date from `expires=...`. */
  expiresAt?: string;
  /** True if `expiresAt` is in the past relative to evaluation `now`. */
  expired: boolean;
  /** True if pragma is valid and active (not expired, and has reason if strictReason=true). */
  active: boolean;
  /** Diagnostic reason if inactive. */
  inactiveReason?: "expired" | "missing_reason";
  raw: string;
}

export interface ParseInlinePragmasOptions {
  now?: Date;
  strictReason?: boolean;
}

export interface PragmaAuditRecord {
  fileLocation: string;
  targetLine: number;
  commentLine: number;
  ruleIds: string[];
  reason?: string;
  expiresAt?: string;
  findingType: string;
}

export interface PragmaFindingTarget {
  type: string;
  fileLocation: string;
  lineStart?: number | null;
  cwe?: string | null;
  ruleId?: string | null;
  suppressionStatus?: string | null;
  suppressionRuleId?: string | null;
}

export interface EvaluateInlinePragmaResult<T extends PragmaFindingTarget = PragmaFindingTarget> {
  activeFindings: T[];
  suppressedFindings: T[];
  auditRecords: PragmaAuditRecord[];
  expiredPragmas: Array<{ fileLocation: string; pragma: InlinePragmaDirective }>;
  invalidPragmas: Array<{ fileLocation: string; pragma: InlinePragmaDirective }>;
}

const PRAGMA_REGEX =
  /(?:\/\/|#|\/\*)\s*secureflow-ignore(-next-line)?(?:\s*\[([^\]]+)\])?([^\r\n]*)/i;

function extractQuotedReason(tail: string): string | undefined {
  const match = tail.match(/reason\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  if (!match) return undefined;
  const val = (match[1] ?? match[2] ?? "").trim();
  return val.length > 0 ? val : undefined;
}

function extractExpiresDate(tail: string): string | undefined {
  const match = tail.match(/expires\s*=\s*(\d{4}-\d{2}-\d{2})/i);
  return match ? match[1] : undefined;
}

function isDateExpired(yyyyMmDd: string, now: Date): boolean {
  const endOfDayUtc = Date.parse(`${yyyyMmDd}T23:59:59.999Z`);
  if (isNaN(endOfDayUtc)) return false;
  return now.getTime() > endOfDayUtc;
}

/**
 * Parse all `secureflow-ignore` pragmas from a source file.
 */
export function parseInlinePragmas(
  source: string,
  options: ParseInlinePragmasOptions = {},
): InlinePragmaDirective[] {
  const now = options.now ?? new Date();
  const strictReason = options.strictReason ?? false;
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const directives: InlinePragmaDirective[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const match = line.match(PRAGMA_REGEX);
    if (!match) continue;

    const commentLine = idx + 1;
    const isNextLine = Boolean(match[1]);
    const targetLine = isNextLine ? commentLine + 1 : commentLine;
    const ruleIdsRaw = match[2];
    const tail = (match[3] ?? "").replace(/\*\/\s*$/, "");

    const ruleIds = ruleIdsRaw
      ? ruleIdsRaw
          .split(",")
          .map((r) => r.trim().toUpperCase())
          .filter(Boolean)
      : [];

    const reason = extractQuotedReason(tail);
    const expiresAt = extractExpiresDate(tail);
    const expired = expiresAt ? isDateExpired(expiresAt, now) : false;

    let active = true;
    let inactiveReason: "expired" | "missing_reason" | undefined;

    if (expired) {
      active = false;
      inactiveReason = "expired";
    } else if (strictReason && !reason) {
      active = false;
      inactiveReason = "missing_reason";
    }

    directives.push({
      commentLine,
      targetLine,
      isNextLine,
      ruleIds,
      reason,
      expiresAt,
      expired,
      active,
      inactiveReason,
      raw: line.trim(),
    });
  }

  return directives;
}

function pragmaMatchesFinding(
  pragma: InlinePragmaDirective,
  finding: PragmaFindingTarget,
): boolean {
  if (!pragma.active) return false;
  if (typeof finding.lineStart !== "number" || finding.lineStart !== pragma.targetLine) {
    return false;
  }
  if (pragma.ruleIds.length === 0) {
    return true;
  }

  const candidates = [finding.type, finding.cwe, finding.ruleId]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim().toUpperCase());

  return pragma.ruleIds.some((rule) =>
    candidates.some((cand) => cand === rule || cand.includes(rule)),
  );
}

/**
 * Evaluate findings against inline pragmas parsed from `sourceByFile`.
 */
export function evaluateInlinePragmaSuppressions<
  T extends PragmaFindingTarget = PragmaFindingTarget,
>(
  findings: T[],
  sourceByFile: Record<string, string>,
  options: ParseInlinePragmasOptions = {},
): EvaluateInlinePragmaResult<T> {
  const pragmasByFile = new Map<string, InlinePragmaDirective[]>();
  const expiredPragmas: Array<{ fileLocation: string; pragma: InlinePragmaDirective }> = [];
  const invalidPragmas: Array<{ fileLocation: string; pragma: InlinePragmaDirective }> = [];

  for (const [filePath, content] of Object.entries(sourceByFile)) {
    const parsed = parseInlinePragmas(content, options);
    pragmasByFile.set(filePath, parsed);
    for (const pragma of parsed) {
      if (pragma.inactiveReason === "expired") {
        expiredPragmas.push({ fileLocation: filePath, pragma });
      } else if (pragma.inactiveReason === "missing_reason") {
        invalidPragmas.push({ fileLocation: filePath, pragma });
      }
    }
  }

  const activeFindings: T[] = [];
  const suppressedFindings: T[] = [];
  const auditRecords: PragmaAuditRecord[] = [];

  for (const finding of findings) {
    const filePragmas = pragmasByFile.get(finding.fileLocation) ?? [];
    const matched = filePragmas.find((p) => pragmaMatchesFinding(p, finding));

    if (matched) {
      const suppressedFinding: T = {
        ...finding,
        suppressionStatus: "SUPPRESSED_BY_PRAGMA",
        suppressionRuleId: `pragma:${finding.fileLocation}:${matched.commentLine}`,
      };
      suppressedFindings.push(suppressedFinding);
      auditRecords.push({
        fileLocation: finding.fileLocation,
        targetLine: matched.targetLine,
        commentLine: matched.commentLine,
        ruleIds: matched.ruleIds,
        reason: matched.reason,
        expiresAt: matched.expiresAt,
        findingType: finding.type,
      });
    } else {
      activeFindings.push(finding);
    }
  }

  return {
    activeFindings,
    suppressedFindings,
    auditRecords,
    expiredPragmas,
    invalidPragmas,
  };
}
