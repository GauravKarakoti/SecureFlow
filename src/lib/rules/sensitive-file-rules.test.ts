import { describe, it, expect } from "vitest";
import {
  checkFileForSensitiveName,
  runSensitiveFileRules,
  isSensitiveFilename,
  isExampleFile,
  SENSITIVE_FILE_RULE_IDS,
} from "./sensitive-file-rules";
import type { FileChange } from "@/lib/armor/scanner";

function makeAddedFile(filename: string, content = ""): FileChange {
  return {
    filename,
    patch: `new file mode 100644\n--- /dev/null\n+++ b/${filename}\n@@ -0,0 +1 @@\n+${content || "data"}`,
  };
}

function makeModifiedFile(filename: string): FileChange {
  return {
    filename,
    patch: `@@ -1,1 +1,2 @@\n context\n+extra line`,
  };
}

describe("Sensitive Filename Detection Rules (#2092)", () => {
  describe("isExampleFile – example/sample exclusion", () => {
    it("identifies .env.example as an example file", () => {
      expect(isExampleFile(".env.example")).toBe(true);
    });

    it("identifies config.env.sample as an example file", () => {
      expect(isExampleFile("config.env.sample")).toBe(true);
    });

    it("identifies id_rsa.template as an example file", () => {
      expect(isExampleFile("id_rsa.template")).toBe(true);
    });

    it("does NOT identify .env as an example file", () => {
      expect(isExampleFile(".env")).toBe(false);
    });

    it("does NOT identify secrets.json as an example file", () => {
      expect(isExampleFile("secrets.json")).toBe(false);
    });
  });

  describe("isSensitiveFilename – detection patterns", () => {
    it("identifies .env as sensitive", () => {
      expect(isSensitiveFilename(".env").sensitive).toBe(true);
    });

    it("identifies id_rsa as sensitive", () => {
      expect(isSensitiveFilename("id_rsa").sensitive).toBe(true);
    });

    it("identifies file.pem as sensitive (extension)", () => {
      expect(isSensitiveFilename("server.pem").sensitive).toBe(true);
    });

    it("identifies a database dump as sensitive", () => {
      expect(isSensitiveFilename("backup.sql").sensitive).toBe(true);
      expect(isSensitiveFilename("prod.dump").sensitive).toBe(true);
      expect(isSensitiveFilename("data.sqlite3").sensitive).toBe(true);
    });

    it("identifies service-account.json as sensitive", () => {
      expect(isSensitiveFilename("service-account.json").sensitive).toBe(true);
    });

    it("does NOT identify README.md as sensitive", () => {
      expect(isSensitiveFilename("README.md").sensitive).toBe(false);
    });

    it("does NOT identify src/index.ts as sensitive", () => {
      expect(isSensitiveFilename("src/index.ts").sensitive).toBe(false);
    });

    it("does NOT identify package.json as sensitive", () => {
      expect(isSensitiveFilename("package.json").sensitive).toBe(false);
    });
  });

  describe("checkFileForSensitiveName – file-level detection", () => {
    it("flags .env file added to repo with HIGH severity", () => {
      const findings = checkFileForSensitiveName(makeAddedFile(".env", "DB_PASSWORD=secret"));
      expect(findings).toHaveLength(1);
      expect(findings[0].matchedSignatures?.[0]).toBe(SENSITIVE_FILE_RULE_IDS.SENSITIVE_FILE_NAME);
      expect(findings[0].severity).toBe("HIGH");
      expect(findings[0].fileLocation).toBe(".env");
    });

    it("flags id_rsa private key", () => {
      const findings = checkFileForSensitiveName(
        makeAddedFile("id_rsa", "-----BEGIN RSA PRIVATE KEY-----"),
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].description).toContain("id_rsa");
    });

    it("flags a .p12 certificate", () => {
      const findings = checkFileForSensitiveName(makeAddedFile("keystore.p12"));
      expect(findings).toHaveLength(1);
    });

    it("flags a SQL dump file", () => {
      const findings = checkFileForSensitiveName(makeAddedFile("production.sql"));
      expect(findings).toHaveLength(1);
    });

    it("does NOT flag .env.example", () => {
      const findings = checkFileForSensitiveName(makeAddedFile(".env.example"));
      expect(findings).toHaveLength(0);
    });

    it("does NOT flag normal source files", () => {
      const findings = checkFileForSensitiveName(
        makeAddedFile("src/main.ts", "console.log('hello')"),
      );
      expect(findings).toHaveLength(0);
    });

    it("respects allowedFilenames option", () => {
      const findings = checkFileForSensitiveName(makeAddedFile(".env", "DB=test"), {
        allowedFilenames: [".env"],
      });
      expect(findings).toHaveLength(0);
    });

    it("respects allowedPatterns option with glob prefix", () => {
      const findings = checkFileForSensitiveName(makeAddedFile("test/fixtures/.env", "TEST=1"), {
        allowedPatterns: ["test/fixtures/**"],
      });
      expect(findings).toHaveLength(0);
    });

    it("flags a modified (not new) .env file", () => {
      const findings = checkFileForSensitiveName(makeModifiedFile(".env"));
      expect(findings).toHaveLength(1);
    });

    it("respects disabledRules: suppresses the rule", () => {
      const findings = checkFileForSensitiveName(makeAddedFile("id_rsa"), {
        disabledRules: ["SEC_SENSITIVE_FILE_NAME"],
      });
      expect(findings).toHaveLength(0);
    });
  });

  describe("runSensitiveFileRules – multi-file runner", () => {
    it("collects findings from multiple sensitive files", () => {
      const files = [
        makeAddedFile(".env", "SECRET=abc"),
        makeAddedFile("id_rsa", "-----BEGIN RSA PRIVATE KEY-----"),
        makeAddedFile("src/index.ts", "console.log('ok')"),
      ];
      const findings = runSensitiveFileRules(files, { repositoryId: "repo-1" });
      expect(findings).toHaveLength(2);
      expect(findings.map((f) => f.fileLocation).sort()).toEqual([".env", "id_rsa"].sort());
    });

    it("respects enabled: false to suppress all findings", () => {
      const files = [makeAddedFile(".env", "SECRET=abc"), makeAddedFile("id_rsa")];
      const findings = runSensitiveFileRules(files, { enabled: false });
      expect(findings).toHaveLength(0);
    });
  });

  describe("Each pattern has test coverage", () => {
    const cases: Array<{ name: string; file: string; expectedSensitive: boolean }> = [
      { name: ".env.local", file: ".env.local", expectedSensitive: true },
      { name: ".env.production", file: ".env.production", expectedSensitive: true },
      { name: "credentials (AWS)", file: "credentials", expectedSensitive: true },
      { name: "keystore.jks", file: "keystore.jks", expectedSensitive: true },
      { name: "firebase-adminsdk.json", file: "firebase-adminsdk.json", expectedSensitive: true },
      { name: ".htpasswd", file: ".htpasswd", expectedSensitive: true },
      { name: ".netrc", file: ".netrc", expectedSensitive: true },
      { name: "data.db", file: "data.db", expectedSensitive: true },
      { name: "app.ts (safe)", file: "src/app.ts", expectedSensitive: false },
      { name: ".env.example (safe)", file: ".env.example", expectedSensitive: false },
      { name: "README.md (safe)", file: "README.md", expectedSensitive: false },
    ];

    for (const { name, file, expectedSensitive } of cases) {
      it(`${name}: sensitive=${expectedSensitive}`, () => {
        const result = isSensitiveFilename(file);
        expect(result.sensitive, `expected ${file} sensitive=${expectedSensitive}`).toBe(
          expectedSensitive,
        );
      });
    }
  });
});
