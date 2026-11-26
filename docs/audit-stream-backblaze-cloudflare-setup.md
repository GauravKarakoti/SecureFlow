# Backblaze B2 + Cloudflare CDN Worker Audit Stream Setup (#2097)

SecureFlow supports streaming audit log events to S3-compatible cloud storage (such as Backblaze B2) with an optional Cloudflare CDN Worker edge cache.

---

## Architecture Overview

```
SecureFlow Audit Engine
      │
      │ (Signed Batches: JSON + SHA-256 Manifest)
      ▼
Cloudflare CDN Worker (Edge Proxy & Caching)
      │
      │ (Free Egress via Bandwidth Alliance)
      ▼
Backblaze B2 Object Storage (audit-logs/batch-*.json)
```

### Why Backblaze B2 + Cloudflare?
1. **Zero Egress Fees**: Cloudflare and Backblaze are Bandwidth Alliance partners, providing free egress bandwidth between the worker and B2 buckets.
2. **Eliminates S3 API Quota Bottlenecks**: Cloudflare caches immutable batch logs at 300+ global edge locations.
3. **High Security**: Batch files are signed with SHA-256 manifests; secrets and raw code snippets are never included in stream payloads.
4. **Non-Blocking**: Sink writes operate completely asynchronously with retry and in-memory buffer caps; a sink outage will never block PR scans or user transactions.

---

## Setup Guide

### 1. Create Backblaze B2 Bucket
1. Log in to [Backblaze](https://www.backblaze.com/).
2. Under **B2 Cloud Storage**, click **Buckets** -> **Create a Bucket**.
   - Bucket Name: `secureflow-audit-logs` (or your preferred name).
   - Bucket Type: `Private`.
   - Default Encryption: `Enabled` (SSE-B2).
3. Under **App Keys**, click **Add a New Application Key**:
   - Key Name: `secureflow-audit-sink`.
   - Allow access to Bucket: `secureflow-audit-logs`.
   - Type of Access: `Read and Write`.
   - Note down: `keyID` and `applicationKey`.
4. Note your bucket endpoint (e.g., `https://s3.us-west-004.backblazeb2.com`).

---

### 2. Deploy Cloudflare CDN Worker

1. Install Wrangler or open Cloudflare Dashboard -> **Workers & Pages**:
   ```bash
   npm install -g wrangler
   ```
2. In the `workers/` directory, create `wrangler.toml`:
   ```toml
   name = "secureflow-audit-cdn-worker"
   main = "audit-cdn-worker.js"
   compatibility_date = "2024-01-01"

   [vars]
   B2_ENDPOINT = "https://s3.us-west-004.backblazeb2.com"
   B2_BUCKET = "secureflow-audit-logs"
   WORKER_AUTH_TOKEN = "your-secure-shared-token"
   ```
3. Deploy the worker:
   ```bash
   wrangler deploy
   ```
4. Note the worker URL (e.g., `https://secureflow-audit-cdn-worker.your-subdomain.workers.dev`).

---

### 3. Configure SecureFlow Environment

Add the following environment variables to your SecureFlow deployment:

```env
# Enable Audit Sink
AUDIT_SINK_ENABLED="true"
AUDIT_SINK_TYPE="backblaze"

# Backblaze B2 S3 Configuration
AUDIT_SINK_S3_ENDPOINT="https://s3.us-west-004.backblazeb2.com"
AUDIT_SINK_S3_BUCKET="secureflow-audit-logs"
AUDIT_SINK_S3_KEY_ID="your-b2-key-id"
AUDIT_SINK_S3_SECRET="your-b2-application-key"

# Optional: Cloudflare CDN Worker URL (caches reads and eliminates S3 limits)
AUDIT_SINK_CF_CDN_URL="https://secureflow-audit-cdn-worker.your-subdomain.workers.dev"
```

---

## Health Monitoring & Admin Diagnostics

Administrators can monitor the health of the audit stream sink on the Admin Dashboard (`/dashboard/admin/logs` or via `getAuditSinkHealth()`):
- **HEALTHY**: Batches successfully streaming to sink.
- **DEGRADED**: Transient failures occurring; active retries in progress.
- **FAILING**: Multiple consecutive failures (>= 3); events buffered up to local memory limit.
- **DISABLED**: Sink feature not enabled.
