import { describe, it, expect } from "vitest";
import { parseArgs, buildBatchPrompt, generateDiffReport } from "./test-prompts-live";
import type { RecordedLlmResponse } from "../src/lib/armor/__fixtures__";

describe("test-prompts-live script utilities (#1807)", () => {
  it("parses CLI arguments correctly", () => {
    const opts1 = parseArgs(["--update", "--sample=sql-injection", "--model=custom-groq-model"]);
    expect(opts1.update).toBe(true);
    expect(opts1.sampleId).toBe("sql-injection");
    expect(opts1.model).toBe("custom-groq-model");

    const opts2 = parseArgs(["-u", "-h"]);
    expect(opts2.update).toBe(true);
    expect(opts2.help).toBe(true);

    const opts3 = parseArgs(["--refresh"]);
    expect(opts3.update).toBe(true);
  });

  it("builds scanner batch prompt incorporating custom policies and file content", () => {
    const patch = "@@ -0,0 +1,2 @@\n+const x = 1;\n+console.log(x);";
    const prompt = buildBatchPrompt("src/test.ts", patch, [
      { description: "Check for unsanitized user inputs" },
    ]);

    expect(prompt).toContain("CUSTOM POLICIES TO ENFORCE:");
    expect(prompt).toContain("Check for unsanitized user inputs");
    expect(prompt).toContain('<file name="src/test.ts" context_warning="">');
    expect(prompt).toContain("const x = 1;");
  });

  it("generates readable diff report between recorded fixture and live response", () => {
    const recorded: RecordedLlmResponse = {
      findings: [
        {
          type: "Secret",
          severity: "CRITICAL",
          description: "AWS key found",
          fileLocation: "src/aws.ts",
          codeSnippet: "key=...",
        },
      ],
    };

    const identicalLive: RecordedLlmResponse = {
      findings: [
        {
          type: "Secret",
          severity: "CRITICAL",
          description: "AWS key found",
          fileLocation: "src/aws.ts",
          codeSnippet: "key=...",
        },
      ],
    };

    expect(generateDiffReport(recorded, identicalLive)).toEqual([]);

    const driftedLive: RecordedLlmResponse = {
      findings: [
        {
          type: "Vulnerability",
          severity: "HIGH",
          description: "AWS key found",
          fileLocation: "src/aws.ts",
          codeSnippet: "key=...",
        },
        {
          type: "Misconfig",
          severity: "LOW",
          description: "Extra finding",
          fileLocation: "src/aws.ts",
          codeSnippet: "key=...",
        },
      ],
    };

    const diffs = generateDiffReport(recorded, driftedLive);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.some((d) => d.includes("Finding count changed"))).toBe(true);
    expect(diffs.some((d) => d.includes("severity changed"))).toBe(true);
  });
});
