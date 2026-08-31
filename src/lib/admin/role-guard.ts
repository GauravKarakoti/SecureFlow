/**
 * The last-administrator invariant (#658).
 *
 * `updateUserRole` and `deleteUser` both guarded against removing the final
 * ADMIN with a `count()` issued *outside* the transaction that then performed
 * the write. That is check-then-act: with exactly two admins, two demotions
 * issued close together both read 2, both pass, and both proceed. The result is
 * zero administrators, and there is no way back — `AdminLayout` redirects
 * anyone without the role and every admin action is itself admin-gated, so
 * recovery means a manual INSERT against production.
 *
 * The fix is to re-assert the invariant *after* the write and *inside* the same
 * transaction, so a violation rolls the write back. That is correct at any
 * isolation level and needs no raw SQL or advisory locks. The predicates live
 * here, separate from `src/lib/actions/admin.ts`, because that file is
 * `"use server"` and every export in it must be an async server action.
 */

export const ADMIN_ROLE = "ADMIN";

export type RoleName = "ADMIN" | "USER";

/**
 * Raised when a write would leave the application with no administrator.
 *
 * A distinct class so callers can tell an invariant rollback apart from a
 * database error, and so the message stays identical whether it was caught
 * before the write or by the post-write assertion.
 */
export class LastAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LastAdminError";
    Object.setPrototypeOf(this, LastAdminError.prototype);
  }
}

export const DEMOTE_LAST_ADMIN_MESSAGE = "Cannot demote the last remaining administrator.";
export const DELETE_LAST_ADMIN_MESSAGE = "Cannot delete the last remaining administrator.";

/** Whether `roles` includes the administrator role. */
export function hasAdminRole(roles: readonly string[]): boolean {
  return roles.includes(ADMIN_ROLE);
}

/**
 * Whether replacing `oldRoles` with `newRole` takes the administrator role away.
 *
 * Promotions and lateral moves are not interesting; only a change that ends
 * with the user not being an admin, having been one, can threaten the
 * invariant.
 */
export function removesAdminRole(oldRoles: readonly string[], newRole: RoleName): boolean {
  return newRole !== ADMIN_ROLE && hasAdminRole(oldRoles);
}

/** Whether an administrator is trying to take their own admin role away. */
export function isSelfDemotion(actorId: string, targetId: string, newRole: RoleName): boolean {
  return actorId === targetId && newRole !== ADMIN_ROLE;
}

/** Whether the user already has exactly this role and nothing else. */
export function isNoOpRoleChange(oldRoles: readonly string[], newRole: RoleName): boolean {
  return oldRoles.length === 1 && oldRoles[0] === newRole;
}

/**
 * Assert that at least one administrator remains.
 *
 * Called *after* the write, inside the transaction, so throwing rolls the write
 * back. `remaining` is therefore the post-write count, not the pre-write one.
 */
export function assertAdminsRemain(remaining: number, message: string): void {
  if (remaining < 1) {
    throw new LastAdminError(message);
  }
}

/**
 * Whether an error is a Prisma unique-constraint violation.
 *
 * `role.upsert` on `Role.name` is not atomic against a concurrent insert, so
 * two simultaneous promotions to a role that does not exist yet can surface a
 * raw P2002 to the operator. Callers use this to re-read the row instead.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}
