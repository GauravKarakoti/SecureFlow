# API rate limiting

SecureFlow limits API traffic in two places, and they now agree with each other.

| Layer | Where | Applies to |
| --- | --- | --- |
| Middleware | `src/proxy.ts` | every `/api` request, before routing |
| Route handler | `withRateLimit` in `src/lib/middleware/rate-limit.ts` | the routes that opt in |

The middleware layer is the one that fires for essentially every request, so its
policy is what most callers actually experience.

## Classes

`src/lib/api-rate-limit-policy.ts` maps a pathname to a class. Classification is
a pure function of the path, so it is testable without a request, a Redis or a
session.

| Class | Paths | Budget | Redis prefix |
| --- | --- | --- | --- |
| `exempt` | `/api/webhooks/**`, `/api/health`, `/api/ready`, anything outside `/api` | — | — |
| `auth` | `/api/auth/**` | 60 / 60s | `api:auth` |
| `stream` | `/api/heist-transmission`, `/api/og/heist`, `**/explain-stream` | 20 / 60s | `api:stream` |
| `standard` | everything else under `/api` | 20 / 60s | `api:standard` |

Each class gets its own Upstash limiter with its own key prefix. Sharing a
prefix would put the classes back into one bucket, which is the thing the
classes exist to prevent.

`standard` keeps the previous global number, so nothing that worked before
changes.

## Why the exemptions exist

### `/api/webhooks/github`

GitHub delivers webhooks from a small pool of source addresses. Under a single
IP-keyed bucket, every hook for every installation collapses onto a handful of
keys. Twenty pull-request events inside a minute — a merge train, a bot pushing
to several PRs, an `installation_repositories` burst after an app install — and
the twenty-first delivery gets a `429`.

GitHub records that as a failed delivery and **does not retry a 4xx**. The scan
is lost, and the only trace is a `429` in the access log.

It is also the wrong control for that route. The endpoint is authenticated by
HMAC signature (`verifyGitHubSignature`) and deduplicated on `x-github-delivery`
at both the queue and the worker. It is not an anonymous surface that needs an
IP bucket in front of it.

### `/api/health`, `/api/ready`

A platform health check that gets rate-limited is read as an outage. That is the
opposite of what a probe is for.

## Why `auth` is separate and larger

`/api/auth/session` is polled by the client and `/api/auth/callback/github` is
the OAuth return leg. On a shared egress IP — an office, a university lab, a
corporate VPN, which is exactly where a team of reviewers sits — twenty requests
a minute across *all* users behind that NAT is not much.

When the limit trips mid-callback, the user receives a JSON `429` body where the
OAuth redirect should have been. That reads as "login is broken", not "you are
going too fast".

Giving `auth` its own prefix also means a burst of dashboard fetches cannot
consume the budget an OAuth callback needs.

## Response headers

Both layers now emit the same set:

```
X-RateLimit-Limit:     20
X-RateLimit-Remaining: 0
X-RateLimit-Reset:     1700000030      (epoch seconds)
Retry-After:           30              (429 responses only)
```

`Retry-After` is the time actually left in the window, not the full window
length — a caller blocked one second into a 60s window should not be told to
wait 60 seconds. `X-RateLimit-Reset` is in epoch seconds, matching the GitHub
API convention this project already talks to.

Before this, the middleware 429 carried none of these while the route-level one
carried all four. A client cannot back off correctly against a limiter that will
not say when the window rolls over.

## Path normalisation

Paths are lower-cased, collapsed on repeated slashes and stripped of a trailing
slash before matching, and prefixes match on a segment boundary.

Both directions matter:

- `/API/Webhooks//GitHub/` must reach the exemption. An exemption that a
  different spelling falls through is a request that gets limited when it should
  not have been.
- `/api/webhooks-admin` must **not** reach it. A raw `startsWith` would have
  exempted it.

## Client IP

The bucket key comes from `getClientIp`, which derives the address from the
trusted suffix of the forwarding chain (`TRUSTED_PROXY_HOP_COUNT` /
`TRUSTED_PROXY_IPS`). Reading a client-supplied header would let a caller mint a
fresh bucket on every request and make every limit in the application
decorative.

## When Upstash is not configured

`getApiRateLimiter` returns `null` and the middleware skips limiting rather than
failing the request. Local development and CI therefore run unlimited, which is
the existing behaviour.
