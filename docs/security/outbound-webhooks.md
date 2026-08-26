# Outbound webhook dispatch

SecureFlow delivers notifications to URLs that come out of a job payload. That
makes the outbound worker the one component in the system that will connect to
an address someone else chose, from inside our network, with Redis and Postgres
reachable. This page describes the controls that bound it.

Everything below is implemented in `src/lib/queue/outbound-dispatch.ts` and
exercised by `src/lib/queue/outbound-dispatch.test.ts`.

## Destination policy

A destination is validated **before any socket is opened**. In order:

| Check | Rejected |
| --- | --- |
| Scheme | anything other than `http:` / `https:` |
| Transport | plaintext `http:` unless explicitly allowed (never in production) |
| Authority | a URL carrying `user:password@` |
| Allowlist | a host absent from `OUTBOUND_WEBHOOK_ALLOWED_HOSTS`, when that is set |
| Hostname | `localhost`, `*.localhost`, `*.internal`, `metadata.google.internal`, `instance-data` |
| Address literal | loopback, link-local, RFC1918, CGNAT, multicast, reserved — v4 and v6 |
| Resolved address | any of the above, after DNS |

The last row is the one that matters most. Checking only the hostname is not a
control: `hooks.attacker.example` is a perfectly ordinary public name, and it
can answer `127.0.0.1`. We resolve the name and reject the destination if *any*
returned address is internal.

Obfuscated spellings of loopback (`0x7f.0.0.1`, `2130706433`, `0177.0.0.1`,
`[::ffff:127.0.0.1]`) are handled by checking `url.hostname` after parsing
rather than the raw string — the WHATWG URL parser has already canonicalised
them by then. `::ffff:127.0.0.1` in particular is normalised to the hextet form
`::ffff:7f00:1`, which is why `isPrivateIPv6` matches both spellings.

### Redirects are never followed

Requests are dispatched with `redirect: 'manual'`. A `3xx` is treated as a
permanent delivery failure.

This is not a convenience decision. A destination allowlist that follows
redirects is not an allowlist: an allowlisted host can answer
`302 Location: http://169.254.169.254/…` and the guard has been bypassed
entirely.

## Deadlines

Every request carries `AbortSignal.timeout(OUTBOUND_WEBHOOK_TIMEOUT_MS)`,
default 10s and capped at 60s.

BullMQ has no job timeout of its own. Without this, a receiver that accepts the
TCP connection and never writes a response holds a worker slot until the process
restarts — and because the job stays in `active` rather than moving to `failed`,
it never reaches the DLQ and never appears as a problem on `/admin/queue`.

## Response handling

The response body is drained up to `OUTBOUND_WEBHOOK_MAX_RESPONSE_BYTES`
(default 64 KiB) and the rest is discarded. Two reasons:

- Under undici an unread body keeps the connection held until GC.
- The prefix we do keep is usually the only explanation of *why* a delivery
  failed. A DLQ entry that says `400` and nothing else is not actionable.

## Retry classification

| Outcome | Class | Effect |
| --- | --- | --- |
| `2xx` | success | job completes |
| `408`, `425`, `429`, `5xx` | retryable | normal BullMQ backoff |
| network error, timeout, DNS failure | retryable | normal BullMQ backoff |
| `3xx` | permanent | `UnrecoverableError` → DLQ immediately |
| any other `4xx` | permanent | `UnrecoverableError` → DLQ immediately |
| refused destination | permanent | `UnrecoverableError` → DLQ immediately |

A `404` will not become a `200` on the third attempt. Retrying it costs three
worker slots and fifteen seconds of backoff to reach the same DLQ entry we could
have written the first time.

Because `UnrecoverableError` ends the retry chain early, the `failed` handler
routes a job to the DLQ when it is either exhausted **or** unrecoverable —
checking `attemptsMade >= maxAttempts` alone would let permanently-rejected jobs
leave the queue with no record at all.

## Signatures

```
X-SecureFlow-Signature: t=1700000000,v1=<hex sha256>
X-SecureFlow-Timestamp: 1700000000
X-SecureFlow-Delivery:  <bullmq job id>
```

The HMAC is computed over `${timestamp}.${body}`, not over the body alone. A
signature over the body alone is valid forever, so a receiver has no way to
reject a replayed delivery. The `v1=` tag lets the algorithm be rotated without
a receiver having to guess which scheme it is looking at.

`verifySignatureHeader` is exported for receivers in this repository; it
compares with `timingSafeEqual` and enforces a 5-minute default tolerance.

## Logging

Dispatch logs go through `@/lib/logger` and record the destination as
**scheme + host + port only**. Most webhook providers put a token in the path or
the query string (`https://hooks.slack.com/services/T…/B…/…`), so the full URL
must never reach a log drain. Error messages follow the same rule.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `OUTBOUND_WEBHOOK_TIMEOUT_MS` | `10000` | capped at `60000` |
| `OUTBOUND_WEBHOOK_MAX_RESPONSE_BYTES` | `65536` | capped at 1 MiB |
| `OUTBOUND_WEBHOOK_ALLOWED_HOSTS` | *(empty)* | comma-separated; empty means any public host |
| `OUTBOUND_WEBHOOK_ALLOW_INSECURE_HTTP` | `false` | **ignored when `NODE_ENV=production`** |
| `OUTBOUND_WEBHOOK_ALLOW_PRIVATE_NETWORKS` | `false` | **ignored when `NODE_ENV=production`** |

The two permissive switches exist so a developer can point the worker at
`http://localhost:4000` while working on a receiver. They are read through
`resolveDispatchConfig`, which drops them unconditionally in production — an
SSRF guard that an environment variable can turn off is an SSRF guard that will
eventually be off.
