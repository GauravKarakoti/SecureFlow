# Block Plaintext HTTP Endpoints

## Problem

Configuring API clients or webhooks to use unencrypted HTTP URLs (`http://`) transmits headers, authentication tokens, cookies, and request bodies in plain text over the network, allowing adversaries on the wire to eavesdrop or execute man-in-the-middle (MitM) attacks.

## Example

```javascript
// Vulnerable: unencrypted cleartext HTTP endpoint
const endpoint = "http://api.internal-services.com/v1/auth";
const res = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } });
```

## Fix

Use HTTPS with TLS 1.3 encryption for all external communication endpoints and API clients.

```javascript
// Remediated: secure HTTPS endpoint
const endpoint = "https://api.internal-services.com/v1/auth";
const res = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } });
```
