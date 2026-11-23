import { z } from "zod";
import { isSafeTargetResource } from "@/lib/security/groq-actions";

/**
 * Kinds of unstructured emergency inputs the intake pipeline accepts.
 */
export const SourceInputEnum = z.enum(["text", "audio", "image"]);
export type SourceInput = z.infer<typeof SourceInputEnum>;

/**
 * Actions a LifeSavingAction can direct operators to take during an emergency.
 */
export const EmergencyActionTypeEnum = z.enum([
  "LOCKDOWN",
  "EVACUATE",
  "ISOLATE",
  "CREDENTIAL_REVOCATION",
  "NETWORK_ISOLATION",
  "POLICY_ENFORCEMENT",
  "MONITOR",
  "ALERT",
]);
export type EmergencyActionType = z.infer<typeof EmergencyActionTypeEnum>;

/**
 * Strict, structured JSON payload representing a LifeSavingAction.
 * Example: { "action": "LOCKDOWN", "target": "Hospital_DB", "confidence": 0.99 }
 */
export const LifeSavingActionSchema = z
  .object({
    action: EmergencyActionTypeEnum,
    target: z
      .string()
      .min(1, "Target is required")
      .max(200, "Target exceeds 200 characters")
      .refine(isSafeTargetResource, {
        message:
          "Target contains illegal path traversal, root paths, or sensitive file references",
      }),
    confidence: z
      .number()
      .min(0, "Confidence must be between 0 and 1")
      .max(1, "Confidence must be between 0 and 1"),
    rationale: z.string().max(1000, "Rationale exceeds 1000 characters").optional(),
    sourceInputs: z.array(SourceInputEnum).optional().default([]),
    metadata: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .strict();

export type LifeSavingAction = z.infer<typeof LifeSavingActionSchema>;

/**
 * Validated multimodal emergency intake input.
 */
export const EmergencyIntakeInputSchema = z.object({
  text: z.string().max(10000, "Text input exceeds 10000 characters").optional().default(""),
  hasAudio: z.boolean().optional(),
  hasImage: z.boolean().optional(),
  audioMimeType: z.string().optional(),
  imageMimeType: z.string().optional(),
  audioSizeBytes: z.number().int().nonnegative().optional(),
  imageSizeBytes: z.number().int().nonnegative().optional(),
});

export type EmergencyIntakeInput = z.infer<typeof EmergencyIntakeInputSchema>;

export class EmergencyIntakeError extends Error {
  public readonly statusCode: number;
  constructor(message: string, statusCode: number = 400) {
    super(message);
    this.name = "EmergencyIntakeError";
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class LifeSavingActionValidationError extends Error {
  public readonly issues: z.ZodIssue[];
  constructor(message: string, issues: z.ZodIssue[] = []) {
    super(message);
    this.name = "LifeSavingActionValidationError";
    this.issues = issues;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
