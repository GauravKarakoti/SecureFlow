import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  isDockerfile,
  isKubernetesManifest,
  isTerraformFile,
  isIacFile,
  scanIacFile,
  runIacSecurityRules,
  IAC_RULE_IDS,
} from "./iac-rules";
import { mergePrecheckWithLlmFindings } from "@/lib/armor/precheck";
import { parseSecureFlowConfig, resolveIacRuleOptions } from "@/lib/scanner/gate-config";
import type { ScanFinding } from "@/lib/armor/scanner";

const FIXTURES_DIR = path.join(__dirname, "fixtures");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
}

describe("Infrastructure-as-Code (IaC) Security Rules (#2004)", () => {
  describe("File Type Detection", () => {
    it("identifies Dockerfiles correctly", () => {
      expect(isDockerfile("Dockerfile")).toBe(true);
      expect(isDockerfile("Dockerfile.dev")).toBe(true);
      expect(isDockerfile("api/Dockerfile")).toBe(true);
      expect(isDockerfile("docker/prod.Dockerfile")).toBe(true);
      expect(isDockerfile("Containerfile")).toBe(true);
      expect(isDockerfile("src/main.ts")).toBe(false);
      expect(isDockerfile("docker-compose.yml")).toBe(false);
    });

    it("identifies Kubernetes manifests correctly", () => {
      expect(isKubernetesManifest("k8s/deployment.yaml")).toBe(true);
      expect(isKubernetesManifest("deploy/service.yml")).toBe(true);
      expect(isKubernetesManifest("helm/templates/pod.yaml")).toBe(true);
      expect(isKubernetesManifest("k8s-pod.yaml")).toBe(true);
      expect(isKubernetesManifest("pod.k8s.yaml")).toBe(true);
      expect(isKubernetesManifest(".github/workflows/ci.yml")).toBe(false);
      expect(isKubernetesManifest("random.yaml", "apiVersion: v1\nkind: Pod")).toBe(true);
      expect(isKubernetesManifest("random.yaml", "name: test\nversion: 1.0")).toBe(false);
    });

    it("identifies Terraform files correctly", () => {
      expect(isTerraformFile("main.tf")).toBe(true);
      expect(isTerraformFile("infra/security.tf")).toBe(true);
      expect(isTerraformFile("variables.tf")).toBe(true);
      expect(isTerraformFile("main.tfvars")).toBe(false);
      expect(isTerraformFile("main.json")).toBe(false);
    });

    it("identifies general IaC files", () => {
      expect(isIacFile("Dockerfile")).toBe(true);
      expect(isIacFile("deploy/pod.yaml")).toBe(true);
      expect(isIacFile("security.tf")).toBe(true);
      expect(isIacFile("src/index.ts")).toBe(false);
    });
  });

  describe("Rule 1: USER root in Dockerfile (IAC_DOCKERFILE_USER_ROOT)", () => {
    const vuln = readFixture("dockerfile-root.vulnerable.Dockerfile");
    const safe = readFixture("dockerfile-root.safe.Dockerfile");

    it("flags USER root with HIGH severity, Misconfig type, line number and one-line fix", () => {
      const findings = scanIacFile("Dockerfile", vuln);
      const rootFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(IAC_RULE_IDS.DOCKERFILE_USER_ROOT),
      );

      expect(rootFindings.length).toBe(1);
      const finding = rootFindings[0];
      expect(finding.severity).toBe("HIGH");
      expect(finding.type).toBe("Misconfig");
      expect(finding.lineStart).toBe(6);
      expect(finding.codeSnippet).toBe("USER root");
      expect(finding.description).toContain(IAC_RULE_IDS.DOCKERFILE_USER_ROOT);
      expect(finding.remediation).toContain("Specify a non-root user");
      expect(finding.dynamicFingerprint).toBeTruthy();
    });

    it("passes safe Dockerfile specifying non-root user", () => {
      const findings = scanIacFile("Dockerfile", safe);
      const rootFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(IAC_RULE_IDS.DOCKERFILE_USER_ROOT),
      );
      expect(rootFindings.length).toBe(0);
    });
  });

  describe("Rule 2: privileged: true in Kubernetes (IAC_K8S_PRIVILEGED_CONTAINER)", () => {
    const vuln = readFixture("k8s-privileged.vulnerable.yaml");
    const safe = readFixture("k8s-privileged.safe.yaml");

    it("flags privileged: true in container securityContext with HIGH severity and one-line fix", () => {
      const findings = scanIacFile("k8s/privileged.yaml", vuln);
      const privFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(IAC_RULE_IDS.K8S_PRIVILEGED_CONTAINER),
      );

      expect(privFindings.length).toBe(1);
      const finding = privFindings[0];
      expect(finding.severity).toBe("HIGH");
      expect(finding.type).toBe("Misconfig");
      expect(finding.lineStart).toBe(10);
      expect(finding.codeSnippet).toBe("privileged: true");
      expect(finding.remediation).toContain("Set 'privileged: false'");
    });

    it("passes safe Kubernetes manifest without privileged container", () => {
      const findings = scanIacFile("k8s/safe.yaml", safe);
      const privFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(IAC_RULE_IDS.K8S_PRIVILEGED_CONTAINER),
      );
      expect(privFindings.length).toBe(0);
    });
  });

  describe("Rule 3: hostPath volume in Kubernetes (IAC_K8S_HOSTPATH_VOLUME)", () => {
    const vuln = readFixture("k8s-hostpath.vulnerable.yaml");
    const safe = readFixture("k8s-hostpath.safe.yaml");

    it("flags hostPath volume mount with HIGH severity and one-line fix", () => {
      const findings = scanIacFile("k8s/hostpath.yaml", vuln);
      const hostPathFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(IAC_RULE_IDS.K8S_HOSTPATH_VOLUME),
      );

      expect(hostPathFindings.length).toBe(1);
      const finding = hostPathFindings[0];
      expect(finding.severity).toBe("HIGH");
      expect(finding.type).toBe("Misconfig");
      expect(finding.lineStart).toBe(14);
      expect(finding.codeSnippet).toBe("hostPath:");
      expect(finding.remediation).toContain("Replace hostPath with persistentVolumeClaim");
    });

    it("passes safe Kubernetes manifest using emptyDir", () => {
      const findings = scanIacFile("k8s/safe.yaml", safe);
      const hostPathFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(IAC_RULE_IDS.K8S_HOSTPATH_VOLUME),
      );
      expect(hostPathFindings.length).toBe(0);
    });
  });

  describe("Rule 4: latest image tags (IAC_LATEST_IMAGE_TAG)", () => {
    const dockerVuln = readFixture("iac-latest-tag.vulnerable.Dockerfile");
    const dockerSafe = readFixture("iac-latest-tag.safe.Dockerfile");
    const k8sVuln = readFixture("k8s-latest-tag.vulnerable.yaml");
    const k8sSafe = readFixture("k8s-latest-tag.safe.yaml");

    it("flags latest tag in Dockerfile", () => {
      const findings = scanIacFile("Dockerfile", dockerVuln);
      const latestFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(IAC_RULE_IDS.LATEST_IMAGE_TAG),
      );

      expect(latestFindings.length).toBe(1);
      expect(latestFindings[0].severity).toBe("MEDIUM");
      expect(latestFindings[0].lineStart).toBe(1);
      expect(latestFindings[0].codeSnippet).toContain("FROM alpine:latest");
      expect(latestFindings[0].remediation).toContain("Pin container images");
    });

    it("passes pinned tag in Dockerfile", () => {
      const findings = scanIacFile("Dockerfile", dockerSafe);
      const latestFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(IAC_RULE_IDS.LATEST_IMAGE_TAG),
      );
      expect(latestFindings.length).toBe(0);
    });

    it("flags latest tag in Kubernetes manifest", () => {
      const findings = scanIacFile("k8s/deployment.yaml", k8sVuln);
      const latestFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(IAC_RULE_IDS.LATEST_IMAGE_TAG),
      );

      expect(latestFindings.length).toBe(1);
      expect(latestFindings[0].severity).toBe("MEDIUM");
      expect(latestFindings[0].lineStart).toBe(14);
      expect(latestFindings[0].codeSnippet).toContain("image: nginx:latest");
    });

    it("passes pinned tag in Kubernetes manifest", () => {
      const findings = scanIacFile("k8s/deployment.yaml", k8sSafe);
      const latestFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(IAC_RULE_IDS.LATEST_IMAGE_TAG),
      );
      expect(latestFindings.length).toBe(0);
    });
  });

  describe("Rule 5: 0.0.0.0/0 ingress in Terraform (IAC_TF_OPEN_INGRESS)", () => {
    const vuln = readFixture("tf-open-ingress.vulnerable.tf");
    const safe = readFixture("tf-open-ingress.safe.tf");

    it("flags 0.0.0.0/0 ingress with HIGH severity, and ignores egress 0.0.0.0/0", () => {
      const findings = scanIacFile("main.tf", vuln);
      const ingressFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(IAC_RULE_IDS.TF_OPEN_INGRESS),
      );

      expect(ingressFindings.length).toBe(1);
      const finding = ingressFindings[0];
      expect(finding.severity).toBe("HIGH");
      expect(finding.lineStart).toBe(11);
      expect(finding.codeSnippet).toContain('cidr_blocks = ["0.0.0.0/0"]');
      expect(finding.remediation).toContain("Restrict ingress cidr_blocks");
    });

    it("passes restricted private CIDR ingress in Terraform", () => {
      const findings = scanIacFile("main.tf", safe);
      const ingressFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(IAC_RULE_IDS.TF_OPEN_INGRESS),
      );
      expect(ingressFindings.length).toBe(0);
    });
  });

  describe("Rule 6: Public S3 ACL in Terraform (IAC_TF_PUBLIC_S3_ACL)", () => {
    const vuln = readFixture("tf-public-s3.vulnerable.tf");
    const safe = readFixture("tf-public-s3.safe.tf");

    it("flags public-read and public-read-write ACLs with HIGH severity and one-line fix", () => {
      const findings = scanIacFile("s3.tf", vuln);
      const s3Findings = findings.filter((f) =>
        f.matchedSignatures?.includes(IAC_RULE_IDS.TF_PUBLIC_S3_ACL),
      );

      expect(s3Findings.length).toBe(2);
      expect(s3Findings[0].severity).toBe("HIGH");
      expect(s3Findings[0].lineStart).toBe(3);
      expect(s3Findings[0].codeSnippet).toContain('acl    = "public-read"');
      expect(s3Findings[1].lineStart).toBe(12);
      expect(s3Findings[1].codeSnippet).toContain('acl    = "public-read-write"');
      expect(s3Findings[0].remediation).toContain("Set acl = 'private'");
    });

    it("passes private S3 ACLs in Terraform", () => {
      const findings = scanIacFile("s3.tf", safe);
      const s3Findings = findings.filter((f) =>
        f.matchedSignatures?.includes(IAC_RULE_IDS.TF_PUBLIC_S3_ACL),
      );
      expect(s3Findings.length).toBe(0);
    });
  });

  describe("Rule 7: Unencrypted storage flags in Terraform (IAC_TF_UNENCRYPTED_STORAGE)", () => {
    const vuln = readFixture("tf-unencrypted-storage.vulnerable.tf");
    const safe = readFixture("tf-unencrypted-storage.safe.tf");

    it("flags encrypted = false and storage_encrypted = false with HIGH severity", () => {
      const findings = scanIacFile("storage.tf", vuln);
      const storageFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(IAC_RULE_IDS.TF_UNENCRYPTED_STORAGE),
      );

      expect(storageFindings.length).toBe(2);
      expect(storageFindings[0].severity).toBe("HIGH");
      expect(storageFindings[0].lineStart).toBe(4);
      expect(storageFindings[0].codeSnippet).toContain("encrypted         = false");
      expect(storageFindings[1].lineStart).toBe(14);
      expect(storageFindings[1].codeSnippet).toContain("storage_encrypted = false");
      expect(storageFindings[0].remediation).toContain("Set encrypted = true");
    });

    it("passes encrypted storage resources in Terraform", () => {
      const findings = scanIacFile("storage.tf", safe);
      const storageFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(IAC_RULE_IDS.TF_UNENCRYPTED_STORAGE),
      );
      expect(storageFindings.length).toBe(0);
    });
  });

  describe("Disabling Rules per Repository via .secureflow.json", () => {
    const vulnDockerfile = readFixture("dockerfile-root.vulnerable.Dockerfile");

    it("disables specific rules when configured in disabledRules", () => {
      const config = parseSecureFlowConfig(
        JSON.stringify({
          rules: {
            disabled: ["IAC_DOCKERFILE_USER_ROOT"],
          },
        }),
      );
      const options = resolveIacRuleOptions(config);

      const findings = scanIacFile("Dockerfile", vulnDockerfile, options);
      const rootFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(IAC_RULE_IDS.DOCKERFILE_USER_ROOT),
      );
      expect(rootFindings.length).toBe(0);
    });

    it("disables all IaC rules when rules.iac is false", () => {
      const config = parseSecureFlowConfig(
        JSON.stringify({
          rules: {
            iac: false,
          },
        }),
      );
      const options = resolveIacRuleOptions(config);

      const findings = scanIacFile("Dockerfile", vulnDockerfile, options);
      expect(findings.length).toBe(0);
    });

    it("disables individual rules with boolean flag: { rules: { IAC_DOCKERFILE_USER_ROOT: false } }", () => {
      const config = parseSecureFlowConfig(
        JSON.stringify({
          rules: {
            IAC_DOCKERFILE_USER_ROOT: false,
          },
        }),
      );
      const options = resolveIacRuleOptions(config);

      const findings = scanIacFile("Dockerfile", vulnDockerfile, options);
      const rootFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(IAC_RULE_IDS.DOCKERFILE_USER_ROOT),
      );
      expect(rootFindings.length).toBe(0);
    });
  });

  describe("Merging and Deduplication with LLM Findings", () => {
    it("merges deterministic IaC findings with LLM findings and avoids duplicates by fingerprint", () => {
      const vulnDockerfile = readFixture("dockerfile-root.vulnerable.Dockerfile");
      const iacFindings = scanIacFile("Dockerfile", vulnDockerfile);
      expect(iacFindings.length).toBeGreaterThan(0);

      const deterministic = iacFindings[0];

      // Simulate LLM finding pointing to the same file and line or having same fingerprint
      const duplicateLlmFinding: ScanFinding = {
        type: "Misconfig",
        severity: "HIGH",
        description: "LLM detected root user",
        fileLocation: deterministic.fileLocation,
        lineStart: deterministic.lineStart,
        lineEnd: deterministic.lineEnd,
        codeSnippet: deterministic.codeSnippet,
        dynamicFingerprint: deterministic.dynamicFingerprint,
      };

      const distinctLlmFinding: ScanFinding = {
        type: "Vulnerability",
        severity: "MEDIUM",
        description: "Unrelated application issue",
        fileLocation: "src/server.ts",
        lineStart: 42,
        lineEnd: 42,
        codeSnippet: "const debug = true;",
        dynamicFingerprint: "fp-distinct-llm-123",
      };

      const merged = mergePrecheckWithLlmFindings(
        [deterministic],
        [duplicateLlmFinding, distinctLlmFinding],
      );

      // The duplicate LLM finding must be omitted in favor of the deterministic finding
      expect(merged.length).toBe(2);
      expect(merged[0]).toEqual(deterministic);
      expect(merged[1]).toEqual(distinctLlmFinding);
    });
  });

  describe("Docker Compose, Kubernetes escalation & Terraform IAM wildcard rules (#2111)", () => {
    it("detects docker.sock mounts, host namespaces, and privileged flags in Docker Compose", () => {
      const composeYaml = `
services:
  runner:
    image: alpine:3.19
    network_mode: host
    pid: host
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`;
      const findings = scanIacFile("docker-compose.yml", composeYaml);
      expect(findings.some((f) => f.description.includes(IAC_RULE_IDS.DOCKER_SOCKET_MOUNT))).toBe(
        true,
      );
      expect(
        findings.filter((f) => f.description.includes(IAC_RULE_IDS.CONTAINER_HOST_NAMESPACE)),
      ).toHaveLength(2);
    });

    it("detects Kubernetes allowPrivilegeEscalation, dangerous capabilities, hostNetwork, and hostPID", () => {
      const k8sYaml = `
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      hostNetwork: true
      hostPID: true
      containers:
        - name: app
          image: myapp:1.2.3
          securityContext:
            allowPrivilegeEscalation: true
            capabilities:
              add:
                - SYS_ADMIN
                - NET_ADMIN
`;
      const findings = scanIacFile("k8s/deployment.yaml", k8sYaml);
      expect(
        findings.filter((f) => f.description.includes(IAC_RULE_IDS.CONTAINER_HOST_NAMESPACE)),
      ).toHaveLength(2);
      expect(
        findings.filter((f) =>
          f.description.includes(IAC_RULE_IDS.K8S_PRIVILEGE_ESCALATION_OR_CAP),
        ),
      ).toHaveLength(3);
    });

    it("detects Terraform IAM wildcard Action policies and ignores comments", () => {
      const tfPolicy = `
# Action = "*" (commented out example should not trigger)
resource "aws_iam_policy" "admin" {
  policy = jsonencode({
    Statement = [{
      Effect   = "Allow"
      Action   = "*"
      Resource = "*"
    }]
  })
}

data "aws_iam_policy_document" "wildcard" {
  statement {
    actions = ["*"]
  }
}
`;
      const findings = scanIacFile("infra/iam.tf", tfPolicy);
      const wildcardFindings = findings.filter((f) =>
        f.description.includes(IAC_RULE_IDS.TF_IAM_WILDCARD_POLICY),
      );
      expect(wildcardFindings).toHaveLength(2);
    });
  });
});
