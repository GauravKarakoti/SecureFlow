import { z } from "zod";
import { STORED_SEVERITIES, type StoredSeverity } from "@/lib/severity";

export const POLICY_SEVERITIES = STORED_SEVERITIES;

export const editPolicySchema = z.object({
  templateId: z.string().trim().min(1, "Missing policy template ID").max(64),
  description: z.string().trim().min(1, "Policy description cannot be empty").max(4096),
  severity: z.enum(STORED_SEVERITIES as unknown as [string, ...string[]]),
  action: z.string().trim().min(1).max(64).optional(),
});

export type EditPolicyInput = z.infer<typeof editPolicySchema>;

export const rollbackPolicySchema = z.object({
  templateId: z.string().trim().min(1, "Missing policy template ID").max(64),
  versionId: z.string().trim().min(1, "Missing target version ID").max(64),
});

export type RollbackPolicyInput = z.infer<typeof rollbackPolicySchema>;

export interface PolicyVersionDto {
  id: string;
  policyTemplateId: string;
  versionNumber: number;
  name: string;
  description: string;
  severity: string;
  action: string;
  rules: unknown;
  createdAt: string;
  editor: {
    id: string;
    name?: string | null;
    email?: string | null;
    codename?: string | null;
  };
}

export interface DiffLine {
  type: "added" | "removed" | "unchanged";
  content: string;
}

/**
 * Computes a basic line-by-line diff between two text strings for side-by-side or unified view.
 */
export function computeTextDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  const diff: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      diff.push({ type: "unchanged", content: oldLines[i] });
      i++;
      j++;
    } else {
      // Simple lookahead
      if (oldLines.slice(i + 1).includes(newLines[j])) {
        diff.push({ type: "removed", content: oldLines[i] });
        i++;
      } else if (newLines.slice(j + 1).includes(oldLines[i])) {
        diff.push({ type: "added", content: newLines[j] });
        j++;
      } else {
        diff.push({ type: "removed", content: oldLines[i] });
        diff.push({ type: "added", content: newLines[j] });
        i++;
        j++;
      }
    }
  }

  while (i < oldLines.length) {
    diff.push({ type: "removed", content: oldLines[i] });
    i++;
  }

  while (j < newLines.length) {
    diff.push({ type: "added", content: newLines[j] });
    j++;
  }

  return diff;
}
