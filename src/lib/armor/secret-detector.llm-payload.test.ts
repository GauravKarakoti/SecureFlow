import { beforeEach, describe, expect, it } from "vitest";
import { mockCreate } from "../../../__mocks__/groq-sdk";
import { ArmorIQScanner } from "./scanner";

// Synthetic fake secrets, built at runtime so scanners do not flag this file (#1517).
const FAKE_AWS = "AKIA" + "Q7XM2PLKD93HTRWN";
const FAKE_GITHUB = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const FAKE_PEM_HEADER = "-----BEGIN RSA " + "PRIVATE KEY-----";

const files = [
  {
    filename: "src/config.ts",
    patch: [
      "@@ -1,1 +1,4 @@",
      " import fs from 'fs';",
      `+const aws = '${FAKE_AWS}';`,
      `+const gh = '${FAKE_GITHUB}';`,
      `+const pem = '${FAKE_PEM_HEADER}';`,
    ].join("\n"),
  },
];

describe("LLM payload never contains raw secrets (#1517)", () => {
  beforeEach(() => {
    mockCreate.mockClear();
  });

  it("happy path: three masked findings and no raw value in the Groq request", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
    });

    const findings = await new ArmorIQScanner().scanPullRequest(files);

    expect(findings).toHaveLength(3);
    expect(mockCreate).toHaveBeenCalled();

    const payload = JSON.stringify(mockCreate.mock.calls);
    expect(payload).not.toContain(FAKE_AWS);
    expect(payload).not.toContain(FAKE_GITHUB);
    expect(payload).not.toContain(FAKE_PEM_HEADER);

    const stored = JSON.stringify(findings);
    expect(stored).not.toContain(FAKE_AWS);
    expect(stored).not.toContain(FAKE_GITHUB);
  });

  it("failure case: when Groq throws, the deterministic findings are still returned", async () => {
    mockCreate.mockRejectedValue(new Error("Groq API 503 Service Unavailable"));

    const findings = await new ArmorIQScanner().scanPullRequest(files);

    expect(findings.length).toBeGreaterThanOrEqual(3);
    expect(findings.every((f) => f.severity === "CRITICAL")).toBe(true);
  });
});
