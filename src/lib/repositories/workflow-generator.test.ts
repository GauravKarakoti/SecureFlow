import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  generateWorkflowYaml,
  WORKFLOW_FILE_PATH,
  type WorkflowOptions,
} from "./workflow-generator";

describe("Workflow Generator (#2230)", () => {
  it("exposes the standard workflow file path", () => {
    expect(WORKFLOW_FILE_PATH).toBe(".github/workflows/secureflow.yml");
  });

  it("generates syntactically valid YAML with default options", () => {
    const yamlStr = generateWorkflowYaml();
    expect(yamlStr).toBeTruthy();

    const parsed = parseYaml(yamlStr);
    expect(parsed.name).toBe("SecureFlow Security Scan");
    expect(parsed.on.push.branches).toContain("main");
    expect(parsed.on.pull_request.branches).toContain("main");

    const scanJob = parsed.jobs.scan;
    expect(scanJob.runs_on || scanJob["runs-on"]).toBe("ubuntu-latest");
    expect(scanJob.permissions["contents"]).toBe("read");
    expect(scanJob.permissions["pull-requests"]).toBe("write");
    expect(scanJob.permissions["security-events"]).toBe("write");

    const steps = scanJob.steps;
    expect(steps).toHaveLength(3); // checkout, secureflow, upload-sarif

    const sfStep = steps.find((s: any) => s.id === "secureflow");
    expect(sfStep.uses).toBe("GauravKarakoti/SecureFlow@main");
    expect(sfStep.with["paths"]).toBe(".");
    expect(sfStep.with["severity"]).toBe("low");
    expect(sfStep.with["fail-threshold"]).toBe("high");
    expect(sfStep.with["comment-on-pr"]).toBe("true");
    expect(sfStep.with["format"]).toBe("sarif");
    expect(sfStep.with["github-token"]).toBe("${{ secrets.GITHUB_TOKEN }}");
  });

  it("includes header comment when repository option is provided", () => {
    const yamlStr = generateWorkflowYaml({ repository: "acme/backend" });
    expect(yamlStr.startsWith("# SecureFlow Security Scan Workflow for acme/backend")).toBe(true);

    const parsed = parseYaml(yamlStr);
    expect(parsed.name).toBe("SecureFlow Security Scan");
  });

  it("disables PR review comments when prComments is false", () => {
    const yamlStr = generateWorkflowYaml({ prComments: false });
    const parsed = parseYaml(yamlStr);

    // pull-requests: write permission should be omitted
    expect(parsed.jobs.scan.permissions["pull-requests"]).toBeUndefined();

    const sfStep = parsed.jobs.scan.steps.find((s: any) => s.id === "secureflow");
    expect(sfStep.with["comment-on-pr"]).toBe("false");
  });

  it("configures AI remediation inputs and env when aiRemediation is true", () => {
    const yamlStr = generateWorkflowYaml({ aiRemediation: true });
    const parsed = parseYaml(yamlStr);

    const sfStep = parsed.jobs.scan.steps.find((s: any) => s.id === "secureflow");
    expect(sfStep.with["ai-remediation"]).toBe("true");
    expect(sfStep.env["OPENAI_API_KEY"]).toBe("${{ secrets.OPENAI_API_KEY }}");
  });

  it("supports custom severity and fail-threshold options", () => {
    const yamlStr = generateWorkflowYaml({
      severity: "high",
      failThreshold: "critical",
    });
    const parsed = parseYaml(yamlStr);

    const sfStep = parsed.jobs.scan.steps.find((s: any) => s.id === "secureflow");
    expect(sfStep.with["severity"]).toBe("high");
    expect(sfStep.with["fail-threshold"]).toBe("critical");
  });

  it("supports custom scan paths and target branches", () => {
    const yamlStr = generateWorkflowYaml({
      paths: "src/api",
      workflowBranch: "master",
    });
    const parsed = parseYaml(yamlStr);

    expect(parsed.on.push.branches).toContain("master");
    expect(parsed.on.pull_request.branches).toContain("master");

    const sfStep = parsed.jobs.scan.steps.find((s: any) => s.id === "secureflow");
    expect(sfStep.with["paths"]).toBe("src/api");
  });

  it("omits SARIF upload step and security-events permission when uploadSarif is false", () => {
    const yamlStr = generateWorkflowYaml({ uploadSarif: false });
    const parsed = parseYaml(yamlStr);

    expect(parsed.jobs.scan.permissions["security-events"]).toBeUndefined();
    const sarifStep = parsed.jobs.scan.steps.find((s: any) =>
      s.uses?.includes("upload-sarif"),
    );
    expect(sarifStep).toBeUndefined();
  });

  it("never includes hardcoded plain-text API secrets in generated YAML", () => {
    const yamlStr = generateWorkflowYaml({ aiRemediation: true, repository: "test/repo" });
    expect(yamlStr).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
    expect(yamlStr).not.toMatch(/ghp_[a-zA-Z0-9]{20,}/);
    expect(yamlStr).toContain("${{ secrets.GITHUB_TOKEN }}");
    expect(yamlStr).toContain("${{ secrets.OPENAI_API_KEY }}");
  });
});

