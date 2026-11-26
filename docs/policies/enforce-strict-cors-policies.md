# Enforce Strict CORS Policies

## Problem
Configuring Cross-Origin Resource Sharing (CORS) with wildcard origins (`Access-Control-Allow-Origin: *`) on authenticated or private endpoints allows malicious third-party websites to execute cross-origin requests via victim browsers and read confidential responses.

## Example
```javascript
// Vulnerable: wildcard origin allows any website to read API responses
app.use(cors({ origin: "*", credentials: true }));
```

## Fix
Explicitly declare allowed domain origins, or evaluate origin headers dynamically against an approved domain allowlist.

```javascript
// Remediated: allow only specific trusted frontends
const ALLOWED_ORIGINS = new Set(["https://app.secureflow.dev"]);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.has(origin)) {
      callback(null, true);
    } else {
      callback(new Error("CORS origin forbidden"));
    }
  },
  credentials: true,
}));
```
