import type { Severity } from "@/lib/severity";

export interface BuiltInPolicyDefinition {
  id: string;
  slug: string;
  name: string;
  description: string;
  severity: Severity;
  action: string;
  isDefault: boolean;
  rules: {
    conditions: string[];
  };
  helpUrl: string;
  guidance: string;
}

export const GITHUB_DOCS_BASE_URL =
  "https://github.com/GauravKarakoti/SecureFlow/blob/main/docs/policies";

/**
 * All 24 built-in security policies provided by SecureFlow out of the box.
 * Each built-in policy has an associated documentation guidance page in `docs/policies/`
 * and short actionable guidance text explaining how developers can fix violations (#2098).
 */
export const BUILT_IN_POLICIES: readonly BuiltInPolicyDefinition[] = [
  // --- 1. Data Base & SQL ---
  {
    id: "enforce-parameterized-queries",
    slug: "enforce-parameterized-queries.md",
    name: "Enforce Parameterized Queries",
    description:
      "Requires manual review for raw SQL queries to prevent SQL Injection vulnerabilities.",
    severity: "HIGH",
    action: "REVIEW REQUIRED",
    isDefault: true,
    rules: { conditions: ["db/raw_query/*", "sql/raw_query", "code/sql/injection"] },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/enforce-parameterized-queries.md`,
    guidance:
      "Use parameterized queries, prepared statements, or ORM query builders instead of concatenating raw SQL strings.",
  },

  // --- 2. Data Privacy & Compliance (PII) ---
  {
    id: "prevent-pii-logging",
    slug: "prevent-pii-logging.md",
    name: "Prevent PII Logging",
    description:
      "Strictly blocks logging statements that output potentially sensitive Personal Identifiable Information (PII) such as emails, SSNs, or credit cards to stdout or files.",
    severity: "CRITICAL",
    action: "DENY",
    isDefault: false,
    rules: { conditions: ["logging/pii/*", "code/print/sensitive_data_*", "pii/leak"] },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/prevent-pii-logging.md`,
    guidance:
      "Mask, hash, or redact personally identifiable information (PII) before logging to stdout or disk.",
  },

  // --- 3. API & Web Security ---
  {
    id: "block-internal-network-requests-ssrf",
    slug: "block-internal-network-requests-ssrf.md",
    name: "Block Internal Network Requests (SSRF)",
    description:
      "Flags HTTP clients making requests to internal IP ranges or cloud metadata services to prevent Server-Side Request Forgery.",
    severity: "HIGH",
    action: "REVIEW REQUIRED",
    isDefault: false,
    rules: { conditions: ["network/request/internal_ip", "network/request/metadata_service", "network/ssrf"] },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/block-internal-network-requests-ssrf.md`,
    guidance:
      "Validate user-supplied URLs against an allowlist and block private IP ranges (RFC 1918) and cloud metadata addresses (169.254.169.254).",
  },
  {
    id: "enforce-strict-cors-policies",
    slug: "enforce-strict-cors-policies.md",
    name: "Enforce Strict CORS Policies",
    description:
      "Flags Cross-Origin Resource Sharing (CORS) configurations that use wildcards ('*') for allowed origins in production environments.",
    severity: "MEDIUM",
    action: "REVIEW REQUIRED",
    isDefault: false,
    rules: { conditions: ["config/cors/wildcard_origin", "config/cors/allow_all", "cors/wildcard"] },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/enforce-strict-cors-policies.md`,
    guidance:
      "Explicitly specify trusted origin domain names instead of wildcard '*' origins, especially on authenticated endpoints.",
  },
  {
    id: "prevent-unsafe-deserialization",
    slug: "prevent-unsafe-deserialization.md",
    name: "Prevent Unsafe Deserialization",
    description:
      "Blocks the use of insecure deserialization functions (e.g., Python pickle, Java ObjectInputStream) that can lead to Remote Code Execution.",
    severity: "CRITICAL",
    action: "DENY",
    isDefault: false,
    rules: {
      conditions: [
        "code/deserialization/unsafe_*",
        "lang/python/pickle",
        "lang/java/object_input_stream",
        "deserialization/unsafe",
      ],
    },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/prevent-unsafe-deserialization.md`,
    guidance:
      "Use safe structured formats like JSON or Protocol Buffers instead of binary object deserializers like pickle or Java ObjectInputStream.",
  },

  // --- 4. Cryptography ---
  {
    id: "deprecate-weak-hashing-algorithms",
    slug: "deprecate-weak-hashing-algorithms.md",
    name: "Deprecate Weak Hashing Algorithms",
    description:
      "Flags the usage of MD5, SHA1, or other deprecated cryptographic algorithms for password hashing or data integrity checks.",
    severity: "HIGH",
    action: "REVIEW REQUIRED",
    isDefault: false,
    rules: { conditions: ["crypto/hash/md5", "crypto/hash/sha1", "crypto/cipher/des", "crypto/weak_hash"] },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/deprecate-weak-hashing-algorithms.md`,
    guidance:
      "Migrate from MD5 and SHA-1 to SHA-256/SHA-512 for integrity checksums, and use Argon2id or bcrypt for password hashing.",
  },

  // --- 5. Infrastructure as Code (IaC) & DevOps ---
  {
    id: "deny-public-cloud-storage",
    slug: "deny-public-cloud-storage.md",
    name: "Deny Public Cloud Storage",
    description:
      "Blocks Infrastructure as Code (Terraform/CloudFormation) changes that attempt to create publicly readable or writable S3/GCS buckets.",
    severity: "CRITICAL",
    action: "DENY",
    isDefault: false,
    rules: { conditions: ["iac/aws/s3/public_read", "iac/gcp/storage/allUsers", "iac/storage/public"] },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/deny-public-cloud-storage.md`,
    guidance:
      "Enable public access blocks (e.g., aws_s3_bucket_public_access_block) and set bucket ACLs to private.",
  },
  {
    id: "prevent-root-execution-in-containers",
    slug: "prevent-root-execution-in-containers.md",
    name: "Prevent Root Execution in Containers",
    description:
      "Flags Dockerfiles or Kubernetes manifests that execute containers as the root user instead of enforcing a least-privileged user.",
    severity: "MEDIUM",
    action: "REVIEW REQUIRED",
    isDefault: false,
    rules: { conditions: ["docker/user/root", "k8s/security_context/run_as_root", "container/root_user"] },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/prevent-root-execution-in-containers.md`,
    guidance:
      "Define a non-root USER directive in Dockerfile and enforce runAsNonRoot: true in Kubernetes security contexts.",
  },

  // --- 6. Web3 & Smart Contracts ---
  {
    id: "enforce-smart-contract-reentrancy-guards",
    slug: "enforce-smart-contract-reentrancy-guards.md",
    name: "Enforce Smart Contract Reentrancy Guards",
    description:
      "Requires manual review for Solidity state changes occurring after external contract calls to prevent reentrancy attacks (SWC-107). Enforces the Checks-Effects-Interactions pattern.",
    severity: "CRITICAL",
    action: "REVIEW REQUIRED",
    isDefault: false,
    rules: {
      conditions: [
        "web3/solidity/reentrancy_pattern",
        "web3/external_call_before_state_change",
        "web3/solidity/missing_reentrancy_guard",
      ],
    },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/enforce-smart-contract-reentrancy-guards.md`,
    guidance:
      "Follow the Checks-Effects-Interactions pattern and add OpenZeppelin ReentrancyGuard nonReentrant modifier to external-facing functions.",
  },
  {
    id: "block-tx-origin-authentication-in-solidity",
    slug: "block-tx-origin-authentication-in-solidity.md",
    name: "Block tx.origin Authentication in Solidity",
    description:
      "Blocks Solidity contracts that use tx.origin for authentication instead of msg.sender, which allows phishing contracts to bypass access controls (SWC-115).",
    severity: "HIGH",
    action: "DENY",
    isDefault: false,
    rules: {
      conditions: ["web3/solidity/tx_origin_auth", "web3/solidity/tx_origin_access_control"],
    },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/block-tx-origin-authentication-in-solidity.md`,
    guidance:
      "Authenticate caller identity with msg.sender rather than tx.origin to prevent phishing contract delegatecall attacks.",
  },
  {
    id: "flag-unchecked-arithmetic-in-smart-contracts",
    slug: "flag-unchecked-arithmetic-in-smart-contracts.md",
    name: "Flag Unchecked Arithmetic in Smart Contracts",
    description:
      "Flags Solidity unchecked{} blocks and Rust arithmetic operations that bypass overflow protection, which can lead to integer overflow/underflow vulnerabilities.",
    severity: "HIGH",
    action: "REVIEW REQUIRED",
    isDefault: false,
    rules: {
      conditions: [
        "web3/solidity/unchecked_arithmetic",
        "web3/rust/unchecked_add_sub_mul",
        "web3/solidity/integer_overflow",
      ],
    },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/flag-unchecked-arithmetic-in-smart-contracts.md`,
    guidance:
      "Rely on compiler-checked arithmetic or explicitly validate bounds with require() before performing operations in unchecked {} blocks.",
  },
  {
    id: "enforce-soroban-solana-cpi-signer-verification",
    slug: "enforce-soroban-solana-cpi-signer-verification.md",
    name: "Enforce Soroban/Solana CPI Signer Verification",
    description:
      "Flags Rust smart contract Cross-Program Invocations (CPI) that do not verify signer seeds or account ownership, allowing unauthorized program invocations on Soroban and Solana.",
    severity: "CRITICAL",
    action: "REVIEW REQUIRED",
    isDefault: false,
    rules: {
      conditions: [
        "web3/rust/cpi_missing_signer_check",
        "web3/solana/account_owner_not_validated",
        "web3/soroban/missing_auth_check",
      ],
    },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/enforce-soroban-solana-cpi-signer-verification.md`,
    guidance:
      "Verify program IDs, signer authorization, and account owners before invoking cross-program instructions (CPI).",
  },
  {
    id: "flag-under-constrained-zk-circuit-signals",
    slug: "flag-under-constrained-zk-circuit-signals.md",
    name: "Flag Under-Constrained ZK Circuit Signals",
    description:
      "Flags Circom and Aleo Leo circuits where output signals are not fully constrained by the circuit constraints, creating soundness bugs that allow a malicious prover to generate valid proofs for invalid witnesses.",
    severity: "CRITICAL",
    action: "DENY",
    isDefault: false,
    rules: {
      conditions: [
        "web3/zk/underconstrained_signal",
        "web3/circom/missing_constraint",
        "web3/aleo/unconstrained_output",
        "web3/zk/soundness_bug",
      ],
    },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/flag-under-constrained-zk-circuit-signals.md`,
    guidance:
      "Use <== constrained assignments in Circom or enforce explicit constraints on all intermediate and output signals.",
  },
  {
    id: "require-range-checks-on-zk-circuit-field-elements",
    slug: "require-range-checks-on-zk-circuit-field-elements.md",
    name: "Require Range Checks on ZK Circuit Field Elements",
    description:
      "Flags ZK circuits (Circom, Aleo Leo) that use field elements as binary or bounded values without explicit range constraints, which can allow a prover to use out-of-range witnesses that satisfy the circuit but violate the intended semantics.",
    severity: "HIGH",
    action: "REVIEW REQUIRED",
    isDefault: false,
    rules: {
      conditions: [
        "web3/zk/missing_range_check",
        "web3/circom/binary_signal_not_constrained",
        "web3/aleo/field_element_range",
      ],
    },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/require-range-checks-on-zk-circuit-field-elements.md`,
    guidance:
      "Enforce explicit range bounds on numerical inputs using bit decomposition templates such as Num2Bits.",
  },

  // --- 7. Credential Management ---
  {
    id: "flag-long-lived-or-non-expiring-access-tokens",
    slug: "flag-long-lived-or-non-expiring-access-tokens.md",
    name: "Flag Long-Lived or Non-Expiring Access Tokens",
    description:
      "Flags API tokens, session keys, or service credentials issued without an expiry, or with an unusually long lifetime, increasing the blast radius of a leak.",
    severity: "MEDIUM",
    action: "REVIEW REQUIRED",
    isDefault: false,
    rules: { conditions: ["auth/token/no_expiry", "auth/token/long_lived", "token/no_expiry"] },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/flag-long-lived-or-non-expiring-access-tokens.md`,
    guidance:
      "Configure explicit expiration lifetimes (e.g. 15–60 minutes) for access tokens and support rotation via refresh tokens.",
  },

  // --- 8. Authentication & Access Control ---
  {
    id: "require-mfa-for-privileged-accounts",
    slug: "require-mfa-for-privileged-accounts.md",
    name: "Require MFA for Privileged Accounts",
    description:
      "Flags administrator or owner-level accounts that do not have multi-factor authentication enforced.",
    severity: "HIGH",
    action: "REVIEW REQUIRED",
    isDefault: false,
    rules: { conditions: ["auth/mfa/not_enforced", "auth/admin/no_mfa", "mfa/required"] },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/require-mfa-for-privileged-accounts.md`,
    guidance:
      "Enforce mandatory multi-factor authentication (TOTP or WebAuthn/FIDO2) for all administrator and elevated accounts.",
  },
  {
    id: "flag-missing-authorization-checks-on-admin-routes",
    slug: "flag-missing-authorization-checks-on-admin-routes.md",
    name: "Flag Missing Authorization Checks on Admin Routes",
    description:
      "Blocks API routes or server actions under an admin/privileged namespace that lack an explicit role or permission check before executing.",
    severity: "CRITICAL",
    action: "DENY",
    isDefault: false,
    rules: { conditions: ["api/route/admin_no_authz", "api/route/missing_role_check", "authz/missing_check"] },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/flag-missing-authorization-checks-on-admin-routes.md`,
    guidance:
      "Perform permission checks (e.g., can(session.user, null, 'admin')) before invoking privileged handlers or mutating database records.",
  },
  {
    id: "enforce-least-privilege-iam-policies",
    slug: "enforce-least-privilege-iam-policies.md",
    name: "Enforce Least-Privilege IAM Policies",
    description:
      "Flags Infrastructure as Code changes that grant wildcard ('*') actions or resources in IAM policy documents instead of scoping to specific permissions.",
    severity: "HIGH",
    action: "REVIEW REQUIRED",
    isDefault: false,
    rules: { conditions: ["iac/aws/iam/wildcard_action", "iac/aws/iam/wildcard_resource", "iam/wildcard"] },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/enforce-least-privilege-iam-policies.md`,
    guidance:
      "Replace wildcard '*' actions and resources with explicit IAM permissions and specific resource ARNs.",
  },

  // --- 9. Software Supply Chain & Dependencies ---
  {
    id: "flag-known-vulnerable-dependencies",
    slug: "flag-known-vulnerable-dependencies.md",
    name: "Flag Known-Vulnerable Dependencies",
    description:
      "Flags dependency changes that introduce a package version with a known high or critical severity CVE.",
    severity: "HIGH",
    action: "REVIEW REQUIRED",
    isDefault: false,
    rules: { conditions: ["deps/vulnerability/known_cve", "deps/audit/high_severity", "deps/vulnerable"] },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/flag-known-vulnerable-dependencies.md`,
    guidance:
      "Upgrade vulnerable dependencies to a patched release version with no known CVE advisories.",
  },
  {
    id: "block-unpinned-docker-base-images",
    slug: "block-unpinned-docker-base-images.md",
    name: "Block Unpinned Docker Base Images",
    description:
      "Flags Dockerfiles that reference a base image via a mutable tag (e.g. 'latest') instead of a pinned version or content digest, which can silently change build contents.",
    severity: "MEDIUM",
    action: "REVIEW REQUIRED",
    isDefault: false,
    rules: { conditions: ["docker/image/tag_latest", "docker/image/unpinned_digest", "docker/unpinned"] },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/block-unpinned-docker-base-images.md`,
    guidance:
      "Pin Docker base images to explicit version tags and sha256 digests (e.g. node:20.12.0-alpine@sha256:...) to ensure reproducible builds.",
  },

  // --- 10. Client-Side & Frontend Security ---
  {
    id: "prevent-unsafe-dom-injection-xss",
    slug: "prevent-unsafe-dom-injection-xss.md",
    name: "Prevent Unsafe DOM Injection (XSS)",
    description:
      "Blocks use of dangerouslySetInnerHTML, document.write, or eval() with untrusted input, which can lead to cross-site scripting.",
    severity: "CRITICAL",
    action: "DENY",
    isDefault: false,
    rules: {
      conditions: [
        "frontend/dom/dangerously_set_inner_html",
        "frontend/dom/eval_usage",
        "frontend/dom/document_write",
        "xss/inner_html",
      ],
    },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/prevent-unsafe-dom-injection-xss.md`,
    guidance:
      "Sanitize untrusted HTML with DOMPurify before rendering, or prefer React/JSX text nodes which are automatically escaped.",
  },
  {
    id: "enforce-content-security-policy-headers",
    slug: "enforce-content-security-policy-headers.md",
    name: "Enforce Content Security Policy Headers",
    description:
      "Flags HTTP responses that are missing a Content-Security-Policy header, or that set one with 'unsafe-inline'/'unsafe-eval', weakening XSS protections.",
    severity: "MEDIUM",
    action: "REVIEW REQUIRED",
    isDefault: false,
    rules: { conditions: ["http/headers/missing_csp", "http/headers/csp_unsafe_inline", "csp/missing"] },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/enforce-content-security-policy-headers.md`,
    guidance:
      "Set a strict Content-Security-Policy header without 'unsafe-inline' or 'unsafe-eval', using cryptographically secure nonces for inline scripts.",
  },

  // --- 11. Network & Transport Security ---
  {
    id: "block-plaintext-http-endpoints",
    slug: "block-plaintext-http-endpoints.md",
    name: "Block Plaintext HTTP Endpoints",
    description:
      "Flags outbound requests or configured endpoints using plain HTTP instead of HTTPS/TLS, exposing data in transit to interception.",
    severity: "HIGH",
    action: "REVIEW REQUIRED",
    isDefault: false,
    rules: { conditions: ["network/protocol/http_no_tls", "config/endpoint/insecure_scheme", "http/no_tls"] },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/block-plaintext-http-endpoints.md`,
    guidance:
      "Use encrypted https:// protocols and TLS 1.3 for all outbound API communication, webhooks, and service endpoints.",
  },

  // --- 12. Audit & Compliance Logging ---
  {
    id: "require-audit-logging-for-privileged-actions",
    slug: "require-audit-logging-for-privileged-actions.md",
    name: "Require Audit Logging for Privileged Actions",
    description:
      "Flags privileged operations (role changes, deletions, policy toggles) that complete without emitting an audit log entry tied to the acting user.",
    severity: "MEDIUM",
    action: "REVIEW REQUIRED",
    isDefault: false,
    rules: { conditions: ["audit/log/missing_privileged_action", "audit/log/no_actor_trace", "audit/missing"] },
    helpUrl: `${GITHUB_DOCS_BASE_URL}/require-audit-logging-for-privileged-actions.md`,
    guidance:
      "Emit an immutable audit log record containing acting user ID, timestamp, target resource, and mutated state for administrative actions.",
  },
] as const;

/**
 * Validates that custom policy help URLs strictly use https protocol.
 * Returns true if valid, or false if invalid/non-https.
 */
export function isValidCustomPolicyUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (trimmed.length === 0) return true; // optional/empty is allowed
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validates a custom policy URL and throws or returns an error message if invalid.
 */
export function validateCustomPolicyUrl(url: unknown): { valid: boolean; error?: string } {
  if (url === undefined || url === null || url === "") {
    return { valid: true };
  }
  if (typeof url !== "string") {
    return { valid: false, error: "Policy helpUrl must be a string." };
  }
  const trimmed = url.trim();
  if (!trimmed.startsWith("https://")) {
    return { valid: false, error: "Custom policy helpUrl must use https:// protocol." };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") {
      return { valid: false, error: "Custom policy helpUrl must use https:// protocol." };
    }
  } catch {
    return { valid: false, error: "Custom policy helpUrl is not a valid URL." };
  }
  return { valid: true };
}

/**
 * Lookup table mapping normalized policy names and conditions to built-in policies.
 */
const POLICY_LOOKUP_MAP = new Map<string, BuiltInPolicyDefinition>();

for (const policy of BUILT_IN_POLICIES) {
  POLICY_LOOKUP_MAP.set(policy.name.toLowerCase().trim(), policy);
  POLICY_LOOKUP_MAP.set(policy.id.toLowerCase().trim(), policy);
  for (const condition of policy.rules.conditions) {
    POLICY_LOOKUP_MAP.set(condition.toLowerCase().trim(), policy);
  }
}

/**
 * Retrieve a built-in policy by name, ID, or condition key.
 */
export function getBuiltInPolicy(key: string): BuiltInPolicyDefinition | undefined {
  if (!key) return undefined;
  return POLICY_LOOKUP_MAP.get(key.toLowerCase().trim());
}

/**
 * Resolves the appropriate helpUrl and guidance text for a finding or policy reference.
 */
export function resolvePolicyGuidance(findingOrPolicy: {
  policyName?: string | null;
  ruleId?: string | null;
  type?: string | null;
  name?: string | null;
  helpUrl?: string | null;
  guidance?: string | null;
}): { helpUrl?: string; guidance?: string; policyName?: string } {
  // 1. Direct properties specified on the finding/custom policy take priority
  if (findingOrPolicy.helpUrl) {
    return {
      helpUrl: findingOrPolicy.helpUrl,
      guidance: findingOrPolicy.guidance || undefined,
      policyName: findingOrPolicy.policyName || findingOrPolicy.name || undefined,
    };
  }

  // 2. Check candidate keys against the built-in policy catalog
  const candidates = [
    findingOrPolicy.policyName,
    findingOrPolicy.name,
    findingOrPolicy.ruleId,
    findingOrPolicy.type,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const match = getBuiltInPolicy(candidate);
    if (match) {
      return {
        helpUrl: match.helpUrl,
        guidance: findingOrPolicy.guidance || match.guidance,
        policyName: match.name,
      };
    }
  }

  // 3. Fallback: fuzzy search based on finding type / keyword
  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase();
    for (const policy of BUILT_IN_POLICIES) {
      if (
        normalized.includes("sql") && policy.id === "enforce-parameterized-queries" ||
        normalized.includes("pii") && policy.id === "prevent-pii-logging" ||
        normalized.includes("ssrf") && policy.id === "block-internal-network-requests-ssrf" ||
        normalized.includes("cors") && policy.id === "enforce-strict-cors-policies" ||
        normalized.includes("deserializ") && policy.id === "prevent-unsafe-deserialization" ||
        (normalized.includes("md5") || normalized.includes("sha1") || normalized.includes("hash")) && policy.id === "deprecate-weak-hashing-algorithms" ||
        (normalized.includes("s3") || normalized.includes("storage")) && policy.id === "deny-public-cloud-storage" ||
        (normalized.includes("root") || normalized.includes("docker")) && policy.id === "prevent-root-execution-in-containers" ||
        normalized.includes("reentrancy") && policy.id === "enforce-smart-contract-reentrancy-guards" ||
        normalized.includes("tx.origin") && policy.id === "block-tx-origin-authentication-in-solidity" ||
        normalized.includes("arithmetic") && policy.id === "flag-unchecked-arithmetic-in-smart-contracts" ||
        (normalized.includes("solana") || normalized.includes("cpi")) && policy.id === "enforce-soroban-solana-cpi-signer-verification" ||
        normalized.includes("underconstrained") && policy.id === "flag-under-constrained-zk-circuit-signals" ||
        normalized.includes("range_check") && policy.id === "require-range-checks-on-zk-circuit-field-elements" ||
        normalized.includes("token") && policy.id === "flag-long-lived-or-non-expiring-access-tokens" ||
        normalized.includes("mfa") && policy.id === "require-mfa-for-privileged-accounts" ||
        (normalized.includes("admin") || normalized.includes("authz")) && policy.id === "flag-missing-authorization-checks-on-admin-routes" ||
        normalized.includes("iam") && policy.id === "enforce-least-privilege-iam-policies" ||
        normalized.includes("cve") && policy.id === "flag-known-vulnerable-dependencies" ||
        (normalized.includes("docker") || normalized.includes("image")) && policy.id === "block-unpinned-docker-base-images" ||
        (normalized.includes("xss") || normalized.includes("dangerouslysetinnerhtml")) && policy.id === "prevent-unsafe-dom-injection-xss" ||
        normalized.includes("csp") && policy.id === "enforce-content-security-policy-headers" ||
        (normalized.includes("http_") || normalized.includes("tls")) && policy.id === "block-plaintext-http-endpoints" ||
        normalized.includes("audit") && policy.id === "require-audit-logging-for-privileged-actions"
      ) {
        return {
          helpUrl: policy.helpUrl,
          guidance: policy.guidance,
          policyName: policy.name,
        };
      }
    }
  }

  return {
    guidance: findingOrPolicy.guidance || undefined,
  };
}
