import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { GET } from "./route";
import { validateSecureFlowJson } from "secureflow-cli/contracts";
import { generateSecureFlowJson } from "../../../cli/src/init-config.js";

describe("SecureFlow Configuration Schema (/schema.json)", () => {
  const schemaPath = path.join(process.cwd(), "public", "schema.json");
  const repoConfigPath = path.join(process.cwd(), ".secureflow.json");

  it("public/schema.json exists and is valid JSON", () => {
    expect(fs.existsSync(schemaPath)).toBe(true);
    const content = fs.readFileSync(schemaPath, "utf8");
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it("public/schema.json contains valid JSON Schema Draft-07 metadata and definitions", () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema.$id).toBe("https://secure-flow-six.vercel.app/schema.json");
    expect(schema.title).toBe("SecureFlow Configuration Schema");
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);

    // Properties
    expect(schema.properties).toHaveProperty("$schema");
    expect(schema.properties).toHaveProperty("$comment");
    expect(schema.properties).toHaveProperty("gate");
    expect(schema.properties).toHaveProperty("policyScopes");

    // Gate properties
    const gate = schema.properties.gate;
    expect(gate.type).toBe("object");
    expect(gate.properties).toHaveProperty("blockOn");
    expect(gate.properties).toHaveProperty("reviewOn");
    expect(gate.properties).toHaveProperty("overrides");
    expect(gate.properties).toHaveProperty("paths");
    expect(gate.properties).toHaveProperty("policyScopes");

    // Definitions
    expect(schema.definitions).toHaveProperty("GateLevel");
    expect(schema.definitions.GateLevel.enum).toEqual([
      "CRITICAL",
      "HIGH",
      "MEDIUM",
      "LOW",
      "NONE",
    ]);
    expect(schema.definitions).toHaveProperty("PolicyScopeRule");
  });

  it("the root .secureflow.json references https://secure-flow-six.vercel.app/schema.json and passes validation", () => {
    expect(fs.existsSync(repoConfigPath)).toBe(true);
    const configRaw = fs.readFileSync(repoConfigPath, "utf8");
    const config = JSON.parse(configRaw);

    expect(config.$schema).toBe("https://secure-flow-six.vercel.app/schema.json");
    expect(config).toHaveProperty("gate");
    expect(config).toHaveProperty("policyScopes");

    // Validates with contracts validator
    const errors = validateSecureFlowJson(configRaw);
    expect(errors).toHaveLength(0);
  });

  it("generateSecureFlowJson outputs match the schema and pass validation", () => {
    const generated = generateSecureFlowJson({
      blockOn: "HIGH",
      languages: ["typescript", "terraform", "python"],
    });
    const parsed = JSON.parse(generated);
    expect(parsed.$schema).toBe("https://secure-flow-six.vercel.app/schema.json");
    expect(parsed.gate.blockOn).toBe("HIGH");

    const errors = validateSecureFlowJson(generated);
    expect(errors).toHaveLength(0);
  });

  describe("GET /schema.json route handler", () => {
    it("returns HTTP 200 with application/schema+json and the schema content", async () => {
      const response = await GET();
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("application/schema+json");
      expect(response.headers.get("Cache-Control")).toContain("public");

      const body = await response.json();
      expect(body.$id).toBe("https://secure-flow-six.vercel.app/schema.json");
      expect(body.title).toBe("SecureFlow Configuration Schema");
      expect(body.definitions.GateLevel.enum).toContain("CRITICAL");
    });

    it("returns HTTP 500 if reading schema file fails", async () => {
      vi.spyOn(fsPromises, "readFile").mockRejectedValueOnce(new Error("Disk read error"));

      const response = await GET();
      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBe("Configuration schema is unavailable");
      vi.restoreAllMocks();
    });
  });
});
