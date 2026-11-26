# 🌐 @secureflow/api-client

Typed TypeScript client for the SecureFlow REST API, automatically generated from [`openapi.yaml`](../../openapi.yaml).

---

## 📦 Installation

Add `@secureflow/api-client` to your package:

```bash
# Using npm
npm install @secureflow/api-client

# Or within the SecureFlow monorepo workspace
npm install @secureflow/api-client --workspace=your-app
```

---

## 🚀 Quickstart & Example Usage

Authenticate using a **Personal API Token** (`sft_<hex>`) generated in SecureFlow Mission Control (**Settings** -> **API Tokens**):

```typescript
import { createSecureFlowClient } from "@secureflow/api-client";

// Initialize client
const client = createSecureFlowClient({
  baseUrl: process.env.SECUREFLOW_API_URL || "https://secure-flow-six.vercel.app",
  token: process.env.SECUREFLOW_API_TOKEN, // e.g. "sft_0123456789abcdef..."
});

async function main() {
  try {
    // 1. Fetch recent security findings with typed query parameters
    const { data: findingsList } = await client.get("/api/findings", {
      params: {
        query: {
          severity: "CRITICAL",
          status: "OPEN",
          limit: 20,
        },
      },
    });

    console.log(`Found ${findingsList.total} critical findings:`);
    for (const finding of findingsList.findings) {
      console.log(`- [${finding.severity}] ${finding.type} in ${finding.fileLocation}`);
    }

    // 2. Trigger an automated AI remediation patch
    if (findingsList.findings.length > 0) {
      const findingId = findingsList.findings[0].id;
      const { data: patch } = await client.post("/api/findings/{id}/remediate", {
        params: {
          path: { id: findingId },
        },
        body: {
          instruction: "Use environment variables instead of hardcoded secrets",
        },
      });

      console.log(`Generated patch status: ${patch.status}`);
      console.log(`Diff preview:\n${patch.diff}`);
    }
  } catch (error: any) {
    if (error.name === "ApiError") {
      console.error(`API Error (${error.status}):`, error.message);
    } else {
      console.error("Network or unexpected error:", error);
    }
  }
}

main();
```

---

## 🛡️ Authentication

The client supports both Bearer token authentication and cookie-based NextAuth session authentication:

- **Personal API Token (Bearer)**:
  Pass the token in `createSecureFlowClient({ token: 'sft_...' })`. The client attaches `Authorization: Bearer <token>` on all requests.
- **Custom Headers**:
  Pass arbitrary headers in options:
  ```typescript
  const client = createSecureFlowClient({
    baseUrl: "https://api.secureflow.dev",
    headers: {
      "X-Custom-Header": "value",
    },
  });
  ```

---

## 🔄 Type Generation & Synchronization

The types in `src/schema.ts` are derived from the root OpenAPI specification (`openapi.yaml`).

To regenerate or verify types:

```bash
# Regenerate TypeScript types from openapi.yaml
npm run client:generate

# Check if generated types have drifted from openapi.yaml (runs in CI)
npm run client:check-drift
```
