import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalAiInstance, localModelRef } from "./local-model";

// Deliberately unmocked: `local-model.test.ts` mocks the plugin module, so it
// cannot notice when the import resolves to `undefined` or the plugin ignores
// `baseURL`. A stub OpenAI-compatible server stands in for Ollama.
describe("createLocalAiInstance (real plugin)", () => {
  let server: Server;
  let baseUrl: string;
  const requests: { url?: string; body: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        requests.push({ url: req.url, body: JSON.parse(raw || "{}") });
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            id: "chatcmpl-local",
            object: "chat.completion",
            created: 0,
            model: "llama3",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: "hello from local" },
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("sends generate calls for any model tag to LOCAL_AI_URL", async () => {
    const config = { baseUrl, model: "llama3" };
    const ai = createLocalAiInstance(config);

    const response = await ai.generate({ model: localModelRef(config), prompt: "hi" });

    expect(response.text).toBe("hello from local");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/v1/chat/completions");
    expect(requests[0].body.model).toBe("llama3");
  });
});
