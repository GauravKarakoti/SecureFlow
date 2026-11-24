import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import yaml from "yaml";

describe("Helm values.schema.json validation (#1984)", () => {
  const rootDir = process.cwd();
  const chartDir = path.join(rootDir, "helm", "secureflow");
  const schemaPath = path.join(chartDir, "values.schema.json");
  const valuesPath = path.join(chartDir, "values.yaml");
  const invalidValuesPath = path.join(chartDir, "tests", "invalid-values.yaml");
  const chartReadmePath = path.join(chartDir, "README.md");
  const testScriptPath = path.join(rootDir, "scripts", "test-helm-chart.sh");
  const workflowPath = path.join(rootDir, ".github", "workflows", "helm-chart.yml");

  it("provides a valid JSON Schema draft-07 in helm/secureflow/values.schema.json", () => {
    expect(fs.existsSync(schemaPath)).toBe(true);
    const content = fs.readFileSync(schemaPath, "utf8");
    const schema = JSON.parse(content);

    expect(schema["$schema"]).toBe("https://json-schema.org/draft-07/schema#");
    expect(schema.title).toBeDefined();
    expect(schema.type).toBe("object");
  });

  it("enforces additionalProperties: false on the root schema and all main sections", () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    expect(schema.additionalProperties).toBe(false);

    const mainSections = [
      "global",
      "app",
      "service",
      "serviceMonitor",
      "grafanaDashboard",
      "worker",
      "migration",
      "retention",
      "ingress",
      "config",
      "secrets",
      "externalSecrets",
      "sealedSecrets",
      "postgresql",
      "redis",
      "serviceAccount",
      "resourceQuota",
      "limitRange",
      "networkPolicy",
    ];

    for (const section of mainSections) {
      expect(schema.properties).toHaveProperty(section);
      expect(schema.properties[section].additionalProperties).toBe(false);
    }
  });

  it("enforces additionalProperties: false on core sub-objects (image, service, autoscaling)", () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

    expect(schema.properties.app.properties.image.additionalProperties).toBe(false);
    expect(schema.properties.app.properties.service.additionalProperties).toBe(false);
    expect(schema.properties.app.properties.autoscaling.additionalProperties).toBe(false);
    expect(schema.properties.worker.properties.image.additionalProperties).toBe(false);
    expect(schema.properties.migration.properties.image.additionalProperties).toBe(false);
    expect(schema.properties.retention.properties.image.additionalProperties).toBe(false);
  });

  it("marks user-input settings (image tag, secrets source) as required with descriptions", () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

    // app image tag and repository
    const appImg = schema.properties.app.properties.image;
    expect(appImg.required).toContain("repository");
    expect(appImg.required).toContain("tag");
    expect(appImg.properties.tag.description).toBeDefined();
    expect(appImg.properties.repository.description).toBeDefined();

    // worker image tag and repository
    const workerImg = schema.properties.worker.properties.image;
    expect(workerImg.required).toContain("repository");
    expect(workerImg.required).toContain("tag");

    // secrets source
    const secrets = schema.properties.secrets;
    expect(secrets.required).toContain("existingSecret");
    expect(secrets.required).toContain("authSecret");
    expect(secrets.properties.existingSecret.description).toBeDefined();
    expect(secrets.properties.authSecret.description).toBeDefined();
  });

  it("enforces types, enums, and numeric ranges on key values", () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

    // service.type enum
    expect(schema.properties.app.properties.service.properties.type.enum).toContain("ClusterIP");
    expect(schema.properties.app.properties.service.properties.type.enum).toContain("NodePort");
    expect(schema.properties.app.properties.service.properties.type.enum).toContain("LoadBalancer");

    // ports range
    expect(schema.properties.app.properties.service.properties.port.minimum).toBe(1);
    expect(schema.properties.app.properties.service.properties.port.maximum).toBe(65535);

    // replica count minimum
    expect(schema.properties.app.properties.replicaCount.minimum).toBe(0);
    expect(schema.properties.worker.properties.replicaCount.minimum).toBe(0);
  });

  it("validates that default values.yaml conforms to the schema without unknown keys", () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    const values = yaml.parse(fs.readFileSync(valuesPath, "utf8"));

    // Top-level keys must all be recognized by the schema
    for (const key of Object.keys(values)) {
      expect(schema.properties).toHaveProperty(key);
    }
  });

  it("provides a deliberately invalid values file in tests/invalid-values.yaml", () => {
    expect(fs.existsSync(invalidValuesPath)).toBe(true);
    const invalidValues = yaml.parse(fs.readFileSync(invalidValuesPath, "utf8"));

    // Contains unknown key and wrong types for negative testing
    expect(invalidValues).toHaveProperty("unknownTopLevelKey");
    expect(typeof invalidValues.app?.replicaCount).toBe("string");
    expect(invalidValues.app?.service?.port).toBeGreaterThan(65535);
  });

  it("documents parameters and their types in helm/secureflow/README.md", () => {
    expect(fs.existsSync(chartReadmePath)).toBe(true);
    const readme = fs.readFileSync(chartReadmePath, "utf8");

    expect(readme).toContain("| Parameter");
    expect(readme).toContain("| Type");
    expect(readme).toContain("| Description");
    expect(readme).toContain("| Default");
    expect(readme).toContain("`app.replicaCount`");
    expect(readme).toContain("`integer`");
    expect(readme).toContain("`app.image.repository`");
    expect(readme).toContain("`string`");
  });

  it("integrates negative schema validation into test-helm-chart.sh and CI workflow", () => {
    const script = fs.readFileSync(testScriptPath, "utf8");
    const workflow = fs.readFileSync(workflowPath, "utf8");

    expect(script).toContain("invalid-values.yaml");
    expect(script).toContain("additional properties");
    expect(workflow).toContain("invalid-values.yaml");
    expect(workflow).toContain("additional properties");
  });
});
