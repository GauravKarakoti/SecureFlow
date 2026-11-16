# Auth Mock Fixtures Design

## Goal

Provide one canonical safe session fixture for Auth.js mocks, standardize synthetic credential and token values in `__mocks__/`, and verify auth and admin route tests without introducing route-specific session overrides.

## Design

`__mocks__/next-auth/index.ts` will define and export a frozen `SAFE_MOCK_SESSION`. `__mocks__/auth.ts` will import and re-export that object, use it for the default auth result, and retain `SAFE_MOCK_AUTH_SESSION` as an alias for compatibility. Credential and token placeholders in `__mocks__/` will use exact low-entropy placeholder forms already recognized by the CLI's entropy checks. Provider-specific prefixes will not be preserved when they are unnecessary to mock behavior.

No route behavior or CLI detection rules will change. Existing route tests will remain responsible for explicit authorization cases; validation will run the requested auth and admin route tests, together with focused mock credential and CLI scanner/entropy tests.

## Scope and validation

Changes are limited to the canonical fixture, directly related mock placeholder strings, and focused regression assertions if needed. No dependencies, production authentication behavior, or scanner heuristics are in scope. Validation will run the auth route test, all `src/app/api/admin/**` route tests, and focused fixture/scanner/entropy tests.
