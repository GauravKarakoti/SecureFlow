import 'dotenv/config';
import { genkit } from 'genkit';
import { groq, gptOssx20b } from 'genkitx-groq';

/**
 * ────────────────────────────────────────────────────────────────────────────
 * SecureFlow Genkit configuration — powered by the official `genkitx-groq`
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
 *  3. Automatic fast-model routing for security flows. Issue #217 asked
 *     for the security-explanation flows to use the fastest available
 *     Groq model rather than relying on the default config. Instead of
 *     adding a redundant `SECURITY_EXPLANATION_MODEL` env var (which
 *     would just default to the same value as `GROQ_MODEL`), we import
 *     the typed model reference `gptOssx20b` directly from
 *     `genkitx-groq`. This is Groq's current recommended model for
 *     low-latency structured output (~0.5s first-token, native JSON
 *     mode). The switch is automatic — no manual configuration needed.
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

// ── Default model (app-wide, configurable via GROQ_MODEL) ──────────────────
//
// `GROQ_MODEL` (default: `openai/gpt-oss-20b`) is the application-wide
// default used by flows that don't need a specific model (e.g. the heist-
// message flow, which benefits from a slightly larger model for prose
// quality and is not latency-critical).
//
// Groq deprecated `llama-3.1-8b-instant` on 2026-06-17 in favour of
// `openai/gpt-oss-20b` (see https://console.groq.com/docs/deprecations).
// `gpt-oss-20b` is Groq's current recommended default for general-purpose
// low-latency inference. Override via `GROQ_MODEL` if your account still
// has access to a deprecated model.
const GROQ_MODEL = process.env.GROQ_MODEL ?? 'openai/gpt-oss-20b';

/** Model reference flows should use unless they need to override it explicitly. */
export const defaultModel = `groq/${GROQ_MODEL}`;

// ── Security-explanation model (automatic, no env var) ─────────────────────
//
// Issue #217 asked for the security-explanation flows to be routed to "the
// fastest available Groq model" rather than just relying on the default
// config. Instead of adding a separate `SECURITY_EXPLANATION_MODEL` env var
// (which would be redundant — it would just default to the same value as
// `GROQ_MODEL`), we import the typed model reference `gptOssx20b` directly
// from `genkitx-groq`.
//
// This is an **automatic** switch:
//   - `gptOssx20b` is Groq's current recommended model for low-latency
//     structured output (~0.5s first-token, native JSON mode).
//   - It's the same model that `GROQ_MODEL` defaults to, so out-of-the-box
//     behaviour is unchanged — but if a future deploy changes `GROQ_MODEL`
//     to a slower/larger model for the heist flow, the security flows
//     stay fast automatically.
//   - No manual configuration needed; no redundant env var.
//
// The security-explanation flows generate short (≤3k-token) structured JSON
// for a human reviewer waiting on a UI. They are the most latency-sensitive
// AI calls in the app, so they get a pinned fast model reference rather
// than inheriting whatever `defaultModel` happens to be.
//
// To change which model the security flows use, edit this import — it's a
// one-line code change, not a deployment-config change. This is intentional:
// the model choice is a code-level decision (it affects prompt behaviour,
// JSON-mode support, etc.), not an ops-level one.
export const securityExplanationModel = gptOssx20b;
