# 📜 API Versioning and Deprecation Policy

This document defines the versioning strategy, breaking change definitions, deprecation lifecycle, and machine-readable deprecation signals for the SecureFlow REST API.

---

## 📌 Versioning Strategy

SecureFlow adopts a predictable REST API evolution policy:

- **Version Prefix**:
  All public API endpoints reside under the `/api` namespace (with path-level resource grouping, e.g., `/api/findings`, `/api/repositories`, `/api/scans`).
  When incompatible structural changes are introduced across the entire API contract, major version prefixes (e.g., `/api/v2`) will be introduced while legacy endpoints remain active for the deprecation transition period.
- **Backwards Compatibility Commitment**:
  We treat our API contract as a commitment to external integrators, CI/CD pipelines, and CLI clients. Existing endpoints will not be modified incompatibly or removed without advance notification and a formal deprecation period.

---

## ⚠️ What Counts as a Breaking Change?

The following changes are classified as **breaking**:

1. **Removing an Endpoint or HTTP Method**:
   Deleting a route or withdrawing support for an existing HTTP method (e.g., removing `GET /api/findings/{id}`).
2. **Removing or Renaming Fields**:
   Removing an existing field from a JSON response or renaming a query/path parameter.
3. **Adding Required Parameters or Request Body Fields**:
   Adding a new required query parameter, path parameter, header, or mandatory JSON body property.
4. **Altering Field Types or Enums**:
   Changing a property from a `string` to an `object`, or narrowing the valid accepted enum values on request payloads.
5. **Changing HTTP Status Codes or Semantics**:
   Changing success responses from `200 OK` to an incompatible format or fundamentally altering authentication schemes.

### 🟢 Non-Breaking Changes (Backwards-Compatible)

The following changes are considered **non-breaking** and may be introduced in minor/patch releases:

- Adding new endpoints.
- Adding optional query parameters or optional request body properties.
- Adding new properties to response JSON objects (integrator clients should ignore unknown fields).
- Adding new values to extensible response enum fields.

---

## ⏳ Deprecation Period & Lifecycle

Before any endpoint, parameter, or behavior is sunset, it moves through a structured deprecation process:

```
┌────────────────────────────┐
│ 1. Active / Stable         │
│ Supported and documented   │
└─────────────┬──────────────┘
              │
              ▼
┌────────────────────────────┐
│ 2. Deprecated              │
│ - Marked in openapi.yaml   │
│ - Returns Deprecation &    │
│   Sunset HTTP headers      │
│ - Minimum 6-month window   │
└─────────────┬──────────────┘
              │
              ▼
┌────────────────────────────┐
│ 3. Sunset / Retired        │
│ Returns 410 Gone with      │
│ replacement migration link │
└────────────────────────────┘
```

1. **Deprecation Notice**:
   An endpoint is marked with `deprecated: true` in `openapi.yaml` and documented in release notes.
2. **Deprecation Period Duration**:
   Deprecated endpoints remain fully functional in production for a **minimum of 6 months** (180 days) from the date of deprecation announcement.
3. **Deprecation & Sunset HTTP Headers**:
   Every response served from a deprecated route returns standard IETF RFC 8594 / RFC 9651 response headers (see below).
4. **Sunset**:
   After the sunset date passes, the endpoint is retired and returns `410 Gone` (or redirects) with migration instructions to the successor endpoint.

---

## 📡 Machine-Readable Response Headers (RFC 8594)

To give automated tooling, CLI clients, and integrators advance warning in logs and observability platforms, all deprecated endpoints emit:

| Header            | Format                                          | Example                                                       | Description                                                                   |
| :---------------- | :---------------------------------------------- | :------------------------------------------------------------ | :---------------------------------------------------------------------------- |
| **`Deprecation`** | Date (IMF-fixdate or boolean `@1`)              | `Sun, 01 Nov 2026 00:00:00 GMT`                               | Indicates the endpoint is deprecated and when deprecation began.              |
| **`Sunset`**      | Date (IMF-fixdate, RFC 7231 / RFC 8594)         | `Fri, 30 Apr 2027 00:00:00 GMT`                               | The date on which the endpoint is scheduled to become completely unavailable. |
| **`Link`**        | `rel="sunset"` and/or `rel="successor-version"` | `<https://.../api/webhooks/generic>; rel="successor-version"` | Hyperlink to replacement documentation or successor endpoint.                 |

### Example Response

```http
HTTP/1.1 200 OK
Content-Type: application/json
Deprecation: Sun, 01 Nov 2026 00:00:00 GMT
Sunset: Fri, 30 Apr 2027 00:00:00 GMT
Link: </api/webhooks/generic>; rel="successor-version"

{
  "message": "Webhook received"
}
```

---

## 🛠️ Implementation in SecureFlow

Route handlers mark deprecation using the `withDeprecation` / `addDeprecationHeaders` helper from `@/lib/api/deprecation`:

```typescript
import { withDeprecation } from "@/lib/api/deprecation";

export const POST = withDeprecation(handler, {
  deprecatedAt: new Date("2026-11-01T00:00:00Z"),
  sunsetAt: new Date("2027-05-01T00:00:00Z"),
  successorUrl: "/api/webhooks/generic",
});
```
