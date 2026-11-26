import Groq from "groq-sdk";
import type { ChatCompletionContentPart } from "groq-sdk/resources/chat/completions";
import { env } from "@/lib/env";
import { queryLiveThreatIntelligence } from "../../../cli/src/threat-intel";
import type { EmergencyIntakeInput, LifeSavingAction } from "./schemas";
import { EmergencyIntakeInputSchema } from "./schemas";
import { LifeSavingActionSchema, LifeSavingActionValidationError } from "./schemas";
import { buildEmergencyIntakeSystemPrompt, buildEmergencyIntakeUserPrompt } from "./prompts";

type GroqMessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | {
      type: "input_audio";
      input_audio: { data: string; format: string };
    };

const DEFAULT_MODEL = env.AI_MODEL || "openai/gpt-oss-20b";
const MAX_AUDIO_BASE64_CHARS = 4000;
const MAX_IMAGE_BASE64_CHARS = 4000;

let _groq: Groq | null = null;

function getGroqClient(): Groq {
  if (!_groq) {
    _groq = new Groq({ apiKey: env.GROQ_API_KEY! });
  }
  return _groq;
}

function bufferToBase64(buffer: Buffer): string {
  return buffer.toString("base64");
}

function truncateBase64(base64: string, maxChars: number): string {
  if (base64.length <= maxChars) return base64;
  return base64.slice(0, maxChars);
}

/**
 * Extract threat-intelligence-relevant keywords from the raw text input so the
 * MCP Threat Intelligence server can be queried for context.
 */
function extractThreatIntelQuery(text: string): string {
  const keywords = text
    .split(/[\s,;.!?]+/)
    .map((w) => w.trim().toLowerCase())
    .filter(
      (w) =>
        w.length > 3 &&
        !["the", "and", "that", "with", "from", "this", "then", "have", "been", "were"].includes(w),
    );
  return keywords.slice(0, 8).join(" ");
}

/**
 * Verifies the emergency context against the Threat Intelligence MCP Server.
 * Returns advisory context text to be folded into the Groq prompt, or "" when
 * the MCP server is unavailable (graceful degradation).
 */
async function fetchThreatIntelContext(text: string): Promise<string> {
  if (!text.trim()) return "";
  try {
    const query = extractThreatIntelQuery(text);
    if (!query) return "";
    return await queryLiveThreatIntelligence(query);
  } catch {
    // Graceful degradation if the MCP/threat-intel module cannot be reached.
    return "";
  }
}

/**
 * Validates and sanitizes a Groq-produced LifeSavingAction output.
 */
export function validateLifeSavingAction(rawOutput: unknown): LifeSavingAction {
  let parsedRaw = rawOutput;
  if (typeof rawOutput === "string") {
    try {
      parsedRaw = JSON.parse(rawOutput);
    } catch {
      throw new LifeSavingActionValidationError(
        "Failed to parse Groq action output: invalid JSON string",
      );
    }
  }
  if (!parsedRaw || typeof parsedRaw !== "object" || Array.isArray(parsedRaw)) {
    throw new LifeSavingActionValidationError("LifeSavingAction output must be an object");
  }
  const parseResult = LifeSavingActionSchema.safeParse(parsedRaw);
  if (!parseResult.success) {
    throw new LifeSavingActionValidationError(
      `LifeSavingAction validation failed: ${parseResult.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
      parseResult.error.issues,
    );
  }
  return parseResult.data;
}

/**
 * Runs the full multimodal emergency intake pipeline:
 *   1. Validate input
 *   2. Build media parts (base64 data URIs) for Groq
 *   3. Verify context against Threat Intelligence MCP Server
 *   4. Prompt Groq to emit a strict LifeSavingAction JSON
 *   5. Validate the structured output
 *
 * @param input - validated emergency intake input
 * @param mediaBuffers - optional buffers keyed by media kind ("audio" | "image")
 * @returns the validated LifeSavingAction
 */
export async function runEmergencyIntakePipeline(
  input: EmergencyIntakeInput,
  mediaBuffers?: Record<string, Buffer>,
): Promise<LifeSavingAction> {
  const validatedInput = EmergencyIntakeInputSchema.parse(input);

  const media: Array<{ kind: "audio" | "image"; mimeType: string; base64: string }> = [];
  if ((validatedInput.hasAudio ?? false) && mediaBuffers?.audio) {
    media.push({
      kind: "audio",
      mimeType: validatedInput.audioMimeType || "audio/wav",
      base64: truncateBase64(bufferToBase64(mediaBuffers.audio), MAX_AUDIO_BASE64_CHARS),
    });
  }
  if ((validatedInput.hasImage ?? false) && mediaBuffers?.image) {
    media.push({
      kind: "image",
      mimeType: validatedInput.imageMimeType || "image/jpeg",
      base64: truncateBase64(bufferToBase64(mediaBuffers.image), MAX_IMAGE_BASE64_CHARS),
    });
  }

  // 1. Verify context against Threat Intelligence MCP Server (graceful degradation)
  const threatIntelContext = await fetchThreatIntelContext(validatedInput.text);

  // 2. Build the multimodal prompt
  const systemPrompt = buildEmergencyIntakeSystemPrompt();
  const userPrompt = buildEmergencyIntakeUserPrompt(validatedInput, media);
  const fullUserPrompt = threatIntelContext
    ? `${userPrompt}\n\n-- THREAT INTELLIGENCE CONTEXT (MCP Server) --\n${threatIntelContext}\n-- END --`
    : userPrompt;

  // 3. Build multimodal content parts for Groq
  const contentParts: GroqMessageContentPart[] = [{ type: "text", text: fullUserPrompt }];
  for (const m of media) {
    if (m.kind === "image") {
      contentParts.push({
        type: "image_url",
        image_url: { url: `data:${m.mimeType};base64,${m.base64}` },
      });
    } else {
      const format = m.mimeType.includes("mp4") ? "mp4" : m.mimeType.split("/")[1] || "wav";
      contentParts.push({
        type: "input_audio",
        input_audio: { data: m.base64, format },
      });
    }
  }

  // 4. Call Groq to parse into a strict JSON LifeSavingAction
  const groq = getGroqClient();
  const response = await groq.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.2,
    max_tokens: 1024,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: contentParts as unknown as ChatCompletionContentPart[],
      },
    ],
  });

  const rawOutput = response.choices[0]?.message?.content ?? "";

  // 5. Validate the structured output
  return validateLifeSavingAction(rawOutput);
}
