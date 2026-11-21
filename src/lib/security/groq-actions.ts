import { z } from "zod";
import { detectPromptInjection } from "@/ai/flows/security-helpers";

export class PromptInjectionSanitizationError extends Error {
  public field: string;
  public snippet: string;

  constructor(field: string, snippet: string) {
    super(
      `Prompt injection detected in Groq action output at field '${field}': payload rejected for infrastructure safety`,
    );
    this.name = "PromptInjectionSanitizationError";
    this.field = field;
    this.snippet = snippet.slice(0, 100);
  }
}

export class GroqActionValidationError extends Error {
  public issues: z.ZodIssue[];

  constructor(message: string, issues: z.ZodIssue[] = []) {
    super(message);
    this.name = "GroqActionValidationError";
    this.issues = issues;
  }
}

/**
 * Strips ASCII control characters (0x00 - 0x1F except tab, newline, and carriage return)
 * to prevent ANSI injection, escape sequences, or database delimiter corruption.
 */
export function stripControlCharacters(input: string): string {
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/**
 * Validates that a resource path does not escape the project boundary or reference sensitive system files.
 */
const FORBIDDEN_RESOURCE_PATTERNS: RegExp[] = [
  /\.\./, // Directory traversal
  /^[/\\]/, // Root directory access
  /^[A-Za-z]:[/\\]/, // Windows absolute paths (e.g. C:\)
  /^(etc|proc|sys|root|var[/\\]run|boot|dev)[/\\]/i, // System directories
  /(^|[/\\])\.env/i, // Environment files
  /(^|[/\\])\.git([/\\]|$)/i, // Git metadata
  /(^|[/\\])\.ssh([/\\]|$)/i, // SSH keys
  /(^|[/\\])id_(?:rsa|ecdsa|ed25519)/i, // Private keys
  /(^|[/\\])node_modules([/\\]|$)/i, // Dependencies
];

export function isSafeTargetResource(resource: string): boolean {
  if (!resource || resource.trim().length === 0) return false;
  const normalized = resource.replace(/\\/g, "/").trim();
  return !FORBIDDEN_RESOURCE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export const ActionTypeEnum = z.enum([
  "INFRASTRUCTURE_LOCKDOWN",
  "REMEDIATION_PATCH",
  "NETWORK_ISOLATION",
  "CREDENTIAL_REVOCATION",
  "POLICY_ENFORCEMENT",
  "ACCESS_REVOCATION",
]);

export type ActionType = z.infer<typeof ActionTypeEnum>;

export const ActionSeverityEnum = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type ActionSeverity = z.infer<typeof ActionSeverityEnum>;

/**
 * Base Zod Schema for Groq Life-Saving Action output.
 * Uses strict mode to reject unauthorized or injected extra fields.
 */
export const GroqLifeSavingActionSchema = z
  .object({
    actionType: ActionTypeEnum,
    severity: ActionSeverityEnum,
    targetResource: z
      .string()
      .min(1, "Target resource is required")
      .max(500, "Target resource path exceeds 500 characters")
      .refine(isSafeTargetResource, {
        message:
          "Target resource path contains illegal directory traversal, root paths, or sensitive file references",
      }),
    rationale: z
      .string()
      .min(1, "Rationale is required")
      .max(2000, "Rationale exceeds 2000 characters limit"),
    patchDiff: z
      .string()
      .max(65536, "Patch diff exceeds maximum allowed size of 64KB")
      .refine(
        (diff) => diff.split("\n").length <= 500,
        "Patch diff exceeds maximum boundary of 500 lines",
      )
      .optional(),
    parameters: z
      .record(
        z.string(),
        z.union([
          z.string(),
          z.number(),
          z.boolean(),
          z.array(z.string()),
          z.record(z.string(), z.unknown()),
        ]),
      )
      .optional()
      .default({}),
    metadata: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .strict();

export type GroqLifeSavingAction = z.infer<typeof GroqLifeSavingActionSchema>;

/**
 * Recursively scans and sanitizes an object:
 * 1. Prevents prototype pollution (__proto__, constructor, prototype).
 * 2. Strips harmful control characters.
 * 3. Asserts that no string contains adversarial prompt injection payloads.
 */
function deepSanitizeAndScan(val: unknown, path: string): unknown {
  if (val === null || val === undefined) {
    return val;
  }

  if (typeof val === "string") {
    // Check for prompt injection
    if (detectPromptInjection(val)) {
      throw new PromptInjectionSanitizationError(path, val);
    }
    return stripControlCharacters(val).trim();
  }

  if (Array.isArray(val)) {
    return val.map((item, index) => deepSanitizeAndScan(item, `${path}[${index}]`));
  }

  if (typeof val === "object") {
    const cleanObj: Record<string, unknown> = {};
    for (const [key, propVal] of Object.entries(val)) {
      // Prevent prototype pollution
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        continue;
      }
      const sanitizedKey = stripControlCharacters(key).trim();
      cleanObj[sanitizedKey] = deepSanitizeAndScan(propVal, `${path}.${sanitizedKey}`);
    }
    return cleanObj;
  }

  return val;
}

/**
 * Validates Groq JSON output against the strict Zod schema, sanitizes control characters,
 * verifies resource boundary constraints, and ensures all string data is free of prompt injection
 * before persisting to the Prisma ORM.
 *
 * @throws {PromptInjectionSanitizationError} If prompt injection is identified in any field.
 * @throws {GroqActionValidationError} If data violates the schema or boundary constraints.
 */
export function validateAndSanitizeGroqAction(rawOutput: unknown): GroqLifeSavingAction {
  let parsedRaw = rawOutput;

  // Handle stringified JSON from LLM output
  if (typeof rawOutput === "string") {
    try {
      parsedRaw = JSON.parse(rawOutput);
    } catch {
      throw new GroqActionValidationError(
        "Failed to parse Groq action output: invalid JSON string",
      );
    }
  }

  if (!parsedRaw || typeof parsedRaw !== "object") {
    throw new GroqActionValidationError("Groq action output must be an object");
  }

  // Pre-sanitize and scan for prompt injection across all fields
  const sanitized = deepSanitizeAndScan(parsedRaw, "root");

  // Validate with strict Zod schema
  const parseResult = GroqLifeSavingActionSchema.safeParse(sanitized);

  if (!parseResult.success) {
    throw new GroqActionValidationError(
      `Groq action validation failed: ${parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      parseResult.error.issues,
    );
  }

  // Additional check: REMEDIATION_PATCH must have a non-empty patchDiff
  const action = parseResult.data;
  if (
    action.actionType === "REMEDIATION_PATCH" &&
    (!action.patchDiff || action.patchDiff.trim().length === 0)
  ) {
    throw new GroqActionValidationError(
      "REMEDIATION_PATCH action must contain a valid, non-empty patchDiff",
    );
  }

  return action;
}

/**
 * Validates and sanitizes a batch of Groq life-saving actions.
 */
export function validateAndSanitizeGroqActionBatch(rawOutputs: unknown[]): GroqLifeSavingAction[] {
  if (!Array.isArray(rawOutputs)) {
    throw new GroqActionValidationError("Batch action input must be an array");
  }

  return rawOutputs.map((item, idx) => {
    try {
      return validateAndSanitizeGroqAction(item);
    } catch (err: any) {
      if (err instanceof PromptInjectionSanitizationError) {
        throw new PromptInjectionSanitizationError(`batch[${idx}].${err.field}`, err.snippet);
      }
      throw err;
    }
  });
}
