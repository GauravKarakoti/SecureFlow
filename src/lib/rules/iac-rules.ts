/**
 * Deterministic Infrastructure-as-Code (IaC) Security Rules (#2004)
 *
 * Scans changed Dockerfiles, Kubernetes manifests, and Terraform files for high-impact misconfigurations:
 *  1. USER root in Dockerfile
 *  2. privileged: true in Kubernetes manifests
 *  3. hostPath volume mounts in Kubernetes manifests
 *  4. latest or untagged container image tags (Dockerfile and Kubernetes)
 *  5. 0.0.0.0/0 ingress in Terraform security groups
 *  6. Public S3 ACLs (public-read, public-read-write, website) in Terraform
 *  7. Unencrypted storage flags in Terraform
 *
 * Each finding reports rule ID, line number, code snippet, and a one-line fix.
 */

import { computeDynamicFingerprint, computeFingerprint } from "@/lib/armor/fingerprint";
import { parseUnifiedPatch } from "@/lib/armor/diff";
import { detectFileLanguage } from "@/lib/scanner/language-detector";
import type { Severity } from "@/lib/severity";
import type { FileChange, ScanFinding } from "@/lib/armor/scanner";

export const IAC_RULE_IDS = {
  DOCKERFILE_USER_ROOT: "IAC_DOCKERFILE_USER_ROOT",
  K8S_PRIVILEGED_CONTAINER: "IAC_K8S_PRIVILEGED_CONTAINER",
  K8S_HOSTPATH_VOLUME: "IAC_K8S_HOSTPATH_VOLUME",
  LATEST_IMAGE_TAG: "IAC_LATEST_IMAGE_TAG",
  TF_OPEN_INGRESS: "IAC_TF_OPEN_INGRESS",
  TF_PUBLIC_S3_ACL: "IAC_TF_PUBLIC_S3_ACL",
  TF_UNENCRYPTED_STORAGE: "IAC_TF_UNENCRYPTED_STORAGE",
  DOCKER_SOCKET_MOUNT: "IAC_DOCKER_SOCKET_MOUNT",
  CONTAINER_HOST_NAMESPACE: "IAC_CONTAINER_HOST_NAMESPACE",
  K8S_PRIVILEGE_ESCALATION_OR_CAP: "IAC_K8S_PRIVILEGE_ESCALATION_OR_CAP",
  TF_IAM_WILDCARD_POLICY: "IAC_TF_IAM_WILDCARD_POLICY",
} as const;

export type IacRuleId = (typeof IAC_RULE_IDS)[keyof typeof IAC_RULE_IDS];

export interface IacRuleDefinition {
  id: IacRuleId;
  name: string;
  severity: Severity;
  type: "Misconfig";
  description: string;
  oneLineFix: string;
}

