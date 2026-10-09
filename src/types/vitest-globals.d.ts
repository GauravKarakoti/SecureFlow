/**
 * Make Vitest's injected globals visible to the type checker.
 *
 * `vitest.config.ts` sets `globals: true`, which installs `describe`, `it`,
 * `test`, `expect`, `vi`, `beforeEach` and friends onto `globalThis` at run
 * time. Nothing told the compiler about that, so a test file that reached for
 * one of them instead of importing it type-checked as an undeclared identifier
 * while passing perfectly well under `vitest run`.
 *
 * That gap took `npm run typecheck` — and with it the "Lint, Typecheck, &
 * Build" gate, and the `e2e` job that depends on it — red on `main` for four
 * `test(` calls in `src/ai/flows/heist-prompt-guard.test.ts` (#701).
 *
 * This is a triple-slash reference rather than a `"types"` array in
 * `tsconfig.json` on purpose. Adding `"types"` there would switch the compiler
 * from "include every package under `@types`" to "include exactly this list",
 * which silently drops `@types/node`, `@types/react` and the ~40 others this
 * repository relies on. A single ambient reference adds what is missing and
 * changes nothing else.
 *
 * Importing the helpers explicitly is still the better style — a test file
 * should say what it uses — and this file does not discourage that. It only
 * makes sure that the compiler and `globals: true` stop disagreeing about
 * whether the globals exist, so the next `test(` written without an import is a
 * style nit rather than a broken pipeline on somebody else's pull request.
 */

/// <reference types="vitest/globals" />

export {};
