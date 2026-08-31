/**
 * Input parsing and result shapes for the policy rule toggle (#660).
 *
 * Split out of `src/app/dashboard/policies/actions.ts` because that file is
 * `"use server"`: everything exported from it becomes a callable server action,
 * so a schema, a type, or a pure helper cannot live there.
 */

import { z } from 'zod';

/**
 * What the toggle accepts.
 *
 * The important part is `isActive`: the *desired* state, not the previous one.
 *
 * The action used to take a `FormData` carrying `currentState` and write
 * `!currentState`. `PolicyCard` already knew what the user wanted — the
 * `checked` argument to `onCheckedChange` — and threw it away, sending the
 * `isActive` prop instead, which does not change until the server component
 * re-renders after `revalidatePath`. Two clicks before that landed therefore
 * sent the same `currentState` and wrote the same value twice: the switch read
 * off, the database said on, and the revalidation snapped it back on with no
 * explanation. The rule the user had just disabled was still being compiled
 * into the guardrail.
 *
 * Taking the desired state makes the operation idempotent, which is what a
 * toggle should be: "set this rule to on" applied twice is on.
 */
export const togglePolicySchema = z.object({
  templateId: z.string().trim().min(1, 'Missing policy template').max(64),
  isActive: z.boolean(),
});

export type TogglePolicyInput = z.infer<typeof togglePolicySchema>;

export interface TogglePolicyResult {
  ok: boolean;
  /** Present when `ok` is false; safe to show to the user. */
  error?: string;
  /** The state now stored, so the client can settle on the truth. */
  isActive?: boolean;
}

export const TOGGLE_ERRORS = {
  unauthenticated: 'Your session has expired. Sign in again to change rules.',
  invalidInput: 'That rule could not be identified.',
  notFound: 'That rule no longer exists.',
  failed: 'The rule could not be updated. Please try again.',
} as const;

/**
 * Parse an unknown payload into a valid toggle request.
 *
 * `formData.get("templateId") as string` asserted away both the `null` and the
 * `File` case, so a missing field reached Prisma as `policyTemplateId: null`
 * and surfaced as a raw foreign-key violation out of a server action — an
 * unhandled digest error rather than anything the UI could render. Server
 * actions are POST endpoints reachable by anyone with a session, so the payload
 * is not constrained to what `PolicyCard` happens to send.
 */
export function parseToggleInput(input: unknown): TogglePolicyInput | null {
  const parsed = togglePolicySchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/**
 * Accept the legacy `FormData` shape as well as the typed object.
 *
 * Kept so a form posting directly to the action — the progressive-enhancement
 * path a server action is meant to support — still works. `isActive` is read
 * as the desired state; a payload that only carries the old `currentState` is
 * rejected rather than guessed at, because inverting a value the client may
 * have read minutes ago is the bug this change exists to remove.
 */
export function normalizeToggleInput(input: unknown): TogglePolicyInput | null {
  if (typeof FormData !== 'undefined' && input instanceof FormData) {
    const templateId = input.get('templateId');
    const isActive = input.get('isActive');

    if (typeof templateId !== 'string' || typeof isActive !== 'string') return null;

    return parseToggleInput({ templateId, isActive: isActive === 'true' });
  }

  return parseToggleInput(input);
}
