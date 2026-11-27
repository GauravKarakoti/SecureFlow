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
  IAM_WILDCARD_FULL_ADMIN: "IAC_IAM_WILDCARD_FULL_ADMIN",
  IAM_WILDCARD_PRINCIPAL_NO_CONDITIONS: "IAC_IAM_WILDCARD_PRINCIPAL_NO_CONDITIONS",
  IAM_PASSROLE_WILDCARD: "IAC_IAM_PASSROLE_WILDCARD",
  K8S_CLUSTER_ADMIN_OR_WILDCARD_RBAC: "IAC_K8S_CLUSTER_ADMIN_OR_WILDCARD_RBAC",
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
  [IAC_RULE_IDS.IAM_WILDCARD_FULL_ADMIN]: {
    id: IAC_RULE_IDS.IAM_WILDCARD_FULL_ADMIN,
    name: "IAM policy grants wildcard Action on wildcard Resource (* on *)",
    severity: "CRITICAL",
    type: "Misconfig",
    description:
      "IAM policy statement grants full administrator privileges (Action: '*' on Resource: '*'), enabling unrestricted account takeover.",
    oneLineFix:
      "Scope actions to specific service operations and restrict resources to explicit target ARNs instead of wildcard (* on *).",
  },
  [IAC_RULE_IDS.IAM_WILDCARD_PRINCIPAL_NO_CONDITIONS]: {
    id: IAC_RULE_IDS.IAM_WILDCARD_PRINCIPAL_NO_CONDITIONS,
    name: "IAM policy grants wildcard Principal without conditions",
    severity: "HIGH",
    type: "Misconfig",
    description:
      "IAM resource policy allows wildcard Principal ('*') without condition constraints, exposing the resource to public or arbitrary AWS account access.",
    oneLineFix:
      "Restrict Principal to trusted AWS account ARNs/roles, or add strict condition keys (e.g. aws:PrincipalOrgID).",
  },
  [IAC_RULE_IDS.IAM_PASSROLE_WILDCARD]: {
    id: IAC_RULE_IDS.IAM_PASSROLE_WILDCARD,
    name: "IAM policy grants iam:PassRole on wildcard Resource (*)",
    severity: "HIGH",
    type: "Misconfig",
    description:
      "Granting iam:PassRole on Resource '*' allows passing any IAM role in the account, enabling privilege escalation to higher-privileged service roles.",
    oneLineFix:
      "Restrict iam:PassRole resources to specific role ARNs that the service is authorized to assume.",
  },
  [IAC_RULE_IDS.K8S_CLUSTER_ADMIN_OR_WILDCARD_RBAC]: {
    id: IAC_RULE_IDS.K8S_CLUSTER_ADMIN_OR_WILDCARD_RBAC,
    name: "Kubernetes ClusterRoleBinding to cluster-admin or wildcard RBAC",
    severity: "CRITICAL",
    type: "Misconfig",
    description:
      "Kubernetes RBAC binds to cluster-admin or grants wildcard verbs ('*') on wildcard resources ('*'), granting complete cluster takeover privileges.",
    oneLineFix:
      "Bind a scoped Role/ClusterRole with least-privilege verbs and resources instead of cluster-admin or wildcard verbs/resources.",
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

export interface IacExceptionConfig {
  rule?: string;
  file?: string;
  path?: string;
  line?: number;
  lines?: number[];
  reason: string;
}

export interface IacRuleOptions {
  repositoryId?: string;
  enabled?: boolean;
  disabledRules?: string[];
  exceptions?: IacExceptionConfig[];
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
      /^\s*kind\s*:\s*(Deployment|Pod|DaemonSet|StatefulSet|Job|CronJob|ReplicaSet|ReplicationController|Service|Ingress|ConfigMap|Secret|Namespace|ClusterRole|ClusterRoleBinding|Role|RoleBinding|ServiceAccount)/m.test(
        content,
      );
    const hasRbacApi = /rbac\.authorization\.k8s\.io/i.test(content);
    if ((hasApiVersion && hasKind) || (hasKind && hasRbacApi)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a filename (and optional content) represents a CloudFormation template.
 */
export function isCloudFormationFile(filename: string, content?: string): boolean {
  if (!filename) return false;
  const normalized = filename.replace(/\\/g, "/").toLowerCase();
  const isCandidateExt =
    normalized.endsWith(".yaml") ||
    normalized.endsWith(".yml") ||
    normalized.endsWith(".json") ||
    normalized.endsWith(".template");
  if (!isCandidateExt) return false;

  const parts = normalized.split("/");
  const basename = parts[parts.length - 1];
  const dirParts = parts.slice(0, -1);

  if (
    dirParts.some((d) => ["cloudformation", "cfn", "cft"].includes(d)) ||
    basename.includes(".cf.") ||
    basename.includes(".cft.") ||
    basename.startsWith("cf-") ||
    basename.startsWith("cfn-") ||
    basename.endsWith("template.yaml") ||
    basename.endsWith("template.yml") ||
    basename.endsWith("template.json")
  ) {
    return true;
  }

  if (content) {
    if (
      content.includes("AWSTemplateFormatVersion") ||
      (content.includes("Resources") && /AWS::[a-zA-Z0-9]+::[a-zA-Z0-9]+/i.test(content))
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a filename (and optional content) represents a JSON/YAML IAM policy file.
 */
export function isIamPolicyFile(filename: string, content?: string): boolean {
  if (!filename) return false;
  const normalized = filename.replace(/\\/g, "/").toLowerCase();
  const isCandidateExt =
    normalized.endsWith(".yaml") || normalized.endsWith(".yml") || normalized.endsWith(".json");
  if (!isCandidateExt) return false;

  const parts = normalized.split("/");
  const basename = parts[parts.length - 1];
  const dirParts = parts.slice(0, -1);

  if (
    dirParts.some((d) => ["iam", "policies", "policy", "roles"].includes(d)) ||
    basename.includes("policy") ||
    basename.includes("iam")
  ) {
    return true;
  }

  if (content) {
    const hasStatement = /(?:^|\b)(?:Statement|statement)\b/i.test(content);
    const hasAction = /(?:^|\b)(?:Action|actions)\b/i.test(content);
    const hasResourceOrPrincipal = /(?:^|\b)(?:Resource|resources|Principal|principal)\b/i.test(
      content,
    );
    if (hasStatement && hasAction && hasResourceOrPrincipal) {
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
 * Checks if a file is an IaC target file (Dockerfile, Docker Compose, Kubernetes manifest, Terraform, CloudFormation, or IAM policy).
 */
export function isIacFile(filename: string, content?: string): boolean {
  return (
    isDockerfile(filename) ||
    isDockerComposeFile(filename) ||
    isKubernetesManifest(filename, content) ||
    isTerraformFile(filename) ||
    isCloudFormationFile(filename, content) ||
    isIamPolicyFile(filename, content)
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
  const isDiff =
    patchOrContent.includes("diff --git") ||
    rawLines.some(
      (l) =>
        l.startsWith("+++ ") ||
        l.startsWith("--- ") ||
        l.startsWith("diff ") ||
        l.startsWith("index "),
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
 * Splits lines into statement blocks for IAM policy analysis across Terraform, CloudFormation, and JSON/YAML files (#2160).
 */
export function splitIamStatements(
  lines: IacLine[],
  filename: string,
): Array<{ lines: IacLine[]; startLine: number }> {
  const statements: Array<{ lines: IacLine[]; startLine: number }> = [];
  const lower = filename.toLowerCase();
  const isTf = lower.endsWith(".tf");

  if (isTf) {
    let currentBlock: IacLine[] = [];
    let braceDepth = 0;
    let inStatement = false;

    for (const line of lines) {
      const trimmed = line.content.trim();
      if (/^\s*(?:dynamic\s*"statement"|statement)\s*\{/i.test(trimmed)) {
        if (inStatement && currentBlock.length > 0) {
          statements.push({ lines: currentBlock, startLine: currentBlock[0].number });
        }
        inStatement = true;
        currentBlock = [line];
        braceDepth = 1;
        continue;
      }

      if (inStatement) {
        currentBlock.push(line);
        const openBraces = (line.content.match(/\{/g) || []).length;
        const closeBraces = (line.content.match(/\}/g) || []).length;
        braceDepth += openBraces - closeBraces;

        if (braceDepth <= 0) {
          statements.push({ lines: currentBlock, startLine: currentBlock[0].number });
          currentBlock = [];
          inStatement = false;
        }
      } else {
        currentBlock.push(line);
      }
    }

    if (currentBlock.length > 0) {
      statements.push({ lines: currentBlock, startLine: currentBlock[0].number });
    }

    return statements;
  }

  // JSON or YAML
  const isJson =
    lower.endsWith(".json") ||
    lines.some((l) => l.content.includes('"Statement"') || l.content.includes('"Action"'));

  if (isJson) {
    // If the file contains "Statement": [ ... ], extract each object in that array
    if (lines.some((l) => /"Statement"\s*:/i.test(l.content))) {
      const arrayStatements: Array<{ lines: IacLine[]; startLine: number }> = [];
      let inStatementArray = false;
      let objBlock: IacLine[] = [];
      let objDepth = 0;

      for (const line of lines) {
        const trimmed = line.content.trim();
        if (/"Statement"\s*:\s*\[/i.test(trimmed)) {
          inStatementArray = true;
          continue;
        }

        if (inStatementArray) {
          const openBraces = (line.content.match(/\{/g) || []).length;
          const closeBraces = (line.content.match(/\}/g) || []).length;

          if (objDepth === 0 && openBraces > 0) {
            objBlock = [line];
            objDepth += openBraces - closeBraces;
            if (objDepth <= 0) {
              arrayStatements.push({ lines: objBlock, startLine: objBlock[0].number });
              objBlock = [];
              objDepth = 0;
            }
          } else if (objDepth > 0) {
            objBlock.push(line);
            objDepth += openBraces - closeBraces;
            if (objDepth <= 0) {
              arrayStatements.push({ lines: objBlock, startLine: objBlock[0].number });
              objBlock = [];
              objDepth = 0;
            }
          } else if (/^\s*\]/i.test(trimmed)) {
            inStatementArray = false;
          }
        }
      }

      if (arrayStatements.length > 0) {
        return arrayStatements;
      }
    }

    let currentBlock: IacLine[] = [];
    let braceDepth = 0;
    let inStatement = false;

    for (const line of lines) {
      const openBraces = (line.content.match(/\{/g) || []).length;
      const closeBraces = (line.content.match(/\}/g) || []).length;

      if (!inStatement) {
        if (openBraces > 0) {
          currentBlock = [line];
          braceDepth = openBraces - closeBraces;
          inStatement = true;
          if (braceDepth <= 0) {
            statements.push({ lines: currentBlock, startLine: currentBlock[0].number });
            currentBlock = [];
            braceDepth = 0;
            inStatement = false;
          }
        }
        continue;
      }

      if (inStatement) {
        currentBlock.push(line);
        braceDepth += openBraces - closeBraces;
        if (braceDepth <= 0) {
          statements.push({ lines: currentBlock, startLine: currentBlock[0].number });
          currentBlock = [];
          braceDepth = 0;
          inStatement = false;
        }
      }
    }

    if (currentBlock.length > 0) {
      statements.push({ lines: currentBlock, startLine: currentBlock[0].number });
    }

    return statements;
  }

  // YAML: split by list items `- ` under Statement or `- Effect:` / `- Action:` or document `---`
  let currentBlock: IacLine[] = [];
  for (const line of lines) {
    const trimmed = line.content.trim();
    if (
      trimmed.startsWith("---") ||
      /^\s*-\s+(?:Sid|Effect|Action|Principal|Resource):/i.test(line.content) ||
      (/^\s*-\s*$/i.test(line.content) && currentBlock.length > 0)
    ) {
      if (currentBlock.length > 0) {
        statements.push({ lines: currentBlock, startLine: currentBlock[0].number });
      }
      currentBlock = [line];
    } else {
      currentBlock.push(line);
    }
  }

  if (currentBlock.length > 0) {
    statements.push({ lines: currentBlock, startLine: currentBlock[0].number });
  }

  return statements;
}

/**
 * Rules 12-14: Detects IAM Privilege Escalation (#2160):
 *  - Action: "*" with Resource: "*"
 *  - Principal: "*" without conditions
 *  - iam:PassRole on "*"
 */
export function checkIamPrivilegeEscalation(lines: IacLine[], filename: string): IacRuleFinding[] {
  const findings: IacRuleFinding[] = [];
  const statements = splitIamStatements(lines, filename);

  const fullAdminRule = IAC_RULES[IAC_RULE_IDS.IAM_WILDCARD_FULL_ADMIN];
  const principalRule = IAC_RULES[IAC_RULE_IDS.IAM_WILDCARD_PRINCIPAL_NO_CONDITIONS];
  const passRoleRule = IAC_RULES[IAC_RULE_IDS.IAM_PASSROLE_WILDCARD];

  for (const statement of statements) {
    const stLines = statement.lines;
    const isDeny = stLines.some((l) =>
      /(?:Effect|effect)["']?\s*[:=]\s*["']?Deny/i.test(l.content),
    );
    if (isDeny) {
      continue;
    }

    const hasCondition = stLines.some((l) =>
      /(?:Condition|condition)["']?\s*[:={]/i.test(l.content),
    );

    // 1. Wildcard Action check
    let hasWildcardAction = false;
    let hasPassRole = false;
    let actionLine: IacLine | undefined;
    let passRoleLine: IacLine | undefined;

    let inActionBlock = false;
    const actionItems: string[] = [];

    for (const l of stLines) {
      const trimmed = l.content.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

      if (/(?:Action|actions)["']?\s*[:=]\s*(?:["']\*["']|\[\s*["']\*["']\s*\])/i.test(trimmed)) {
        hasWildcardAction = true;
        actionLine = l;
      }

      if (/\biam:passrole\b/i.test(trimmed)) {
        hasPassRole = true;
        passRoleLine = l;
      }

      if (/(?:Action|actions)["']?\s*[:=]\s*(?:\[)?\s*$/i.test(trimmed)) {
        inActionBlock = true;
        continue;
      }

      if (inActionBlock) {
        if (/^\s*-\s*["']?([^"'\s#]+)["']?/i.test(trimmed)) {
          const itemMatch = trimmed.match(/^\s*-\s*["']?([^"'\s#]+)["']?/i);
          if (itemMatch) {
            actionItems.push(itemMatch[1]);
            if (itemMatch[1] === "*") {
              actionLine = l;
            }
            if (/^iam:passrole$/i.test(itemMatch[1])) {
              hasPassRole = true;
              passRoleLine = l;
            }
          }
        } else if (/^\s*["']([^"']+)["']/i.test(trimmed)) {
          const itemMatch = trimmed.match(/^\s*["']([^"']+)["']/i);
          if (itemMatch) {
            actionItems.push(itemMatch[1]);
            if (itemMatch[1] === "*") {
              actionLine = l;
            }
            if (/^iam:passrole$/i.test(itemMatch[1])) {
              hasPassRole = true;
              passRoleLine = l;
            }
          }
        } else if (
          /^\s*\]/i.test(trimmed) ||
          /(?:Resource|Effect|Principal|Condition)/i.test(trimmed)
        ) {
          inActionBlock = false;
        }
      }
    }

    if (actionItems.length === 1 && actionItems[0] === "*") {
      hasWildcardAction = true;
    }

    // 2. Wildcard Resource check
    let hasWildcardResource = false;
    let resourceLine: IacLine | undefined;
    let inResourceBlock = false;
    const resourceItems: string[] = [];

    for (const l of stLines) {
      const trimmed = l.content.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

      if (
        /(?:Resource|resources)["']?\s*[:=]\s*(?:["']\*["']|\[\s*["']\*["']\s*\])/i.test(trimmed)
      ) {
        hasWildcardResource = true;
        resourceLine = l;
      }

      if (/(?:Resource|resources)["']?\s*[:=]\s*(?:\[)?\s*$/i.test(trimmed)) {
        inResourceBlock = true;
        continue;
      }

      if (inResourceBlock) {
        if (/^\s*-\s*["']?([^"'\s#]+)["']?/i.test(trimmed)) {
          const itemMatch = trimmed.match(/^\s*-\s*["']?([^"'\s#]+)["']?/i);
          if (itemMatch) {
            resourceItems.push(itemMatch[1]);
            if (itemMatch[1] === "*") {
              resourceLine = l;
            }
          }
        } else if (/^\s*["']([^"']+)["']/i.test(trimmed)) {
          const itemMatch = trimmed.match(/^\s*["']([^"']+)["']/i);
          if (itemMatch) {
            resourceItems.push(itemMatch[1]);
            if (itemMatch[1] === "*") {
              resourceLine = l;
            }
          }
        } else if (
          /^\s*\]/i.test(trimmed) ||
          /(?:Action|Effect|Principal|Condition)/i.test(trimmed)
        ) {
          inResourceBlock = false;
        }
      }
    }

    if (resourceItems.length === 1 && resourceItems[0] === "*") {
      hasWildcardResource = true;
    }

    // 3. Wildcard Principal check
    let hasWildcardPrincipal = false;
    let principalLine: IacLine | undefined;

    for (const l of stLines) {
      const trimmed = l.content.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

      if (
        /(?:Principal|principal)["']?\s*[:=]\s*["']\*["']/i.test(trimmed) ||
        /(?:Principal|principal)["']?\s*[:=]\s*\{[^\}]*["']?AWS["']?\s*:\s*["']\*["']/i.test(
          trimmed,
        ) ||
        /(?:^|\b)identifiers\s*=\s*\[\s*["']\*["']\s*\]/i.test(trimmed) ||
        /^\s*AWS\s*[:=]\s*["']\*["']/i.test(trimmed)
      ) {
        hasWildcardPrincipal = true;
        principalLine = l;
      }
    }

    // Rule 1: Action: "*" with Resource: "*"
    if (hasWildcardAction && hasWildcardResource) {
      const reportLine = resourceLine || actionLine || stLines[0];
      findings.push({
        ruleId: fullAdminRule.id,
        ruleName: fullAdminRule.name,
        severity: fullAdminRule.severity,
        type: fullAdminRule.type,
        fileLocation: filename,
        lineStart: reportLine.number,
        lineEnd: reportLine.number,
        codeSnippet: reportLine.content.trim(),
        description: fullAdminRule.description,
        oneLineFix: fullAdminRule.oneLineFix,
      });
    }

    // Rule 2: Principal: "*" without conditions
    if (hasWildcardPrincipal && !hasCondition) {
      const reportLine = principalLine || stLines[0];
      findings.push({
        ruleId: principalRule.id,
        ruleName: principalRule.name,
        severity: principalRule.severity,
        type: principalRule.type,
        fileLocation: filename,
        lineStart: reportLine.number,
        lineEnd: reportLine.number,
        codeSnippet: reportLine.content.trim(),
        description: principalRule.description,
        oneLineFix: principalRule.oneLineFix,
      });
    }

    // Rule 3: iam:PassRole on *
    if (hasPassRole && hasWildcardResource) {
      const reportLine = passRoleLine || resourceLine || stLines[0];
      findings.push({
        ruleId: passRoleRule.id,
        ruleName: passRoleRule.name,
        severity: passRoleRule.severity,
        type: passRoleRule.type,
        fileLocation: filename,
        lineStart: reportLine.number,
        lineEnd: reportLine.number,
        codeSnippet: reportLine.content.trim(),
        description: passRoleRule.description,
        oneLineFix: passRoleRule.oneLineFix,
      });
    }
  }

  return findings;
}

/**
 * Evaluates an individual RBAC rule item for wildcard verbs and wildcard resources (#2160).
 */
function evaluateRbacRule(
  ruleLines: IacLine[],
  filename: string,
  rule: IacRuleDefinition,
  findings: IacRuleFinding[],
): void {
  let hasWildcardVerbs = false;
  let hasWildcardResources = false;
  let verbsLine: IacLine | undefined;
  let resourcesLine: IacLine | undefined;

  let inVerbsList = false;
  let inResourcesList = false;
  const verbs: string[] = [];
  const resources: string[] = [];

  for (const l of ruleLines) {
    const trimmed = l.content.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (/verbs\s*:\s*\[[^\]]*["']\*["'][^\]]*\]/i.test(trimmed)) {
      hasWildcardVerbs = true;
      verbsLine = l;
    }

    if (/resources\s*:\s*\[[^\]]*["']\*["'][^\]]*\]/i.test(trimmed)) {
      hasWildcardResources = true;
      resourcesLine = l;
    }

    if (/verbs\s*:\s*$/i.test(trimmed)) {
      inVerbsList = true;
      inResourcesList = false;
      continue;
    }

    if (/resources\s*:\s*$/i.test(trimmed)) {
      inResourcesList = true;
      inVerbsList = false;
      continue;
    }

    if (inVerbsList) {
      if (/^\s*-\s*["']?([^"'\s#]+)["']?/i.test(trimmed)) {
        const match = trimmed.match(/^\s*-\s*["']?([^"'\s#]+)["']?/i);
        if (match) {
          verbs.push(match[1]);
          if (match[1] === "*") {
            hasWildcardVerbs = true;
            verbsLine = l;
          }
        }
      } else if (/^\s*[a-zA-Z0-9_-]+\s*:/i.test(trimmed)) {
        inVerbsList = false;
      }
    }

    if (inResourcesList) {
      if (/^\s*-\s*["']?([^"'\s#]+)["']?/i.test(trimmed)) {
        const match = trimmed.match(/^\s*-\s*["']?([^"'\s#]+)["']?/i);
        if (match) {
          resources.push(match[1]);
          if (match[1] === "*") {
            hasWildcardResources = true;
            resourcesLine = l;
          }
        }
      } else if (/^\s*[a-zA-Z0-9_-]+\s*:/i.test(trimmed)) {
        inResourcesList = false;
      }
    }
  }

  if (hasWildcardVerbs && hasWildcardResources) {
    const reportLine = verbsLine || resourcesLine || ruleLines[0];
    findings.push({
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      type: rule.type,
      fileLocation: filename,
      lineStart: reportLine.number,
      lineEnd: reportLine.number,
      codeSnippet: reportLine.content.trim(),
      description: rule.description,
      oneLineFix: rule.oneLineFix,
    });
  }
}

/**
 * Rule 15: Detects Kubernetes ClusterRoleBinding to cluster-admin or wildcard RBAC verbs on wildcard resources (#2160).
 */
export function checkK8sClusterAdminOrWildcardRbac(
  lines: IacLine[],
  filename: string,
): IacRuleFinding[] {
  const findings: IacRuleFinding[] = [];
  const rule = IAC_RULES[IAC_RULE_IDS.K8S_CLUSTER_ADMIN_OR_WILDCARD_RBAC];

  // Split into documents by `---`
  const docs: IacLine[][] = [];
  let currentDoc: IacLine[] = [];

  for (const l of lines) {
    if (l.content.trim().startsWith("---")) {
      if (currentDoc.length > 0) {
        docs.push(currentDoc);
        currentDoc = [];
      }
    } else {
      currentDoc.push(l);
    }
  }
  if (currentDoc.length > 0) {
    docs.push(currentDoc);
  }

  for (const doc of docs) {
    let kind: string | null = null;
    let inRoleRef = false;

    for (const l of doc) {
      const trimmed = l.content.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      if (!inRoleRef) {
        const kindMatch = trimmed.match(/^\s*kind\s*:\s*["']?([a-zA-Z0-9]+)["']?/i);
        if (kindMatch) {
          kind = kindMatch[1];
        }
      }

      if (/^\s*roleRef\s*:/i.test(trimmed)) {
        inRoleRef = true;
        continue;
      }

      if (inRoleRef) {
        if (/^\s*name\s*:\s*["']?cluster-admin["']?/i.test(trimmed)) {
          if (!kind || kind.toLowerCase() === "clusterrolebinding") {
            findings.push({
              ruleId: rule.id,
              ruleName: rule.name,
              severity: rule.severity,
              type: rule.type,
              fileLocation: filename,
              lineStart: l.number,
              lineEnd: l.number,
              codeSnippet: trimmed,
              description: rule.description,
              oneLineFix: rule.oneLineFix,
            });
          }
          inRoleRef = false;
        } else if (
          /^\s*[a-zA-Z0-9_-]+\s*:/i.test(trimmed) &&
          !/^\s*(apiGroup|kind|name)\s*:/i.test(trimmed) &&
          !trimmed.startsWith("-")
        ) {
          inRoleRef = false;
        }
      }
    }

    // Case B: Role or ClusterRole with verbs: ["*"] on resources: ["*"]
    if (!kind || ["clusterrole", "role"].includes(kind.toLowerCase())) {
      let currentRuleLines: IacLine[] = [];
      let inRulesSection = false;

      for (const l of doc) {
        const trimmed = l.content.trim();
        if (/^\s*rules\s*:/i.test(trimmed)) {
          inRulesSection = true;
          continue;
        }

        if (inRulesSection) {
          if (/^\s*-\s+(?:apiGroups|resources|verbs|nonResourceURLs):/i.test(l.content)) {
            if (currentRuleLines.length > 0) {
              evaluateRbacRule(currentRuleLines, filename, rule, findings);
              currentRuleLines = [];
            }
          }
          currentRuleLines.push(l);
        }
      }

      if (currentRuleLines.length > 0) {
        evaluateRbacRule(currentRuleLines, filename, rule, findings);
      }
    }
  }

  return findings;
}

/**
 * Matches a file path against a glob pattern.
 */
function matchGlob(str: string, pattern: string): boolean {
  if (pattern === "*" || pattern === "**") return true;
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regexStr}$`, "i").test(str) || new RegExp(`${regexStr}$`, "i").test(str);
}

/**
 * Checks whether an IaC rule finding is exempted by configured exceptions (#2160).
 */
export function isIacFindingExempt(
  finding: IacRuleFinding,
  exceptions: IacExceptionConfig[] = [],
): boolean {
  if (!exceptions || exceptions.length === 0) return false;

  for (const exc of exceptions) {
    if (exc.rule && exc.rule !== "*" && exc.rule.toUpperCase() !== finding.ruleId.toUpperCase()) {
      continue;
    }

    const targetPath = (exc.file || exc.path || "").trim();
    if (targetPath) {
      const normalizedTarget = targetPath.replace(/\\/g, "/").toLowerCase();
      const normalizedFindingFile = finding.fileLocation.replace(/\\/g, "/").toLowerCase();

      const isMatch =
        normalizedFindingFile === normalizedTarget ||
        normalizedFindingFile.endsWith("/" + normalizedTarget) ||
        normalizedFindingFile.includes(normalizedTarget) ||
        matchGlob(normalizedFindingFile, normalizedTarget);

      if (!isMatch) {
        continue;
      }
    }

    if (exc.line !== undefined && exc.line !== finding.lineStart) {
      continue;
    }
    if (Array.isArray(exc.lines) && !exc.lines.includes(finding.lineStart)) {
      continue;
    }

    if (typeof exc.reason === "string" && exc.reason.trim()) {
      return true;
    }
  }

  return false;
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
  const isCf = isCloudFormationFile(filename, patchOrContent);
  const isPolicy = isIamPolicyFile(filename, patchOrContent);

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
    rawFindings.push(...checkK8sClusterAdminOrWildcardRbac(lines, filename));
    rawFindings.push(...checkLatestImageTag(lines, filename, "k8s"));
  }

  if (isTf) {
    rawFindings.push(...checkTerraformOpenIngress(lines, filename));
    rawFindings.push(...checkTerraformPublicS3Acl(lines, filename));
    rawFindings.push(...checkTerraformUnencryptedStorage(lines, filename));
    rawFindings.push(...checkTerraformIamWildcardPolicy(lines, filename));
    rawFindings.push(...checkIamPrivilegeEscalation(lines, filename));
  }

  if (isCf || isPolicy) {
    rawFindings.push(...checkIamPrivilegeEscalation(lines, filename));
  }

  // Deduplicate findings if TF_IAM_WILDCARD_POLICY and IAM_WILDCARD_FULL_ADMIN trigger on same line
  const filteredRawFindings = rawFindings.filter((f) => {
    if (f.ruleId === IAC_RULE_IDS.TF_IAM_WILDCARD_POLICY) {
      const hasFullAdmin = rawFindings.some(
        (other) =>
          other.ruleId === IAC_RULE_IDS.IAM_WILDCARD_FULL_ADMIN &&
          other.fileLocation === f.fileLocation &&
          Math.abs(other.lineStart - f.lineStart) <= 3,
      );
      if (hasFullAdmin) return false;
    }
    return true;
  });

  // Filter out disabled rules
  const disabledSet = new Set((options.disabledRules || []).map((r) => r.trim().toUpperCase()));
  const activeFindings =
    disabledSet.size > 0
      ? filteredRawFindings.filter((f) => !disabledSet.has(f.ruleId.toUpperCase()))
      : filteredRawFindings;

  // Filter out documented exceptions per repository (#2160)
  const unexemptFindings =
    options.exceptions && options.exceptions.length > 0
      ? activeFindings.filter((f) => !isIacFindingExempt(f, options.exceptions))
      : activeFindings;

  const repositoryId = options.repositoryId || "default-repo";

  return unexemptFindings.map((finding) => {
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
