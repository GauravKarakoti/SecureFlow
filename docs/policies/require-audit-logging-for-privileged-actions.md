# Require Audit Logging for Privileged Actions

## Problem
Executing administrative operations—such as toggling security policies, deleting accounts, changing user roles, or rotating keys—without creating persistent audit log events leaves organizations blind during post-incident forensics and compromises compliance certifications (SOC 2, ISO 27001).

## Example
```javascript
// Vulnerable: administrative state mutation with no audit record
export async function disableUser(userId) {
  await db.user.update({ where: { id: userId }, data: { disabled: true } });
}
```

## Fix
Record an immutable audit log entry capturing the acting user, target resource, mutated state, and timestamp inside the same transaction.

```javascript
// Remediated: atomic audit logging
export async function disableUser(userId, actorId) {
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { disabled: true } });
    await tx.auditLog.create({
      data: {
        userId: actorId,
        action: "USER_DISABLED",
        resource: `user:${userId}`,
        decision: "MUTATED",
      },
    });
  });
}
```
