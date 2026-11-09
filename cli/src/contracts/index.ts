import { z } from "zod";

export const MAX_FILES_PER_REQUEST = 100;
export const MAX_FILE_CONTENT_LENGTH = 512 * 1024; // 512 KB
export const MAX_PATH_LENGTH = 1024;

/**
 * Maximum allowed HTTP request body size (10 MB aggregate limit).
 * Bounds in-memory body buffering for unauthenticated CLI scan requests (#1103).
 */
export const MAX_SCAN_REQUEST_BYTES = 10 * 1024 * 1024;

export const stagedFileForAiScanSchema = z.object({
  path: z
    .string({ message: "each file needs a non-empty string `path`" })
    .min(1, "each file needs a non-empty string `path`")
    .max(MAX_PATH_LENGTH, `each file path must not exceed ${MAX_PATH_LENGTH} characters`),
  content: z
    .string({ message: "each file needs a string `content`" })
    .max(
      MAX_FILE_CONTENT_LENGTH,
      `file content exceeds maximum size of ${MAX_FILE_CONTENT_LENGTH} characters`,
    ),
});

export type StagedFileForAiScan = z.infer<typeof stagedFileForAiScanSchema>;

export const findingSeveritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;

/**
 * Zod schema mirroring `ScanFinding` from src/lib/armor/scanner.ts.
 */
export const aiFindingSchema = z.object({
  type: z.string(),
  severity: findingSeveritySchema,
  description: z.string(),
  fileLocation: z.string(),
  codeSnippet: z.string(),
  lineStart: z.number().optional(),
  lineEnd: z.number().optional(),
  dynamicFingerprint: z.string().optional(),
  signatureVersion: z.string().optional(),
  matchedSignatures: z.array(z.string()).optional(),
  isZeroDay: z.boolean().optional(),
});

export type AiFinding = z.infer<typeof aiFindingSchema>;

export const cliScanRequestSchema = z.object({
  files: z
    .array(stagedFileForAiScanSchema)
    .min(1, `"files" array cannot be empty`)
    .max(
      MAX_FILES_PER_REQUEST,
      `"files" array cannot contain more than ${MAX_FILES_PER_REQUEST} files per request`,
    ),
  voice: z.boolean().optional(),
  summaryText: z.string().optional(),
});

export type CliScanRequest = z.infer<typeof cliScanRequestSchema>;

export const cliScanResponseSchema = z.object({
  findings: z.array(aiFindingSchema).default([]),
  audioBase64: z.string().optional(),
});

export type CliScanResponse = z.infer<typeof cliScanResponseSchema>;
