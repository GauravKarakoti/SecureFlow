/**
 * Single gate for the mock-authentication test seam.
 *
 * The seam lets the e2e suite drive the app as an admin or a plain user by
 * setting a `mock-session` cookie, without a real GitHub OAuth round trip. It is
 * honoured in two places — the route middleware (`src/proxy.ts`) and the server
 * `auth()` helper (`src/auth.ts`) — and in both it grants a full session, up to
 * and including `ADMIN`, from an unsigned, attacker-settable cookie.
 *
 * The seam used to be gated on `NEXT_PUBLIC_MOCK_AUTH === "true"` alone. That
 * single flag is not a safe switch for a backdoor of this power:
 *
 *   - `NEXT_PUBLIC_`-prefixed variables are, by Next.js convention, meant to be
 *     public and are inlined into the client bundle. They are the variables
 *     most likely to be copy-pasted between `.env` files, so a stray `true`
 *     landing in a production or preview deployment is an easy mistake to make.
 *   - The seam is explicitly designed to run under a *production* build: the
 *     Playwright config launches `next build && next start` with
 *     `NEXT_PUBLIC_MOCK_AUTH: "true"`. So `NODE_ENV === "production"` cannot be
 *     used to fence it off, and nothing about a production build otherwise
 *     disables it.
 *
 * Requiring a second, **server-only** flag (`ALLOW_MOCK_AUTH`, deliberately
 * *not* `NEXT_PUBLIC_`) means the seam cannot be switched on by leaking the one
 * public variable. Both must be present, and the server-only one never reaches
 * the browser bundle, so an operator has to opt in on the server on purpose.
 *
 * The test harness (`playwright.config.ts`, CI, and the unit tests) sets both.
 */
export function isMockAuthEnabled(): boolean {
  return process.env.NEXT_PUBLIC_MOCK_AUTH === "true" && process.env.ALLOW_MOCK_AUTH === "true";
}
