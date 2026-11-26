# Enforce Content Security Policy Headers

## Problem

Omitting Content Security Policy (CSP) headers or configuring CSP with permissive directives like `'unsafe-inline'` or `'unsafe-eval'` disables browser-level defenses against Cross-Site Scripting (XSS) and unauthorized data exfiltration.

## Example

```javascript
// Vulnerable: CSP permits unsafe inline script execution
res.setHeader("Content-Security-Policy", "default-src * 'unsafe-inline' 'unsafe-eval'");
```

## Fix

Define strict CSP response headers with restricted script sources, disallowing `'unsafe-inline'` and using cryptographic nonces for necessary inline script blocks.

```javascript
// Remediated: strict CSP with nonce
res.setHeader(
  "Content-Security-Policy",
  "default-src 'self'; script-src 'self' 'nonce-xyz123'; object-src 'none'; base-uri 'self';",
);
```