export const IAC_RULES: Record<IacRuleId, IacRuleDefinition> = {
  [IAC_RULE_IDS.DOCKERFILE_USER_ROOT]: {
    id: IAC_RULE_IDS.DOCKERFILE_USER_ROOT,
    name: "Dockerfile running as root user",
    severity: "HIGH",
    type: "Misconfig",
    description:
      "Running container processes as root (USER root or USER 0) grants full host root equivalence on container breakout.",
    oneLineFix:
      "Specify a non-root user (e.g. USER 10001:10001 or USER nonroot) before CMD or ENTRYPOINT.",
  },
  [IAC_RULE_IDS.K8S_PRIVILEGED_CONTAINER]: {
    id: IAC_RULE_IDS.K8S_PRIVILEGED_CONTAINER,
    name: "Kubernetes privileged container enabled",
    severity: "HIGH",
    type: "Misconfig",
    description:
      "Container runs with privileged mode enabled, disabling kernel isolation and granting root capabilities to all host devices.",
    oneLineFix:
      "Set 'privileged: false' and grant only required Linux capabilities via 'capabilities: add: [...]'.",
  },
  [IAC_RULE_IDS.K8S_HOSTPATH_VOLUME]: {
    id: IAC_RULE_IDS.K8S_HOSTPATH_VOLUME,
    name: "Kubernetes hostPath volume mount",
    severity: "HIGH",
    type: "Misconfig",
    description:
      "hostPath volume mounts host filesystem paths into pods, allowing container processes to access or overwrite host files.",
    oneLineFix:
      "Replace hostPath with persistentVolumeClaim, emptyDir, or ConfigMap/Secret volumes.",
  },
  [IAC_RULE_IDS.LATEST_IMAGE_TAG]: {
    id: IAC_RULE_IDS.LATEST_IMAGE_TAG,
    name: "Latest or unpinned container image tag",
    severity: "MEDIUM",
    type: "Misconfig",
    description:
      "Using ':latest' or untagged container images causes non-deterministic builds and rollouts that can pull breaking or malicious changes.",
    oneLineFix:
      "Pin container images to an immutable version tag (e.g. ':1.2.3') or SHA256 digest (e.g. '@sha256:...').",
  },
  [IAC_RULE_IDS.TF_OPEN_INGRESS]: {
    id: IAC_RULE_IDS.TF_OPEN_INGRESS,
    name: "Terraform open ingress security group rule (0.0.0.0/0)",
    severity: "HIGH",
    type: "Misconfig",
    description:
      "Security group ingress rule opens port access to the entire internet (0.0.0.0/0), exposing resources to public network probes.",
    oneLineFix:
      "Restrict ingress cidr_blocks to specific trusted CIDR ranges, a bastion host, or private VPC subnets.",
  },
  [IAC_RULE_IDS.TF_PUBLIC_S3_ACL]: {
    id: IAC_RULE_IDS.TF_PUBLIC_S3_ACL,
    name: "Terraform public S3 bucket ACL",
    severity: "HIGH",
    type: "Misconfig",
    description:
      "S3 bucket or bucket ACL is configured with public read or write access, exposing stored data to the public internet.",
    oneLineFix: "Set acl = 'private' and enable aws_s3_bucket_public_access_block on the bucket.",
  },
  [IAC_RULE_IDS.TF_UNENCRYPTED_STORAGE]: {
    id: IAC_RULE_IDS.TF_UNENCRYPTED_STORAGE,
    name: "Terraform unencrypted storage flag",
    severity: "HIGH",
    type: "Misconfig",
    description:
      "Storage resource explicitly disables server-side encryption at rest, exposing stored data to unauthorized disk extraction.",
    oneLineFix:
      "Set encrypted = true (or storage_encrypted = true) and configure a KMS encryption key.",
  },
  [IAC_RULE_IDS.DOCKER_SOCKET_MOUNT]: {
    id: IAC_RULE_IDS.DOCKER_SOCKET_MOUNT,
    name: "Docker socket mount exposure",
    severity: "CRITICAL",
    type: "Misconfig",
    description:
      "Mounting /var/run/docker.sock grants the container full control over the host Docker daemon, enabling trivial container escape and root host compromise.",
    oneLineFix:
      "Remove the /var/run/docker.sock mount or use a rootless/scoped Docker socket proxy.",
  },
  [IAC_RULE_IDS.CONTAINER_HOST_NAMESPACE]: {
    id: IAC_RULE_IDS.CONTAINER_HOST_NAMESPACE,
    name: "Container host namespace sharing",
    severity: "HIGH",
    type: "Misconfig",
    description:
      "Sharing host network, PID, or IPC namespaces weakens container isolation and exposes host processes and loopback services.",
    oneLineFix:
      "Disable hostNetwork, hostPID, hostIPC, and host network_mode/pid settings unless strictly required.",
  },
  [IAC_RULE_IDS.K8S_PRIVILEGE_ESCALATION_OR_CAP]: {
    id: IAC_RULE_IDS.K8S_PRIVILEGE_ESCALATION_OR_CAP,
    name: "Kubernetes privilege escalation or dangerous Linux capability",
    severity: "HIGH",
    type: "Misconfig",
    description:
      "Container enables allowPrivilegeEscalation or adds dangerous Linux capabilities (SYS_ADMIN, NET_ADMIN, ALL) that permit kernel/host escalation.",
    oneLineFix: "Set allowPrivilegeEscalation: false and drop ALL capabilities (`drop: [ALL]`).",
  },
  [IAC_RULE_IDS.TF_IAM_WILDCARD_POLICY]: {
    id: IAC_RULE_IDS.TF_IAM_WILDCARD_POLICY,
    name: "Terraform IAM wildcard privilege",
    severity: "HIGH",
    type: "Misconfig",
    description:
      "IAM policy statement grants wildcard Action ('*') privileges, violating least-privilege access control.",
    oneLineFix:
      "Scope IAM actions to specific required service operations instead of wildcard '*'.",
  },
};

