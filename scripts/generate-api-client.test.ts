import { describe, it, expect } from "vitest";
import {
  generateTypeScriptFromOpenApi,
  generateApiClient,
} from "./generate-api-client";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("scripts/generate-api-client.ts (#2105)", () => {
  const sampleOpenApiYaml = `
openapi: 3.1.0
info:
  title: Test API
  version: 1.0.0
paths:
  /api/health:
    get:
      operationId: getHealth
      responses:
        "200":
          content:
            application/json:
              schema:
                type: object
                required:
                  - status
                properties:
                  status:
                    type: string
  /api/users/{id}:
    get:
      operationId: getUserById
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
        - name: details
          in: query
          required: false
          schema:
            type: boolean
      responses:
        "200":
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/User"
components:
  schemas:
    User:
      type: object
      required:
        - id
        - email
      properties:
        id:
          type: string
        email:
          type: string
        role:
          type: string
          enum:
            - admin
            - user
`;

  it("generates TypeScript interfaces for paths, components, and operations", () => {
    const code = generateTypeScriptFromOpenApi(sampleOpenApiYaml);

    expect(code).toContain('"/api/health": {');
    expect(code).toContain('"/api/users/{id}": {');
    expect(code).toContain('"getUserById": paths["/api/users/{id}"]["get"];');
    expect(code).toContain('"getHealth": paths["/api/health"]["get"];');
    expect(code).toContain('"User": {');
    expect(code).toContain('"admin" | "user"');
    expect(code).toContain('email: string;');
  });

  it("detects when generated file matches spec and when it drifts", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-client-test-"));
    const specFile = path.join(tempDir, "openapi.yaml");
    const outFile = path.join(tempDir, "schema.ts");

    fs.writeFileSync(specFile, sampleOpenApiYaml, "utf8");

    // 1. Initial generation
    const firstRun = generateApiClient({
      specPath: specFile,
      outputPath: outFile,
    });
    expect(fs.existsSync(outFile)).toBe(true);

    // 2. Check drift - should be up to date
    const checkRun = generateApiClient({
      specPath: specFile,
      outputPath: outFile,
      checkOnly: true,
    });
    expect(checkRun.isUpToDate).toBe(true);

    // 3. Modify spec to introduce drift
    const driftedYaml = `
openapi: 3.1.0
info:
  title: Test API
  version: 2.0.0
paths:
  /api/health:
    get:
      operationId: getHealth
      responses:
        "200":
          content:
            application/json:
              schema:
                type: string
`;
    fs.writeFileSync(specFile, driftedYaml, "utf8");

    const driftedCheck = generateApiClient({
      specPath: specFile,
      outputPath: outFile,
      checkOnly: true,
    });
    expect(driftedCheck.isUpToDate).toBe(false);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
