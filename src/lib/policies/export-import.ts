import { z } from "zod";

/**
 * Maximum permitted size for policy export/import files (1 MB).
 */
export const MAX_POLICY_FILE_BYTES = 1024 * 1024;

/**
 * Maximum number of policies allowed in a single import file.
 */
export const MAX_POLICY_IMPORT_COUNT = 100;

/**
 * Stored finding severities accepted by Prisma & SecureFlow policies.
 */
export const POLICY_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;

/**
 * Schema for an individual policy item inside the export/import bundle.
 * Disallows unknown fields with `.strict()`.
 * Never permits executable scripts or internal identifiers.
 */
export const policyBundleItemSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Policy name cannot be empty")
      .max(128, "Policy name cannot exceed 128 characters"),
    description: z
      .string()
      .trim()
      .min(1, "Policy description cannot be empty")
      .max(2048, "Policy description cannot exceed 2048 characters"),
    severity: z.enum(POLICY_SEVERITIES),
    enabled: z.boolean(),
    action: z
      .string()
      .trim()
      .max(64, "Policy action cannot exceed 64 characters")
      .optional()
      .default("REVIEW REQUIRED"),
    rules: z
      .union([
        z.array(z.string().trim().max(256)).max(50),
        z.object({
          conditions: z.array(z.string().trim().max(256)).max(50),
        }),
      ])
      .optional()
      .default([]),
    complianceTags: z.array(z.string().trim().max(64)).max(20).optional().default([]),
  })
  .strict();

export type PolicyBundleItem = z.infer<typeof policyBundleItemSchema>;

/**
 * Versioned schema for the complete policy export/import file.
 * Disallows unknown keys (`.strict()`) to prevent unrecognized payloads.
 */
export const policyExportFileSchema = z
  .object({
    version: z.literal("1.0"),
    exportedAt: z.string().optional(),
    policies: z
      .array(policyBundleItemSchema)
      .min(1, "Policy file contains no policies")
      .max(
        MAX_POLICY_IMPORT_COUNT,
        `Policy bundle exceeds limit of ${MAX_POLICY_IMPORT_COUNT} policies`,
      ),
  })
  .strict();

export type PolicyExportFile = z.infer<typeof policyExportFileSchema>;

/**
 * Parse and validate an unknown payload against the policy bundle schema.
 */
export function validatePolicyImportPayload(data: unknown): {
  success: boolean;
  data?: PolicyExportFile;
  error?: string;
} {
  const parsed = policyExportFileSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
      .join("; ");
    return {
      success: false,
      error: `Invalid policy import file: ${issues}`,
    };
  }
  return {
    success: true,
    data: parsed.data,
  };
}

/**
 * Item in the import preview describing what will be created vs updated.
 */
export interface PolicyImportPreviewItem {
  name: string;
  description: string;
  severity: (typeof POLICY_SEVERITIES)[number];
  enabled: boolean;
  action: string;
  status: "create" | "update" | "unchanged";
  existingId?: string;
  diff?: {
    descriptionChanged?: boolean;
    severityChanged?: boolean;
    enabledChanged?: boolean;
  };
}

/**
 * Summary preview of an import file compared against the user's current database state.
 */
export interface PolicyImportPreview {
  valid: boolean;
  totalInFile: number;
  toCreate: number;
  toUpdate: number;
  unchanged: number;
  items: PolicyImportPreviewItem[];
}

/**
 * Computes an import preview comparing proposed policies with existing templates & user toggles.
 */
export function computeImportPreview(
  incomingPolicies: PolicyBundleItem[],
  existingTemplates: Array<{
    id: string;
    name: string;
    description: string;
    severity: string;
    action: string;
    isDefault: boolean;
  }>,
  userToggles: Array<{
    policyTemplateId: string;
    isActive: boolean;
  }>,
): PolicyImportPreview {
  const toggleMap = new Map(userToggles.map((t) => [t.policyTemplateId, t.isActive]));
  const templateByName = new Map(
    existingTemplates.map((t) => [
      t.name.trim().toLowerCase(),
      {
        ...t,
        isActive: toggleMap.has(t.id) ? toggleMap.get(t.id)! : t.isDefault,
      },
    ]),
  );

  let toCreate = 0;
  let toUpdate = 0;
  let unchanged = 0;

  const items: PolicyImportPreviewItem[] = incomingPolicies.map((incoming) => {
    const existing = templateByName.get(incoming.name.trim().toLowerCase());

    if (!existing) {
      toCreate++;
      return {
        name: incoming.name,
        description: incoming.description,
        severity: incoming.severity,
        enabled: incoming.enabled,
        action: incoming.action ?? "REVIEW REQUIRED",
        status: "create",
      };
    }

    const descriptionChanged = existing.description.trim() !== incoming.description.trim();
    const severityChanged = existing.severity !== incoming.severity;
    const enabledChanged = existing.isActive !== incoming.enabled;

    const hasChanges = descriptionChanged || severityChanged || enabledChanged;

    if (hasChanges) {
      toUpdate++;
      return {
        name: incoming.name,
        description: incoming.description,
        severity: incoming.severity,
        enabled: incoming.enabled,
        action: incoming.action ?? existing.action,
        status: "update",
        existingId: existing.id,
        diff: {
          descriptionChanged,
          severityChanged,
          enabledChanged,
        },
      };
    }

    unchanged++;
    return {
      name: incoming.name,
      description: incoming.description,
      severity: incoming.severity,
      enabled: incoming.enabled,
      action: incoming.action ?? existing.action,
      status: "unchanged",
      existingId: existing.id,
    };
  });

  return {
    valid: true,
    totalInFile: incomingPolicies.length,
    toCreate,
    toUpdate,
    unchanged,
    items,
  };
}