export interface IacRuleFinding {
  ruleId: IacRuleId;
  ruleName: string;
  severity: Severity;
  type: "Misconfig";
  fileLocation: string;
  lineStart: number;
  lineEnd: number;
  codeSnippet: string;
  description: string;
  oneLineFix: string;
}

export interface IacRuleOptions {
  repositoryId?: string;
  enabled?: boolean;
  disabledRules?: string[];
}

export interface IacLine {
  number: number;
  content: string;
}

/**
 * Checks if a filename represents a Dockerfile.
 */
export function isDockerfile(filename: string): boolean {
  if (!filename) return false;
  const normalized = filename.replace(/\\/g, "/");
  const basename = normalized.split("/").pop() || "";
  return (
    basename === "Dockerfile" ||
    basename.startsWith("Dockerfile.") ||
    basename.endsWith(".Dockerfile") ||
    basename === "Containerfile" ||
    basename.startsWith("Containerfile.") ||
    basename.endsWith(".Containerfile")
  );
}

/**
 * Checks if a filename (and optional content) represents a Kubernetes manifest.
 */
export function isKubernetesManifest(filename: string, content?: string): boolean {
  if (!filename) return false;
  const normalized = filename.replace(/\\/g, "/").toLowerCase();
  const isYaml = normalized.endsWith(".yaml") || normalized.endsWith(".yml");
  if (!isYaml) return false;

  // Never treat GitHub Actions workflows as Kubernetes manifests
  if (normalized.startsWith(".github/workflows/")) return false;

  // Common K8s directory patterns or filenames
  const parts = normalized.split("/");
  const dirParts = parts.slice(0, -1);
  const isK8sDir = dirParts.some((p) =>
    ["k8s", "kubernetes", "helm", "manifests", "deploy"].includes(p),
  );
  if (
    isK8sDir ||
    normalized.endsWith(".k8s.yaml") ||
    normalized.endsWith(".k8s.yml") ||
    parts[parts.length - 1].startsWith("k8s-")
  ) {
    return true;
  }

  // Sniff content for Kubernetes apiVersion and kind
  if (content) {
    const hasApiVersion = /^\s*apiVersion\s*:\s*[a-zA-Z0-9.\/]+/m.test(content);
    const hasKind =
      /^\s*kind\s*:\s*(Deployment|Pod|DaemonSet|StatefulSet|Job|CronJob|ReplicaSet|ReplicationController|Service|Ingress|ConfigMap|Secret|Namespace)/m.test(
        content,
      );
    if (hasApiVersion && hasKind) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a filename represents a Terraform configuration file.
 */
export function isTerraformFile(filename: string): boolean {
  if (!filename) return false;
  const normalized = filename.replace(/\\/g, "/").toLowerCase();
  return normalized.endsWith(".tf");
}

/**
 * Checks if a filename represents a Docker Compose configuration file.
 */
export function isDockerComposeFile(filename: string): boolean {
  if (!filename) return false;
  const normalized = filename.replace(/\\/g, "/").toLowerCase();
  const basename = normalized.split("/").pop() || "";
  return /^(?:docker-)?compose(?:[.-][a-z0-9_-]+)?\.ya?ml$/.test(basename);
}

/**
 * Checks if a file is an IaC target file (Dockerfile, Docker Compose, Kubernetes manifest, or Terraform file).
 */
export function isIacFile(filename: string, content?: string): boolean {
  return (
    isDockerfile(filename) ||
    isDockerComposeFile(filename) ||
    isKubernetesManifest(filename, content) ||
    isTerraformFile(filename)
  );
}

/**
 * Extracts line numbers and contents from either a unified diff patch or raw file content.
 */
export function extractIacLines(patchOrContent: string): IacLine[] {
  if (!patchOrContent) return [];

  if (patchOrContent.includes("@@")) {
    const parsed = parseUnifiedPatch(patchOrContent);
    return parsed.lines.map((l) => ({ number: l.number, content: l.content }));
  }

  const rawLines = patchOrContent.split(/\r?\n/);
  const isDiff = rawLines.some(
    (l) =>
      l.startsWith("+") || l.startsWith("-") || l.startsWith("diff ") || l.startsWith("index "),
  );

  if (isDiff) {
    const result: IacLine[] = [];
    let lineNum = 1;
    for (const line of rawLines) {
      if (
        line.startsWith("+++") ||
        line.startsWith("---") ||
        line.startsWith("diff ") ||
        line.startsWith("index ")
      ) {
        continue;
      }
      if (line.startsWith("+")) {
        result.push({ number: lineNum, content: line.slice(1) });
        lineNum++;
      } else if (!line.startsWith("-")) {
        result.push({ number: lineNum, content: line });
        lineNum++;
      }
    }
    return result;
  }

  return rawLines.map((content, idx) => ({ number: idx + 1, content }));
}

/**
 * Rule 1: Flags USER root in Dockerfiles.
 */
export function checkDockerfileUserRoot(lines: IacLine[], filename: string): IacRuleFinding[] {
  const findings: IacRuleFinding[] = [];
  const def = IAC_RULES[IAC_RULE_IDS.DOCKERFILE_USER_ROOT];
  const userRootRegex = /^\s*USER\s+(?:root|0)(?::(?:root|0))?\s*$/i;

  for (const line of lines) {
    const trimmed = line.content.trim();
    if (trimmed.startsWith("#")) continue;

    if (userRootRegex.test(trimmed)) {
      findings.push({
        ruleId: def.id,
        ruleName: def.name,
        severity: def.severity,
        type: def.type,
        fileLocation: filename,
        lineStart: line.number,
        lineEnd: line.number,
        codeSnippet: trimmed,
        description: def.description,
        oneLineFix: def.oneLineFix,
      });
    }
  }

  return findings;
}

/**
 * Rule 2: Flags privileged: true in Kubernetes manifests.
 */
export function checkK8sPrivilegedContainer(lines: IacLine[], filename: string): IacRuleFinding[] {
  const findings: IacRuleFinding[] = [];
  const def = IAC_RULES[IAC_RULE_IDS.K8S_PRIVILEGED_CONTAINER];
  const privilegedRegex = /^\s*(?:-\s+)?privileged\s*:\s*["']?true["']?\s*(?:#.*)?$/i;

  for (const line of lines) {
    const trimmed = line.content.trim();
    if (trimmed.startsWith("#")) continue;

    if (privilegedRegex.test(trimmed)) {
      findings.push({
        ruleId: def.id,
        ruleName: def.name,
        severity: def.severity,
        type: def.type,
        fileLocation: filename,
        lineStart: line.number,
        lineEnd: line.number,
        codeSnippet: trimmed,
        description: def.description,
        oneLineFix: def.oneLineFix,
      });
    }
  }

  return findings;
}

/**
 * Rule 3: Flags hostPath volume definitions in Kubernetes manifests.
 */
export function checkK8sHostPathVolume(lines: IacLine[], filename: string): IacRuleFinding[] {
  const findings: IacRuleFinding[] = [];
  const def = IAC_RULES[IAC_RULE_IDS.K8S_HOSTPATH_VOLUME];
  const hostPathRegex = /^\s*(?:-\s+)?hostPath\s*:/i;

  for (const line of lines) {
    const trimmed = line.content.trim();
    if (trimmed.startsWith("#")) continue;

    if (hostPathRegex.test(trimmed)) {
      findings.push({
        ruleId: def.id,
        ruleName: def.name,
        severity: def.severity,
        type: def.type,
        fileLocation: filename,
        lineStart: line.number,
        lineEnd: line.number,
        codeSnippet: trimmed,
        description: def.description,
        oneLineFix: def.oneLineFix,
      });
    }
  }

  return findings;
}

/**
 * Rule 4: Flags latest or untagged container image tags in Dockerfile and Kubernetes manifests.
 */
export function checkLatestImageTag(
  lines: IacLine[],
  filename: string,
  fileType: "docker" | "k8s",
): IacRuleFinding[] {
  const findings: IacRuleFinding[] = [];
  const def = IAC_RULES[IAC_RULE_IDS.LATEST_IMAGE_TAG];

  if (fileType === "docker") {
    // Matches: FROM [--platform=...] <image> [AS <stage>]
    const fromRegex = /^\s*FROM\s+(?:--platform=[^\s]+\s+)?([^\s]+)(?:\s+AS\s+[^\s]+)?/i;

    for (const line of lines) {
      const trimmed = line.content.trim();
      if (trimmed.startsWith("#")) continue;

      const match = trimmed.match(fromRegex);
      if (match) {
        const image = match[1];
        if (image.toLowerCase() === "scratch") continue;

        const isLatest = image.endsWith(":latest");
        const hasNoTagOrDigest = !image.includes(":") && !image.includes("@");

        if (isLatest || hasNoTagOrDigest) {
          findings.push({
            ruleId: def.id,
            ruleName: def.name,
            severity: def.severity,
            type: def.type,
            fileLocation: filename,
            lineStart: line.number,
            lineEnd: line.number,
            codeSnippet: trimmed,
            description: def.description,
            oneLineFix: def.oneLineFix,
          });
        }
      }
    }
  } else if (fileType === "k8s") {
    // Matches: image: <image>
    const imageRegex = /^\s*(?:-\s+)?image\s*:\s*["']?([^"'\s#]+)["']?/i;

    for (const line of lines) {
      const trimmed = line.content.trim();
      if (trimmed.startsWith("#")) continue;

      const match = trimmed.match(imageRegex);
      if (match) {
        const image = match[1];
        const isLatest = image.endsWith(":latest");
        const hasNoTagOrDigest = !image.includes(":") && !image.includes("@");

        if (isLatest || hasNoTagOrDigest) {
          findings.push({
            ruleId: def.id,
            ruleName: def.name,
            severity: def.severity,
            type: def.type,
            fileLocation: filename,
            lineStart: line.number,
            lineEnd: line.number,
            codeSnippet: trimmed,
            description: def.description,
            oneLineFix: def.oneLineFix,
          });
        }
      }
    }
  }

  return findings;
}

/**
 * Rule 5: Flags 0.0.0.0/0 ingress in Terraform security groups.
 */
export function checkTerraformOpenIngress(lines: IacLine[], filename: string): IacRuleFinding[] {
  const findings: IacRuleFinding[] = [];
  const def = IAC_RULES[IAC_RULE_IDS.TF_OPEN_INGRESS];

  // We scan blocks to determine whether we are inside an ingress configuration
  let braceDepth = 0;
  let inIngressBlockDepth = -1;
  let inSecurityGroupRuleBlockDepth = -1;
  let ruleType: string | null = null;
  const pendingRuleLines: { line: IacLine; trimmed: string }[] = [];

  for (const line of lines) {
    const trimmed = line.content.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

    // Detect ingress block start, e.g. `ingress {`
    if (/^\s*ingress\s*\{/i.test(trimmed)) {
      inIngressBlockDepth = braceDepth;
    }

    // Detect aws_security_group_rule block start
    if (/^\s*resource\s*"aws_security_group_rule"\s*"[^"]+"\s*\{/i.test(trimmed)) {
      inSecurityGroupRuleBlockDepth = braceDepth;
      ruleType = null;
      pendingRuleLines.length = 0;
    }

    // If inside aws_security_group_rule, track type
    if (inSecurityGroupRuleBlockDepth >= 0) {
      const typeMatch = trimmed.match(/type\s*=\s*["'](ingress|egress)["']/i);
      if (typeMatch) {
        ruleType = typeMatch[1].toLowerCase();
      }
    }

    // Check if line contains 0.0.0.0/0 or ::/0 in cidr_blocks
    const isOpenCidr =
      /cidr_blocks\s*=\s*\[[^\]]*["'](?:0\.0\.0\.0\/0|::\/0)["'][^\]]*\]/i.test(trimmed) ||
      (/["'](?:0\.0\.0\.0\/0|::\/0)["']/i.test(trimmed) && /cidr_blocks/i.test(line.content));

    if (isOpenCidr) {
      if (inIngressBlockDepth >= 0) {
        findings.push({
          ruleId: def.id,
          ruleName: def.name,
          severity: def.severity,
          type: def.type,
          fileLocation: filename,
          lineStart: line.number,
          lineEnd: line.number,
          codeSnippet: trimmed,
          description: def.description,
          oneLineFix: def.oneLineFix,
        });
      } else if (inSecurityGroupRuleBlockDepth >= 0) {
        if (ruleType === "ingress") {
          findings.push({
            ruleId: def.id,
            ruleName: def.name,
            severity: def.severity,
            type: def.type,
            fileLocation: filename,
            lineStart: line.number,
            lineEnd: line.number,
            codeSnippet: trimmed,
            description: def.description,
            oneLineFix: def.oneLineFix,
          });
        } else if (ruleType === null) {
          // Type hasn't been encountered yet in this block; queue line
          pendingRuleLines.push({ line, trimmed });
        }
      }
    }

    // Count open and close braces
    const openBraces = (line.content.match(/\{/g) || []).length;
    const closeBraces = (line.content.match(/\}/g) || []).length;
    braceDepth += openBraces - closeBraces;

    if (inIngressBlockDepth >= 0 && braceDepth <= inIngressBlockDepth) {
      inIngressBlockDepth = -1;
    }

    if (inSecurityGroupRuleBlockDepth >= 0 && braceDepth <= inSecurityGroupRuleBlockDepth) {
      // Exiting security group rule block; check pending lines if rule was ingress
      if (ruleType === "ingress") {
        for (const pending of pendingRuleLines) {
          findings.push({
            ruleId: def.id,
            ruleName: def.name,
            severity: def.severity,
            type: def.type,
            fileLocation: filename,
            lineStart: pending.line.number,
            lineEnd: pending.line.number,
            codeSnippet: pending.trimmed,
            description: def.description,
            oneLineFix: def.oneLineFix,
          });
        }
      }
      inSecurityGroupRuleBlockDepth = -1;
      ruleType = null;
      pendingRuleLines.length = 0;
    }
  }

  return findings;
}

/**
 * Rule 6: Flags public S3 ACLs (public-read, public-read-write, website) in Terraform.
 */
export function checkTerraformPublicS3Acl(lines: IacLine[], filename: string): IacRuleFinding[] {
  const findings: IacRuleFinding[] = [];
  const def = IAC_RULES[IAC_RULE_IDS.TF_PUBLIC_S3_ACL];
  const publicAclRegex = /^\s*acl\s*=\s*["'](public-read|public-read-write|website)["']/i;

  for (const line of lines) {
    const trimmed = line.content.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

    if (publicAclRegex.test(trimmed)) {
      findings.push({
        ruleId: def.id,
        ruleName: def.name,
        severity: def.severity,
        type: def.type,
        fileLocation: filename,
        lineStart: line.number,
        lineEnd: line.number,
        codeSnippet: trimmed,
        description: def.description,
        oneLineFix: def.oneLineFix,
      });
    }
  }

  return findings;
}

/**
 * Rule 7: Flags unencrypted storage flags in Terraform.
 */
export function checkTerraformUnencryptedStorage(
  lines: IacLine[],
  filename: string,
): IacRuleFinding[] {
  const findings: IacRuleFinding[] = [];
  const def = IAC_RULES[IAC_RULE_IDS.TF_UNENCRYPTED_STORAGE];
  const unencryptedRegex = /^\s*(?:encrypted|storage_encrypted|enable_encryption)\s*=\s*false\b/i;

  for (const line of lines) {
    const trimmed = line.content.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

    if (unencryptedRegex.test(trimmed)) {
      findings.push({
        ruleId: def.id,
        ruleName: def.name,
        severity: def.severity,
        type: def.type,
        fileLocation: filename,
        lineStart: line.number,
        lineEnd: line.number,
        codeSnippet: trimmed,
        description: def.description,
        oneLineFix: def.oneLineFix,
      });
    }
  }

  return findings;
}

/**
 * Rule 8: Detects /var/run/docker.sock mounts in Docker Compose and Kubernetes manifests.
 */
export function checkDockerSocketMount(lines: IacLine[], filename: string): IacRuleFinding[] {
  const findings: IacRuleFinding[] = [];
  const rule = IAC_RULES[IAC_RULE_IDS.DOCKER_SOCKET_MOUNT];

  for (const line of lines) {
    const trimmed = line.content.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (/\/var\/run\/docker\.sock\b/i.test(trimmed)) {
      findings.push({
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        type: rule.type,
        fileLocation: filename,
        lineStart: line.number,
        lineEnd: line.number,
        codeSnippet: trimmed,
        description: rule.description,
        oneLineFix: rule.oneLineFix,
      });
    }
  }

  return findings;
}

/**
 * Rule 9: Detects host network, PID, or IPC namespace sharing in Compose and Kubernetes.
 */
export function checkContainerHostNamespace(lines: IacLine[], filename: string): IacRuleFinding[] {
  const findings: IacRuleFinding[] = [];
  const rule = IAC_RULES[IAC_RULE_IDS.CONTAINER_HOST_NAMESPACE];

  for (const line of lines) {
    const trimmed = line.content.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (
      /^(?:-\s+)?(?:network_mode|pid|ipc)\s*:\s*["']?host["']?\b/i.test(trimmed) ||
      /^(?:-\s+)?(?:hostNetwork|hostPID|hostIPC)\s*:\s*true\b/i.test(trimmed)
    ) {
      findings.push({
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        type: rule.type,
        fileLocation: filename,
        lineStart: line.number,
        lineEnd: line.number,
        codeSnippet: trimmed,
        description: rule.description,
        oneLineFix: rule.oneLineFix,
      });
    }
  }

  return findings;
}

/**
 * Rule 10: Detects allowPrivilegeEscalation: true and dangerous Linux capabilities in Kubernetes.
 */
export function checkK8sPrivilegeEscalationOrCapabilities(
  lines: IacLine[],
  filename: string,
): IacRuleFinding[] {
  const findings: IacRuleFinding[] = [];
  const rule = IAC_RULES[IAC_RULE_IDS.K8S_PRIVILEGE_ESCALATION_OR_CAP];
  let inCapabilitiesAdd = false;

  for (const line of lines) {
    const trimmed = line.content.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (/^add\s*:/i.test(trimmed)) {
      inCapabilitiesAdd = true;
      if (/\[\s*[^\]]*\b(?:CAP_)?(?:SYS_ADMIN|NET_ADMIN|ALL)\b/i.test(trimmed)) {
        findings.push({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          type: rule.type,
          fileLocation: filename,
          lineStart: line.number,
          lineEnd: line.number,
          codeSnippet: trimmed,
          description: rule.description,
          oneLineFix: rule.oneLineFix,
        });
        inCapabilitiesAdd = false;
      }
      continue;
    }

    if (/^(?:-\s+)?allowPrivilegeEscalation\s*:\s*true\b/i.test(trimmed)) {
      inCapabilitiesAdd = false;
      findings.push({
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        type: rule.type,
        fileLocation: filename,
        lineStart: line.number,
        lineEnd: line.number,
        codeSnippet: trimmed,
        description: rule.description,
        oneLineFix: rule.oneLineFix,
      });
      continue;
    }

    if (inCapabilitiesAdd) {
      if (trimmed.startsWith("-")) {
        if (/^-\s*["']?(?:CAP_)?(?:SYS_ADMIN|NET_ADMIN|ALL)["']?\b/i.test(trimmed)) {
          findings.push({
            ruleId: rule.id,
            ruleName: rule.name,
            severity: rule.severity,
            type: rule.type,
            fileLocation: filename,
            lineStart: line.number,
            lineEnd: line.number,
            codeSnippet: trimmed,
            description: rule.description,
            oneLineFix: rule.oneLineFix,
          });
        }
      } else {
        inCapabilitiesAdd = false;
      }
    }
  }

  return findings;
}

/**
 * Rule 11: Detects Terraform IAM policy statements with wildcard Action ("*").
 */
export function checkTerraformIamWildcardPolicy(
  lines: IacLine[],
  filename: string,
): IacRuleFinding[] {
  const findings: IacRuleFinding[] = [];
  const rule = IAC_RULES[IAC_RULE_IDS.TF_IAM_WILDCARD_POLICY];

  for (const line of lines) {
    const trimmed = line.content.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

    if (
      /(?:^|\b)(?:Action|actions)\s*=\s*(?:"\*"|\[\s*"\*"\s*\])/i.test(trimmed) ||
      /"Action"\s*:\s*(?:"\*"|\[\s*"\*"\s*\])/i.test(trimmed)
    ) {
      findings.push({
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        type: rule.type,
        fileLocation: filename,
        lineStart: line.number,
        lineEnd: line.number,
        codeSnippet: trimmed,
        description: rule.description,
        oneLineFix: rule.oneLineFix,
      });
    }
  }

  return findings;
}

/**
 * Scans a single IaC file and returns normalized ScanFinding items.
 */
export function scanIacFile(
  filename: string,
  patchOrContent: string,
  options: IacRuleOptions = {},
): ScanFinding[] {
  if (options.enabled === false) {
    return [];
  }

  if (!isIacFile(filename, patchOrContent)) {
    return [];
  }

  const lines = extractIacLines(patchOrContent);
  if (lines.length === 0) {
    return [];
  }

  const rawFindings: IacRuleFinding[] = [];
  const isDocker = isDockerfile(filename);
  const isCompose = isDockerComposeFile(filename);
  const isK8s = isKubernetesManifest(filename, patchOrContent);
  const isTf = isTerraformFile(filename);

  if (isDocker) {
    rawFindings.push(...checkDockerfileUserRoot(lines, filename));
    rawFindings.push(...checkLatestImageTag(lines, filename, "docker"));
  }

  if (isCompose) {
    rawFindings.push(...checkK8sPrivilegedContainer(lines, filename));
    rawFindings.push(...checkDockerSocketMount(lines, filename));
    rawFindings.push(...checkContainerHostNamespace(lines, filename));
    rawFindings.push(...checkLatestImageTag(lines, filename, "k8s"));
  }

  if (isK8s) {
    rawFindings.push(...checkK8sPrivilegedContainer(lines, filename));
    rawFindings.push(...checkK8sHostPathVolume(lines, filename));
    rawFindings.push(...checkDockerSocketMount(lines, filename));
    rawFindings.push(...checkContainerHostNamespace(lines, filename));
    rawFindings.push(...checkK8sPrivilegeEscalationOrCapabilities(lines, filename));
    rawFindings.push(...checkLatestImageTag(lines, filename, "k8s"));
  }

  if (isTf) {
    rawFindings.push(...checkTerraformOpenIngress(lines, filename));
    rawFindings.push(...checkTerraformPublicS3Acl(lines, filename));
    rawFindings.push(...checkTerraformUnencryptedStorage(lines, filename));
    rawFindings.push(...checkTerraformIamWildcardPolicy(lines, filename));
  }

  // Filter out disabled rules
  const disabledSet = new Set((options.disabledRules || []).map((r) => r.trim().toUpperCase()));
  const activeFindings =
    disabledSet.size > 0
      ? rawFindings.filter((f) => !disabledSet.has(f.ruleId.toUpperCase()))
      : rawFindings;

  const repositoryId = options.repositoryId || "default-repo";

  return activeFindings.map((finding) => {
    const dynFp = computeDynamicFingerprint(
      repositoryId,
      filename,
      finding.type,
      finding.codeSnippet,
    );
    const standardFp = computeFingerprint(
      repositoryId,
      filename,
      finding.type,
      finding.codeSnippet,
    );
    const langInfo = detectFileLanguage(filename, finding.codeSnippet);

    return {
      type: finding.type,
      severity: finding.severity,
      confidence: "HIGH",
      confidenceReason: `Deterministic IaC security rule: ${finding.ruleId}`,
      description: `[${finding.ruleId}] ${finding.description} Fix: ${finding.oneLineFix}`,
      fileLocation: filename,
      codeSnippet: finding.codeSnippet,
      lineStart: finding.lineStart,
      lineEnd: finding.lineEnd,
      dynamicFingerprint: dynFp.fingerprint,
      fingerprint: standardFp,
      signatureVersion: "1.0.0",
      matchedSignatures: [finding.ruleId, "iac-rules-deterministic"],
      isZeroDay: false,
      language: langInfo.language,
      ...(langInfo.framework ? { framework: langInfo.framework } : {}),
      remediation: finding.oneLineFix,
    };
  });
}

/**
 * Runs IaC security rules across a set of changed files.
 * Ignores any files that are not Dockerfile*, Kubernetes manifests, or *.tf.
 */
export function runIacSecurityRules(
  files: FileChange[],
  options: IacRuleOptions = {},
): ScanFinding[] {
  if (options.enabled === false) {
    return [];
  }

  const findings: ScanFinding[] = [];

  for (const file of files) {
    if (!file.patch || !file.patch.trim()) continue;
    if (!isIacFile(file.filename, file.patch)) continue;

    const fileFindings = scanIacFile(file.filename, file.patch, options);
    findings.push(...fileFindings);
  }

  return findings;
}
