import { NextRequest, NextResponse } from "next/server";
import { withRateLimit, TIERS } from "@/lib/middleware/rate-limit";
import { runEmergencyIntakePipeline } from "@/lib/emergency-intake/orchestrator";
import type { EmergencyIntakeInput } from "@/lib/emergency-intake/schemas";
import { EmergencyIntakeError } from "@/lib/emergency-intake/schemas";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_AUDIO_MIMES = new Set([
  "audio/wav",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/webm",
]);
const ALLOWED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

async function readFileBuffer(file: File, maxBytes: number): Promise<Buffer> {
  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);
  if (buffer.byteLength > maxBytes) {
    throw new EmergencyIntakeError(
      `File ${file.name} exceeds ${maxBytes / 1024 / 1024}MB limit`,
      413,
    );
  }
  return buffer;
}

async function handler(request: NextRequest): Promise<NextResponse> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json(
      { error: "Bad Request", message: "Expected multipart/form-data body" },
      { status: 400 },
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Bad Request", message: "Unable to parse multipart form data" },
      { status: 400 },
    );
  }

  const text = (formData.get("text") as string | null) ?? "";
  const audioFile = formData.get("audio") as File | null;
  const imageFile = formData.get("image") as File | null;

  if (!text && !audioFile && !imageFile) {
    return NextResponse.json(
      { error: "Bad Request", message: "At least one of text, audio, or image is required" },
      { status: 400 },
    );
  }

  if (text.length > 10000) {
    return NextResponse.json(
      { error: "Bad Request", message: "Text input exceeds 10000 characters" },
      { status: 413 },
    );
  }

  const mediaBuffers: Record<string, Buffer> = {};
  let hasAudio = false;
  let hasImage = false;

  if (audioFile) {
    if (!ALLOWED_AUDIO_MIMES.has(audioFile.type)) {
      return NextResponse.json(
        {
          error: "Bad Request",
          message: `Unsupported audio type: ${audioFile.type}. Allowed: ${[...ALLOWED_AUDIO_MIMES].join(", ")}`,
        },
        { status: 415 },
      );
    }
    mediaBuffers.audio = await readFileBuffer(audioFile, MAX_AUDIO_BYTES);
    hasAudio = true;
  }

  if (imageFile) {
    if (!ALLOWED_IMAGE_MIMES.has(imageFile.type)) {
      return NextResponse.json(
        {
          error: "Bad Request",
          message: `Unsupported image type: ${imageFile.type}. Allowed: ${[...ALLOWED_IMAGE_MIMES].join(", ")}`,
        },
        { status: 415 },
      );
    }
    mediaBuffers.image = await readFileBuffer(imageFile, MAX_IMAGE_BYTES);
    hasImage = true;
  }

  const input: EmergencyIntakeInput = {
    text,
    hasAudio,
    hasImage,
    ...(audioFile
      ? { audioMimeType: audioFile.type, audioSizeBytes: mediaBuffers.audio.byteLength }
      : {}),
    ...(imageFile
      ? { imageMimeType: imageFile.type, imageSizeBytes: mediaBuffers.image.byteLength }
      : {}),
  };

  const action = await runEmergencyIntakePipeline(input, mediaBuffers);

  return NextResponse.json({
    success: true,
    action,
  });
}

export const POST = withRateLimit(handler, {
  ...TIERS.AI_STREAM,
  keyPrefix: "emergency-intake",
});
