import { describe, it, expect } from 'vitest';
import {
  ADMIN_ROLE,
  DELETE_LAST_ADMIN_MESSAGE,
  DEMOTE_LAST_ADMIN_MESSAGE,
  LastAdminError,
  assertAdminsRemain,
  hasAdminRole,
  isNoOpRoleChange,
  isSelfDemotion,
  isUniqueConstraintError,
  removesAdminRole,
} from './role-guard';

describe('hasAdminRole (#658)', () => {
  it('recognises the administrator role', () => {
    expect(hasAdminRole([ADMIN_ROLE])).toBe(true);
    expect(hasAdminRole(['USER', ADMIN_ROLE])).toBe(true);
  });

  it('is false for a user with no admin role', () => {
    expect(hasAdminRole(['USER'])).toBe(false);
    expect(hasAdminRole([])).toBe(false);
  });

  it('does not match on case, since the role name is stored exactly', () => {
    expect(hasAdminRole(['admin'])).toBe(false);
  });
});

describe('removesAdminRole (#658)', () => {
  it('is true when an admin is being moved off the role', () => {
    expect(removesAdminRole(['ADMIN'], 'USER')).toBe(true);
    expect(removesAdminRole(['ADMIN', 'USER'], 'USER')).toBe(true);
  });

  it('is false for a promotion', () => {
    expect(removesAdminRole(['USER'], 'ADMIN')).toBe(false);
  });

  it('is false when the user was never an admin', () => {
    expect(removesAdminRole(['USER'], 'USER')).toBe(false);
    expect(removesAdminRole([], 'USER')).toBe(false);
  });

  it('is false when an admin stays an admin', () => {
    expect(removesAdminRole(['ADMIN'], 'ADMIN')).toBe(false);
  });
});

describe('isSelfDemotion (#658)', () => {
  it('catches an administrator taking their own role away', () => {
    expect(isSelfDemotion('admin-1', 'admin-1', 'USER')).toBe(true);
  });

  it('allows an administrator to re-apply their own admin role', () => {
    expect(isSelfDemotion('admin-1', 'admin-1', 'ADMIN')).toBe(false);
  });

  it('does not fire for a different target', () => {
    expect(isSelfDemotion('admin-1', 'user-2', 'USER')).toBe(false);
  });
});

describe('isNoOpRoleChange (#658)', () => {
  it('is true when the user already holds exactly that one role', () => {
    expect(isNoOpRoleChange(['USER'], 'USER')).toBe(true);
    expect(isNoOpRoleChange(['ADMIN'], 'ADMIN')).toBe(true);
  });

  it('is false when the user holds more than one role', () => {
    // Replacing {ADMIN, USER} with {USER} is a real change even though USER is
    // already present.
    expect(isNoOpRoleChange(['ADMIN', 'USER'], 'USER')).toBe(false);
  });

  it('is false for a user with no roles at all', () => {
    expect(isNoOpRoleChange([], 'USER')).toBe(false);
  });
});

describe('assertAdminsRemain (#658)', () => {
  it('passes when at least one administrator is left', () => {
    expect(() => assertAdminsRemain(1, DEMOTE_LAST_ADMIN_MESSAGE)).not.toThrow();
    expect(() => assertAdminsRemain(9, DEMOTE_LAST_ADMIN_MESSAGE)).not.toThrow();
  });

  it('throws a LastAdminError at zero', () => {
    expect(() => assertAdminsRemain(0, DEMOTE_LAST_ADMIN_MESSAGE)).toThrow(LastAdminError);
    expect(() => assertAdminsRemain(0, DEMOTE_LAST_ADMIN_MESSAGE)).toThrow(
      DEMOTE_LAST_ADMIN_MESSAGE
    );
  });

  it('carries the caller-supplied message, so demote and delete read differently', () => {
    expect(() => assertAdminsRemain(0, DELETE_LAST_ADMIN_MESSAGE)).toThrow(
      DELETE_LAST_ADMIN_MESSAGE
    );
  });

  it('treats a negative count as a violation rather than passing it through', () => {
    expect(() => assertAdminsRemain(-1, DEMOTE_LAST_ADMIN_MESSAGE)).toThrow(LastAdminError);
  });

  it('is an Error subclass, so existing catch/rejects.toThrow keeps working', () => {
    const err = new LastAdminError('x');

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LastAdminError');
  });
});

describe('isUniqueConstraintError (#658)', () => {
  it('recognises Prisma P2002', () => {
    expect(isUniqueConstraintError({ code: 'P2002' })).toBe(true);
  });

  it('is false for anything else', () => {
    expect(isUniqueConstraintError({ code: 'P2025' })).toBe(false);
    expect(isUniqueConstraintError(new Error('boom'))).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
    expect(isUniqueConstraintError(undefined)).toBe(false);
  });
});
