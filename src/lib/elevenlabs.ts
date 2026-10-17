import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import WebSocket from "ws";
import { env } from "@/lib/env";

export type VoicePersona = "default" | "alert" | "heist";

const DEFAULT_MODEL_ID = "eleven_turbo_v2_5";

let client: ElevenLabsClient | null = null;

export function getElevenLabsClient(): ElevenLabsClient {
  if (client) return client;
  const apiKey = env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set");
  client = new ElevenLabsClient({ apiKey });
  return client;
}

export function resolveVoiceId(persona: VoicePersona = "default"): string {
  const map: Record<VoicePersona, string | undefined> = {
    default: env.ELEVENLABS_VOICE_ID_DEFAULT,
    alert: env.ELEVENLABS_VOICE_ID_ALERT,
    heist: env.ELEVENLABS_VOICE_ID_HEIST,
  };
  const id = map[persona];
  if (!id) throw new Error(`Voice ID missing for persona: ${persona}`);
  return id;
}

async function withBackoff<T>(fn: () => Promise<T>, retries = 4): Promise<T> {
  let delay = 500;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.statusCode ?? err?.status;
      if (status !== 429 || attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, delay + Math.random() * 200));
      delay *= 2;
    }
  }
}

export async function streamSpeech(
  text: string,
  opts: { persona?: VoicePersona; voiceId?: string; modelId?: string } = {},
): Promise<ReadableStream<Uint8Array>> {
  const voiceId = opts.voiceId ?? resolveVoiceId(opts.persona);
  const modelId = opts.modelId ?? env.ELEVENLABS_MODEL_ID ?? DEFAULT_MODEL_ID;
  return withBackoff(() =>
    getElevenLabsClient().textToSpeech.stream(voiceId, { text, modelId }),
  ) as Promise<ReadableStream<Uint8Array>>;
}

export interface ConversationHandlers {
  onAudio?: (base64Audio: string) => void;
  onTranscript?: (role: "user" | "agent", text: string) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
}

export function openConversation(agentId: string, handlers: ConversationHandlers = {}) {
  const apiKey = env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set");

  const ws = new WebSocket(
    `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(agentId)}`,
    { headers: { "xi-api-key": apiKey } },
  );

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      switch (msg.type) {
        case "ping":
          ws.send(JSON.stringify({ type: "pong", event_id: msg.ping_event?.event_id }));
          break;
        case "audio":
          handlers.onAudio?.(msg.audio_event?.audio_base_64);
          break;
        case "user_transcript":
          handlers.onTranscript?.("user", msg.user_transcription_event?.user_transcript);
          break;
        case "agent_response":
          handlers.onTranscript?.("agent", msg.agent_response_event?.agent_response);
          break;
      }
    } catch (err) {
      handlers.onError?.(err as Error);
    }
  });

  ws.on("error", (err) => handlers.onError?.(err));
  ws.on("close", () => handlers.onClose?.());

  return {
    sendAudioChunk: (base64Audio: string) =>
      ws.readyState === WebSocket.OPEN &&
      ws.send(JSON.stringify({ user_audio_chunk: base64Audio })),
    close: () => ws.close(),
  };
}
