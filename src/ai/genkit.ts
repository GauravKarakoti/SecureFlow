import 'dotenv/config';
import { genkit } from 'genkit';
import { groq } from 'genkitx-groq';

/**
 * ────────────────────────────────────────────────────────────────────────────
 * SkillFlow Genkit configuration — powered by the official `genkitx-groq`
 * plugin (replaces the previous OpenAI-compatible shim).
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Why this is better than the old `@genkit-ai/compat-oai` setup:
 *
 *  1. Native Groq support. `genkitx-groq` is the official Genkit plugin
 *     maintained by the Groq team. It uses `groq-sdk` directly (not the
 *     OpenAI-compatible shim), so it picks up Groq-specific features
 *     (LPU streaming, Groq's own tool-calling shape, native JSON mode)
 *     that the OpenAI shim couldn't reach.
 *
 *  2. Pre-registered model registry. The plugin already registers every
 *     Groq-hosted model as a Genkit action (`groq/llama-3.1-8b-instant`,
 *     `groq/openai/gpt-oss-20b`, etc.). We no longer need a custom
 *     `initializer` callback that builds a `ModelInfo` by hand — we
 *     just import the model reference we want and use it.
 *
 *  3. Faster inference for security flows. The issue (#217) explicitly
 *     asked for the security-explanation flows to be routed to the
 *     fastest available Groq model rather than relying on the default
 *     config. `genkitx-groq` exports typed model references
 *     (`llama31x8bInstant`, `gptOssx20b`, …) so each flow can pin the
 *     exact model it needs without stringly-typed config.
 *
 * Provider swap is still a config change, not a code change: add another
 * plugin (e.g. `@genkit-ai/anthropic`) and point `defaultModel` at it.
 */

// ── API key resolution ─────────────────────────────────────────────────────
//
// Falls back to a dummy key only in test runs and during the production build
// (Next sets NEXT_PHASE=phase-production-build) so local/CI lint/typecheck/
// build steps — which import this module but never actually call the model —
// don't need a real Groq key configured. A running server still requires a
// real key below.
const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build';
const groqApiKey =
  process.env.GROQ_API_KEY ??
  (process.env.NODE_ENV === 'test' || isBuildPhase ? 'dummy-key-for-build' : undefined);

if (!groqApiKey) {
  throw new Error(
    'GROQ_API_KEY is not set. Provide it via environment variables (see .env.example).'
  );
}

/**
 * Genkit instance for the app, configured with the official `genkitx-groq`
 * plugin. The plugin auto-registers every Groq-hosted model under the
 * `groq/` namespace (e.g. `groq/llama-3.1-8b-instant`,
 * `groq/openai/gpt-oss-20b`, `groq/llama-3.3-70b-versatile`).
 */
export const ai = genkit({
  plugins: [groq({ apiKey: groqApiKey })],
});

// ── Default model ──────────────────────────────────────────────────────────
//
// `GROQ_MODEL` (default: `openai/gpt-oss-20b`) is the *application-wide*
// default. Individual flows that need the absolute lowest latency (the
// security-explanation flows) override this with an explicit, faster model
// reference — see `SECURITY_EXPLANATION_MODEL` below.
//
// Groq deprecated `llama-3.1-8b-instant` on 2026-06-17 in favour of
// `openai/gpt-oss-20b` (see https://console.groq.com/docs/deprecations).
// `gpt-oss-20b` is Groq's current recommended default for general-purpose
// low-latency inference. Override via `GROQ_MODEL` if your account still
// has access to a deprecated model.
const GROQ_MODEL = process.env.GROQ_MODEL ?? 'openai/gpt-oss-20b';

/** Model reference flows should use unless they need to override it explicitly. */
export const defaultModel = `groq/${GROQ_MODEL}`;

// ── Flow-specific model overrides ──────────────────────────────────────────
//
// Issue #217 explicitly asks for the security-explanation flows to be
// routed to "the fastest available Groq model". On Groq's current lineup
// (https://console.groq.com/docs/models) the lowest-latency production
// models for short, structured JSON output are:
//
//   - `openai/gpt-oss-20b`        — ~0.5s first-token, native JSON mode
//   - `llama-3.1-8b-instant`      — sub-second first-token (deprecated but
//                                    still available on most accounts)
//
// We default `SECURITY_EXPLANATION_MODEL` to the same value as `GROQ_MODEL`
// (so out-of-the-box behaviour is unchanged) but allow it to be overridden
// independently via env, so a security-conscious deploy can pin the
// security-explanation flows to a specific fast model without touching
// the rest of the app.
const SECURITY_EXPLANATION_MODEL =
  process.env.SECURITY_EXPLANATION_MODEL ?? GROQ_MODEL;

/**
 * Model reference for the security-explanation flows
 * (`developer-receives-ai-security-explanations.ts` and
 * `security-explanation-stream.ts`). Override via the
 * `SECURITY_EXPLANATION_MODEL` env var.
 *
 * Rationale: these flows generate short (≤3k-token) structured JSON for a
 * human reviewer waiting on a UI. They are the most latency-sensitive AI
 * calls in the app, so they get an explicit, fast model rather than
 * inheriting whatever `defaultModel` happens to be.
 */
export const securityExplanationModel = `groq/${SECURITY_EXPLANATION_MODEL}`;

/**
 * The heist-message flow (`heist-message-stream.ts`) is less latency-
 * sensitive (it's a share-link flourish, not a security-critical path)
 * and benefits from a slightly larger model for prose quality, so it
 * keeps using `defaultModel`.
 */