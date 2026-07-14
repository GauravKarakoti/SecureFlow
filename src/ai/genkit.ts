import 'dotenv/config';
import { genkit } from 'genkit';
import {
  openAICompatible,
  defineCompatOpenAIModel,
  compatOaiModelRef,
} from '@genkit-ai/compat-oai';
import type { ModelInfo } from 'genkit/model';

// Groq deprecated llama-3.1-8b-instant on 2026-06-17 in favor of openai/gpt-oss-20b
// (see https://console.groq.com/docs/deprecations). Override via GROQ_MODEL if needed.
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

const groqModelInfo: ModelInfo = {
  label: `Groq - ${GROQ_MODEL}`,
  supports: {
    multiturn: true,
    tools: false,
    media: false,
    systemRole: true,
    output: ['json', 'text'],
  },
};

// Falls back to a dummy key only in test runs and during the production build
// (Next sets NEXT_PHASE=phase-production-build) so local/CI lint/typecheck/build
// steps - which import this module but never actually call the model - don't need
// a real Groq key configured. A running server still requires a real key below.
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
 * Genkit instance for the app, configured with Groq through the official
 * @genkit-ai/compat-oai plugin (Groq exposes an OpenAI-schema endpoint at
 * https://api.groq.com/openai/v1). This keeps Groq as the default/primary provider
 * while making provider swaps a config change rather than a code change: adding
 * another compat-oai instance (or an official plugin like @genkit-ai/anthropic /
 * @genkit-ai/compat-oai/openai) and pointing `defaultModel` at it is all that's
 * needed for flows to pick up a different backend.
 */
export const ai = genkit({
  plugins: [
    openAICompatible({
      name: 'groq',
      apiKey: groqApiKey,
      baseURL: 'https://api.groq.com/openai/v1',
      // Registers GROQ_MODEL as a Genkit model action at startup so it can be
      // referenced below (and from anywhere else in the app) as `groq/<model>`.
      initializer: async (client) => [
        defineCompatOpenAIModel({
          name: `groq/${GROQ_MODEL}`,
          client,
          modelRef: compatOaiModelRef({ name: GROQ_MODEL, info: groqModelInfo }),
        }),
      ],
    }),
  ],
});

/** Model reference flows should use unless they need to override it explicitly. */
export const defaultModel = `groq/${GROQ_MODEL}`;
