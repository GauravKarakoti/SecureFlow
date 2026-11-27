# Require MFA for Privileged Accounts

## Problem

Allowing administrator or elevated operator accounts to authenticate using single-factor passwords alone leaves systems highly vulnerable to credential stuffing, password reuse, and phishing compromises.

## Example

```javascript
// Vulnerable: admin privilege granted with single-factor password
if (user.role === "ADMIN" && passwordMatches) {
  grantAdminAccess(res);
}
```

## Fix

Enforce mandatory multi-factor authentication (TOTP or FIDO2/WebAuthn) for administrative and privileged users before granting access.

```javascript
// Remediated: verify MFA code before granting admin session
if (user.role === "ADMIN") {
  if (!user.mfaSecret || !verifyTotpToken(user.mfaSecret, req.body.mfaCode)) {
    throw new Error("MFA authentication required for administrative actions");
  }
}
grantAdminAccess(res);
```
