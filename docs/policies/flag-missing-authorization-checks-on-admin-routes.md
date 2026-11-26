# Flag Missing Authorization Checks on Admin Routes

## Problem

API endpoints or server actions residing under an administrative namespace that verify only whether a user is logged in (authentication) but omit role or permission verification (authorization) permit standard users to trigger privileged operations (Broken Access Control - OWASP A01).

## Example

```javascript
// Vulnerable: verifies session exists but not user role or permissions
export async function deleteOrganization(orgId) {
  const session = await auth();
  if (!session) throw new Error("Unauthorized");
  await db.org.delete({ where: { id: orgId } });
}
```

## Fix

Check specific user permissions or roles before executing administrative routines.

```javascript
// Remediated: check admin permission before deletion
export async function deleteOrganization(orgId) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  if (!can(session.user, null, "admin:delete_org")) {
    throw new Error("Forbidden: Admin permissions required");
  }
  await db.org.delete({ where: { id: orgId } });
}
```
