# Flag Long-Lived or Non-Expiring Access Tokens

## Problem
Issuing authentication tokens, API credentials, or session cookies without expiration timestamps or with excessively long lifetimes (e.g., years) drastically increases the window of vulnerability if a secret token is intercepted, logged, or leaked.

## Example
```javascript
// Vulnerable: JWT issued without expiration lifetime
const token = jwt.sign({ userId: user.id }, JWT_SECRET);
```

## Fix
Enforce short token lifetimes (e.g. 15 to 60 minutes) and use refresh token rotation for session renewal.

```javascript
// Remediated: explicit expiration timestamp
const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "1h" });
```
