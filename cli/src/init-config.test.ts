import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  detectRepoLanguages,
  generateSecureFlowJson,
  generateSecureFlowIgnore,
  initConfigFiles,
  validateConfigFiles,
  promptConfigQuestions,
} from "./init-config.js";
import { validateSecureFlowJson, validateSecureFlowIgnore } from "./contracts/config-schema.js";

describe("init-config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "secureflow-init-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("detectRepoLanguages", () => {
    it("detects typescript/javascript when package.json is present", () => {
      fs.writeFileSync(path.join(tempDir, "package.json"), "{}");
      const langs = detectRepoLanguages(tempDir);
      expect(langs).toContain("typescript");
      expect(langs).toContain("javascript");
    });

    it("detects terraform when .tf files or terraform dir is present", () => {
      fs.writeFileSync(path.join(tempDir, "main.tf"), "");
      const langs = detectRepoLanguages(tempDir);
      expect(langs).toContain("terraform");
    });

    it("detects python when requirements.txt is present", () => {
      fs.writeFileSync(path.join(tempDir, "requirements.txt"), "");
      const langs = detectRepoLanguages(tempDir);
      expect(langs).toContain("python");
    });
  });

  describe("file generation and schema validity", () => {
    it("generated .secureflow.json passes schema validation", () => {
      const jsonContent = generateSecureFlowJson({
        blockOn: "HIGH",
        languages: ["typescript", "terraform"],
      });
      const errors = validateSecureFlowJson(jsonContent);
      expect(errors).toHaveLength(0);
      expect(jsonContent).toContain('"blockOn": "HIGH"');
      expect(jsonContent).toContain("terraform/**");
    });

    it("generated .secureflowignore passes schema validation", () => {
      const ignoreContent = generateSecureFlowIgnore({
        ignorePaths: ["custom-build/**"],
      });
      const errors = validateSecureFlowIgnore(ignoreContent);
      expect(errors).toHaveLength(0);
      expect(ignoreContent).toContain("custom-build/**");
      expect(ignoreContent).toContain("[paths]");
      expect(ignoreContent).toContain("[placeholders]");
    });
  });

  describe("initConfigFiles non-interactive", () => {
    it("creates valid .secureflow.json and .secureflowignore files", async () => {
      const result = await initConfigFiles({
        targetDir: tempDir,
        blockOn: "CRITICAL",
        languages: ["python"],
        interactive: false,
      });

      expect(result.jsonCreated).toBe(true);
      expect(result.ignoreCreated).toBe(true);

      const jsonPath = path.join(tempDir, ".secureflow.json");
      const ignorePath = path.join(tempDir, ".secureflowignore");
      expect(fs.existsSync(jsonPath)).toBe(true);
      expect(fs.existsSync(ignorePath)).toBe(true);

      // Verify that validateConfigFiles passes with 0 errors
      const report = validateConfigFiles({ targetDir: tempDir });
      expect(report.valid).toBe(true);
      expect(report.allErrors).toHaveLength(0);
    });

    it("does not overwrite existing files without --force (non-interactive)", async () => {
      const jsonPath = path.join(tempDir, ".secureflow.json");
      const ignorePath = path.join(tempDir, ".secureflowignore");
      fs.writeFileSync(jsonPath, '{"original": true}');
      fs.writeFileSync(ignorePath, "# original ignore");

      const result = await initConfigFiles({
        targetDir: tempDir,
        interactive: false,
        force: false,
      });

      expect(result.jsonSkipped).toBe(true);
      expect(result.ignoreSkipped).toBe(true);
      expect(fs.readFileSync(jsonPath, "utf-8")).toBe('{"original": true}');
      expect(fs.readFileSync(ignorePath, "utf-8")).toBe("# original ignore");
    });

    it("overwrites existing files when --force is specified", async () => {
      const jsonPath = path.join(tempDir, ".secureflow.json");
      const ignorePath = path.join(tempDir, ".secureflowignore");
      fs.writeFileSync(jsonPath, '{"original": true}');
      fs.writeFileSync(ignorePath, "# original ignore");

      const result = await initConfigFiles({
        targetDir: tempDir,
        interactive: false,
        force: true,
      });

      expect(result.jsonCreated).toBe(true);
      expect(result.ignoreCreated).toBe(true);
      expect(fs.readFileSync(jsonPath, "utf-8")).not.toBe('{"original": true}');
      expect(fs.readFileSync(ignorePath, "utf-8")).not.toBe("# original ignore");
    });
  });

  describe("initConfigFiles interactive overwrite confirmation", () => {
    it("preserves files when user declines overwrite in interactive prompt", async () => {
      const jsonPath = path.join(tempDir, ".secureflow.json");
      const ignorePath = path.join(tempDir, ".secureflowignore");
      fs.writeFileSync(jsonPath, '{"original": true}');
      fs.writeFileSync(ignorePath, "# original ignore");

      const mockRl = {
        question: vi.fn((_q: string, cb: (ans: string) => void) => {
          cb("n"); // user declines
        }),
        close: vi.fn(),
      } as any;

      const result = await initConfigFiles({
        targetDir: tempDir,
        interactive: true,
        rl: mockRl,
        force: false,
      });

      expect(result.jsonSkipped).toBe(true);
      expect(result.ignoreSkipped).toBe(true);
      expect(fs.readFileSync(jsonPath, "utf-8")).toBe('{"original": true}');
    });

    it("overwrites files when user confirms overwrite in interactive prompt", async () => {
      const jsonPath = path.join(tempDir, ".secureflow.json");
      const ignorePath = path.join(tempDir, ".secureflowignore");
      fs.writeFileSync(jsonPath, '{"original": true}');
      fs.writeFileSync(ignorePath, "# original ignore");

      const mockRl = {
        question: vi.fn((_q: string, cb: (ans: string) => void) => {
          cb("yes"); // user confirms
        }),
        close: vi.fn(),
      } as any;

      const result = await initConfigFiles({
        targetDir: tempDir,
        interactive: true,
        rl: mockRl,
        force: false,
      });

      expect(result.jsonCreated).toBe(true);
      expect(result.ignoreCreated).toBe(true);
      expect(fs.readFileSync(jsonPath, "utf-8")).not.toBe('{"original": true}');
    });
  });

  describe("promptConfigQuestions", () => {
    it("collects user answers for severity, ignore paths, and languages", async () => {
      const answersList = ["CRITICAL", "build/**, logs/**", "python, terraform"];
      let callCount = 0;
      const mockRl = {
        question: vi.fn((_q: string, cb: (ans: string) => void) => {
          cb(answersList[callCount++] ?? "");
        }),
        close: vi.fn(),
      } as any;

      const answers = await promptConfigQuestions(
        {
          blockOn: "HIGH",
          ignorePaths: ["node_modules/**"],
          languages: ["typescript"],
        },
        mockRl,
        process.stdin,
        { write: vi.fn() } as any,
      );

      expect(answers.blockOn).toBe("CRITICAL");
      expect(answers.ignorePaths).toEqual(["build/**", "logs/**"]);
      expect(answers.languages).toEqual(["python", "terraform"]);
    });
  });

  describe("validateConfigFiles error reporting", () => {
    it("reports unknown keys, invalid severities, and line numbers", () => {
      const jsonPath = path.join(tempDir, ".secureflow.json");
      const badContent = [
        `{`,
        `  "gate": {`,
        `    "blockOn": "SUPER_CRITICAL",`,
        `    "badField": true`,
        `  },`,
        `  "unknownRoot": 123`,
        `}`,
      ].join("\n");
      fs.writeFileSync(jsonPath, badContent);

      const report = validateConfigFiles({ targetDir: tempDir });
      expect(report.valid).toBe(false);
      expect(report.allErrors.length).toBeGreaterThanOrEqual(3);

      const sevError = report.allErrors.find((e) => e.code === "INVALID_SEVERITY");
      expect(sevError?.line).toBe(3);

      const unknownGate = report.allErrors.find((e) => e.message.includes('"badField"'));
      expect(unknownGate?.line).toBe(4);

      const unknownRoot = report.allErrors.find((e) => e.message.includes('"unknownRoot"'));
      expect(unknownRoot?.line).toBe(6);
    });

    it("reports missing files when target file does not exist", () => {
      const report = validateConfigFiles({ filePath: "nonexistent.json", targetDir: tempDir });
      expect(report.valid).toBe(false);
      expect(report.allErrors[0]?.code).toBe("FILE_NOT_FOUND");
    });
  });
});
