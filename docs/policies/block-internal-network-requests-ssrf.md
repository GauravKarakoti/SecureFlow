# Block Internal Network Requests (SSRF)

## Problem

Server-Side Request Forgery (SSRF) occurs when an application receives a user-controllable destination URL and makes backend HTTP/network requests without validating the target address. Malicious users can force the server to connect to internal services (localhost, RFC 1918 subnets) or cloud provider metadata endpoints (`169.254.169.254`) to exfiltrate IAM credentials.

## Example

```javascript
// Vulnerable: fetching user-supplied URL directly without IP or host validation
const response = await fetch(req.query.avatarUrl);
const imageBuffer = await response.buffer();
```

## Fix

Validate URLs against an allowlist of permitted external schemes and domains, and reject private IP ranges (RFC 1918) and cloud metadata addresses before dispatching requests.

```javascript
// Remediated: validate scheme, hostname, and private IP ranges
const targetUrl = new URL(req.query.avatarUrl);
if (targetUrl.protocol !== "https:") {
  throw new Error("Only secure HTTPS URLs are permitted");
}
if (isPrivateOrMetadataIp(targetUrl.hostname)) {
  throw new Error("Access to internal destinations is strictly forbidden");
}
const response = await fetch(targetUrl.href);
```
