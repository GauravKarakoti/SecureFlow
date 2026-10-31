import { expect, test } from "./fixtures";
import type { Page, Route } from "@playwright/test";

const AUDIO_URL = "**/api/findings/*/audio-debrief*";

/** Builds a valid silent 8-bit mono WAV so the browser can decode it and report a duration. */
function silentWav(seconds = 2, sampleRate = 8000): Buffer {
  const samples = seconds * sampleRate;
  const buf = Buffer.alloc(44 + samples, 128);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples, 40);
  return buf;
}

const WAV = silentWav();

async function fulfillWav(route: Route) {
  return route.fulfill({
    status: 200,
    contentType: "audio/wav",
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(WAV.length),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "X-Audio-Cache": "HIT",
    },
    body: WAV,
  });
}

async function mockAudio(page: Page, onRequest?: (url: string) => void) {
  await page.route(AUDIO_URL, (route) => {
    onRequest?.(route.request().url());
    return fulfillWav(route);
  });
}

/** Expand a finding in the list so its audio player is in the findings view. */
async function openPlayer(page: Page) {
  await page.goto("/dashboard/findings", { waitUntil: "domcontentloaded" });

  const trigger = page.getByRole("button", { name: /SECRET Detected/i }).first();
  await expect(trigger).toBeVisible({ timeout: 30_000 });

  await expect(async () => {
    await trigger.click({ timeout: 3_000 });
    await expect(page.getByTestId("finding-audio-player")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 45_000 });

  return page.getByTestId("finding-audio-player");
}

test.describe("Voice debrief player (#1447)", () => {
  test("renders the player with play control and default speed", async ({ page }) => {
    await mockAudio(page);
    const player = await openPlayer(page);

    await expect(player.getByText("AI Audio Debrief")).toBeVisible();
    await expect(player.getByRole("button", { name: "Play audio debrief" })).toBeVisible();
    await expect(player.getByRole("button", { name: /1x/ })).toBeVisible();
    await expect(player.getByRole("slider", { name: "Audio scrubber" })).toBeVisible();
  });

  test("play requests the audio stream and toggles to pause and back", async ({ page }) => {
    const requested: string[] = [];
    await mockAudio(page, (url) => requested.push(url));
    const player = await openPlayer(page);

    await player.getByRole("button", { name: "Play audio debrief" }).click();

    await expect(player.getByRole("button", { name: "Pause audio debrief" })).toBeVisible({
      timeout: 15_000,
    });
    expect(requested.length).toBeGreaterThan(0);
    expect(requested[0]).toContain("/audio-debrief");

    await player.getByRole("button", { name: "Pause audio debrief" }).click();
    await expect(player.getByRole("button", { name: "Play audio debrief" })).toBeVisible();
  });

  test("speed button cycles 1x, 1.25x, 1.5x and back to 1x", async ({ page }) => {
    await mockAudio(page);
    const player = await openPlayer(page);
    const speed = player.getByTitle("Change playback speed");

    await expect(speed).toHaveText(/^\s*1x/);
    await speed.click();
    await expect(speed).toHaveText(/1\.25x/);
    await speed.click();
    await expect(speed).toHaveText(/1\.5x/);
    await speed.click();
    await expect(speed).toHaveText(/^\s*1x/);
  });

  test("auto-debrief toggle preloads the audio stream", async ({ page }) => {
    const requested: string[] = [];
    await mockAudio(page, (url) => requested.push(url));
    const player = await openPlayer(page);

    expect(requested).toHaveLength(0);

    const toggle = player.getByRole("switch", { name: "Toggle auto-fetch debrief" });
    const requestPromise = page.waitForRequest((req) => req.url().includes("/audio-debrief"), {
      timeout: 15_000,
    });

    // Radix Switch + CSS scale can miss a pointer click; `check()` drives the
    // accessible control directly so auto-debrief actually turns on.
    await toggle.check();
    await expect(toggle).toBeChecked();

    await requestPromise;
    await expect.poll(() => requested.length, { timeout: 15_000 }).toBeGreaterThan(0);
  });

  test("shows an error message when the audio stream fails", async ({ page }) => {
    await page.route(AUDIO_URL, (route) => route.abort("failed"));
    const player = await openPlayer(page);

    await player.getByRole("button", { name: "Play audio debrief" }).click();

    await expect(
      player.getByText(/Failed to stream audio debrief|Could not start audio playback/),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(player.getByRole("button", { name: "Play audio debrief" })).toBeVisible();
  });
});
