# HTTP security response headers

SecureFlow sets a security-header baseline on every response. The policy is
built by `src/lib/security-headers.ts` and attached in two places.

## Where the headers come from

| Layer | Covers | Why |
| --- | --- | --- |
| `next.config.ts` → `headers()` | Pages, static assets, `/api/*` | Applied by the routing layer to everything that reaches it. |
| `src/proxy.ts` → `secured()` | Middleware short-circuits only | The admin guard's 401/403/redirects and the `/api/og` rate limiter's 429 return *before* the routing layer, so `headers()` never sees them. |

`secured()` is deliberately **not** applied to `NextResponse.next()`. That
response continues on to the routing layer, which would attach a second
`Content-Security-Policy`. Browsers intersect multiple CSP headers, so a
duplicate does not merely repeat the policy — it silently produces one stricter
than either header alone, and the resulting breakage is very hard to trace.

## The header set

| Header | Value | Rationale |
| --- | --- | --- |
| `Content-Security-Policy` | see below | Defence in depth for the finding/PR content rendered on the dashboard. |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | The session cookie authorises a GitHub App with repository read access. Two years is the minimum the preload list accepts. Omitted in development. |
| `X-Frame-Options` | `DENY` | Legacy twin of `frame-ancestors 'none'`. |
| `X-Content-Type-Options` | `nosniff` | `/api/admin/export` returns CSV built from attacker-influenced repository names; sniffing it as HTML would undo the formula-injection defence in `src/lib/utils/csv.ts`. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Keeps `/share/heist/<id>` paths from leaking off-origin. |
| `Permissions-Policy` | camera, mic, geolocation, USB, … all `()` | The app uses none of them. |
| `Cross-Origin-Opener-Policy` | `same-origin` | Isolates the browsing-context group used by the GitHub OAuth popup. |
| `Cross-Origin-Resource-Policy` | `same-site` | `same-site` rather than `same-origin`, because the OG image route must stay embeddable by crawlers. |
| `X-XSS-Protection` | `0` | Explicitly disables the removed legacy auditor, which had its own bypasses. |
| `Cache-Control` | `no-store, max-age=0` (API only) | Findings and audit rows must not sit in a shared cache. |

## Content-Security-Policy

Two policies are emitted.

**`/api/:path*`** — nothing an API route returns is ever rendered as a document,
so the policy is `default-src 'none'; frame-ancestors 'none'; base-uri 'none';
form-action 'none'`.

**Everything else** — the document policy. `frame-ancestors 'none'`,
`object-src 'none'`, `base-uri 'self'` and `form-action 'self'` are the parts
that stop real attacks against this app: clickjacking of the one-click triage
and policy-toggle controls, plugin sinks, base-tag injection redirecting every
relative script URL, and an injected form posting a session elsewhere.

### The `script-src 'unsafe-inline'` caveat

Next.js injects inline bootstrap scripts and inline flight data into every
document. Without a per-request nonce there is no way to enforce
`script-src 'self'` and still hydrate, and `next.config.ts` `headers()` is
static — it cannot mint one. So the shipped policy keeps `'unsafe-inline'` on
`script-src`, which does weaken the anti-XSS value of the header.

This is stated plainly rather than papered over. The builder already supports
the strict form: pass a `nonce` to `buildCspDirectives()` and `script-src`
becomes `'nonce-…' 'strict-dynamic' 'self'` with no `'unsafe-inline'`. Moving to
that means minting a nonce in middleware and threading it through the root
layout, which forces dynamic rendering on currently-static pages — a trade worth
making deliberately, not as a side effect of this change.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `CSP_REPORT_ONLY` | unset (enforcing) | `true` / `1` / `yes` emits `Content-Security-Policy-Report-Only` with an identical policy body, so a stricter policy can be trialled against production traffic before enforcing it. |
| `CSP_REPORT_URI` | unset | Adds `report-uri` to both policies. Blank values are ignored rather than emitting an empty directive. |

`NODE_ENV=development` additionally allows `'unsafe-eval'` and `ws:`/`wss:` for
Turbopack HMR (and the `npm run ngrok` tunnel), and drops HSTS and
`upgrade-insecure-requests` so a local HTTP dev server is not pinned to HTTPS in
the developer's browser for two years.

## Verifying

```bash
curl -sI https://<deployment>/dashboard | grep -i -E 'content-security|strict-transport|x-frame|x-content-type|referrer|permissions|cross-origin'
```

The builders are pure and covered by `src/lib/security-headers.test.ts`, which
also asserts that `REMOTE_IMAGE_HOSTS` still covers every entry in
`images.remotePatterns` — the two lists live in different files and that test is
what keeps them from drifting.
