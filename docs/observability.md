# Logging

`src/lib/logger.ts` is the application logger. It is dependency-free on purpose:
the same module has to run unchanged in the Next.js server runtime, inside the
standalone Docker image, and in the plain `tsx` worker, and a transport that
works in one of those and not the others is worse than `console`.

## Prometheus Metrics (#1143)

SecureFlow exposes application telemetry at `GET /api/metrics/landing`. The
endpoint is public, rate-limited, and cached (30 s TTL) to protect the database
from scrape storms.

### Kubernetes — Prometheus Operator ServiceMonitor

The Helm chart at `helm/secureflow/` ships a `ServiceMonitor` CRD that tells a
Prometheus Operator to scrape this endpoint automatically.

**Enable it:**

```bash
helm install secureflow ./helm/secureflow \
  --set serviceMonitor.enabled=true \
  --set serviceMonitor.additionalLabels.release=kube-prometheus-stack
```

The `additionalLabels.release` value must match the label your Prometheus
Operator's `serviceMonitorSelector` looks for (commonly `release: kube-prometheus-stack`).

**Key defaults** (override in `values.yaml` or with `--set`):

| Key | Default | Description |
|-----|---------|-------------|
| `serviceMonitor.enabled` | `false` | Deploy the ServiceMonitor CRD |
| `serviceMonitor.path` | `/api/metrics/landing` | Scrape path |
| `serviceMonitor.interval` | `30s` | Scrape interval |
| `serviceMonitor.scrapeTimeout` | `10s` | Per-scrape timeout |
| `serviceMonitor.namespace` | release namespace | Where to deploy the CRD |

**Verify scraping is working:**

```bash
# Check the ServiceMonitor was created
kubectl get servicemonitor -n <namespace>

# Check Prometheus has picked it up
# Open Prometheus UI → Status → Targets → search for secureflow
```

`src/lib/logger.ts` is the application logger. It is dependency-free on purpose:
the same module has to run unchanged in the Next.js server runtime, inside the
standalone Docker image, and in the plain `tsx` worker, and a transport that
works in one of those and not the others is worse than `console`.

## Using it

```ts
import { logger } from "@/lib/logger";

logger.info("Scan complete", { repository: repo.fullName, findings: findings.length });
logger.error("Scan failed", { error, deliveryId });
```

### Correlation

One GitHub delivery fans out across the webhook route, the BullMQ job, the
scanner, the AI flow and the outbound webhook worker. Bind the delivery ID once
and every record from that chain carries it:

```ts
const log = logger.child({ deliveryId });
log.info("Processing delivery"); // → { ..., "deliveryId": "72d3162e-…" }
```

Child contexts merge and never leak back to the parent.

## Levels

| Level   | Use                                                                      |
| ------- | ------------------------------------------------------------------------ |
| `debug` | Query shapes, cache hits, per-file scanner decisions. Off in production. |
| `info`  | Lifecycle events worth keeping: delivery queued, scan complete.          |
| `warn`  | Degraded but handled: rate-limit fallback, AI timeout with a retry.      |
| `error` | Something failed and a human may need to act.                            |

`LOG_LEVEL` sets the threshold. Defaults:

| Environment                     | Default |
| ------------------------------- | ------- |
| `NODE_ENV=development`          | `debug` |
| `VITEST=true` / `NODE_ENV=test` | `error` |
| anything else                   | `info`  |

Under test the threshold is `error` rather than `silent`: quiet enough that
`vitest run` is not interleaved with worker and scanner chatter, but a test that
fails silently is worse than a noisy one.

An unrecognised `LOG_LEVEL` falls back to the default rather than silencing
production.

## Output

JSON in production so a log drain can index it; a single readable line in
development, because a wall of JSON is what makes people reach for
`console.log` in the first place. `warn` and `error` go to stderr, which is how
Render and Docker separate the two streams.

## Safety guarantees

Three things happen to every record before it is written.

**1. Newlines are stripped (CWE-117).** Repository names, PR titles and branch
names all come from GitHub, and every line-based aggregator treats an embedded
`\n` as a record boundary — a repository named
`foo\n{"level":"INFO","message":"scan passed"}` is otherwise enough to forge an
entry. `U+2028` and `U+2029` are stripped too; several JSON parsers treat them as
terminators. Tabs are kept, since they are not separators and they keep stack
traces readable.

This used to be a local helper in `src/lib/queue/worker.ts`, so exactly one
module out of eighteen was protected.

**2. Credentials are redacted, by key and by value.** Keys matching `password`,
`secret`, `token`, `apiKey`, `authorization`, `signature`, `database_url` and
friends are replaced wholesale; values are run through `scrubCredentials()` from
`src/lib/redaction.ts`, which catches connection strings and `KEY=value` pairs
that appear in free text.

Note the asymmetry with client-facing errors: `scrubSensitiveData()` _also_
strips filesystem paths, which is right for a message shown to a caller but
wrong here — in a scanner log, `src/lib/armor/scanner.ts` is the single most
useful field in the record. The logger applies only the credential pass.

**3. Structures are bounded.** Depth 4, 50 array entries, 2,000 characters per
value, 4,000 per message, with cycles replaced by `[Circular]`. A Prisma error
carries request/response objects that reference each other, and without this the
logger is the thing that crashes.

## What not to do

- Don't reach for `console.log` — there is no level gate, no redaction and no
  correlation ID on it.
- Don't log a whole webhook payload or an AI response body. Log the identifiers
  and the counts.
- Don't pre-format metadata into the message string. `logger.info('scan done',
{ repo })` is queryable; `logger.info(\`scan done for ${repo}\`)` is not.
