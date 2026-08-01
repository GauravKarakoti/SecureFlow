import prisma from "../src/lib/prisma";

async function main() {
  console.log("Starting production database seed...");

  // 1. Create Roles
  const adminRole = await prisma.role.upsert({
    where: { name: "ADMIN" },
    update: {},
    create: { name: "ADMIN", description: "Full administrative access" },
  });

  const userRole = await prisma.role.upsert({
    where: { name: "USER" },
    update: {},
    create: { name: "USER", description: "Standard user access" },
  });

  console.log("Created Roles:", { adminRole, userRole });

  // 2. Policy Templates
  console.log("Seeding Policy Templates...");
  await prisma.policyTemplate.createMany({
    skipDuplicates: true,
    data: [
      // --- 1. Data Base & SQL ---
      {
        name: "Enforce Parameterized Queries",
        description: "Requires manual review for raw SQL queries to prevent SQL Injection vulnerabilities.",
        severity: "HIGH",
        action: "REVIEW REQUIRED",
        isDefault: true,
        rules: { conditions: ["db/raw_query/*"] }
      },
      
      // --- 2. Data Privacy & Compliance (PII) ---
      {
        name: "Prevent PII Logging",
        description: "Strictly blocks logging statements that output potentially sensitive Personal Identifiable Information (PII) such as emails, SSNs, or credit cards to stdout or files.",
        severity: "CRITICAL",
        action: "DENY",
        isDefault: false,
        rules: { conditions: ["logging/pii/*", "code/print/sensitive_data_*"] }
      },

      // --- 3. API & Web Security ---
      {
        name: "Block Internal Network Requests (SSRF)",
        description: "Flags HTTP clients making requests to internal IP ranges or cloud metadata services to prevent Server-Side Request Forgery.",
        severity: "HIGH",
        action: "REVIEW REQUIRED",
        isDefault: false,
        rules: { conditions: ["network/request/internal_ip", "network/request/metadata_service"] }
      },
      {
        name: "Enforce Strict CORS Policies",
        description: "Flags Cross-Origin Resource Sharing (CORS) configurations that use wildcards ('*') for allowed origins in production environments.",
        severity: "MEDIUM",
        action: "REVIEW REQUIRED",
        isDefault: false,
        rules: { conditions: ["config/cors/wildcard_origin", "config/cors/allow_all"] }
      },
      {
        name: "Prevent Unsafe Deserialization",
        description: "Blocks the use of insecure deserialization functions (e.g., Python pickle, Java ObjectInputStream) that can lead to Remote Code Execution.",
        severity: "CRITICAL",
        action: "DENY",
        isDefault: false,
        rules: { conditions: ["code/deserialization/unsafe_*", "lang/python/pickle", "lang/java/object_input_stream"] }
      },

      // --- 4. Cryptography ---
      {
        name: "Deprecate Weak Hashing Algorithms",
        description: "Flags the usage of MD5, SHA1, or other deprecated cryptographic algorithms for password hashing or data integrity checks.",
        severity: "HIGH",
        action: "REVIEW REQUIRED",
        isDefault: false, // Opt-in for legacy systems transitioning out
        rules: { conditions: ["crypto/hash/md5", "crypto/hash/sha1", "crypto/cipher/des"] }
      },

      // --- 5. Infrastructure as Code (IaC) & DevOps ---
      {
        name: "Deny Public Cloud Storage",
        description: "Blocks Infrastructure as Code (Terraform/CloudFormation) changes that attempt to create publicly readable or writable S3/GCS buckets.",
        severity: "CRITICAL",
        action: "DENY",
        isDefault: false,
        rules: { conditions: ["iac/aws/s3/public_read", "iac/gcp/storage/allUsers"] }
      },
      {
        name: "Prevent Root Execution in Containers",
        description: "Flags Dockerfiles or Kubernetes manifests that execute containers as the root user instead of enforcing a least-privileged user.",
        severity: "MEDIUM",
        action: "REVIEW REQUIRED",
        isDefault: false,
        rules: { conditions: ["docker/user/root", "k8s/security_context/run_as_root"] }
      },

      // --- 6. Web3 & Smart Contracts (Optional Context) ---
      {
        name: "Enforce Smart Contract Reentrancy Guards",
        description: "Requires manual review for Solidity state changes occurring after external contract calls to prevent reentrancy attacks.",
        severity: "CRITICAL",
        action: "REVIEW REQUIRED",
        isDefault: false,
        rules: { conditions: ["web3/solidity/reentrancy_pattern", "web3/external_call_before_state_change"] }
      },

      // --- 7. Credential Management ---
      {
        name: "Flag Long-Lived or Non-Expiring Access Tokens",
        description: "Flags API tokens, session keys, or service credentials issued without an expiry, or with an unusually long lifetime, increasing the blast radius of a leak.",
        severity: "MEDIUM",
        action: "REVIEW REQUIRED",
        isDefault: false,
        rules: { conditions: ["auth/token/no_expiry", "auth/token/long_lived"] }
      },

      // --- 8. Authentication & Access Control ---
      {
        name: "Require MFA for Privileged Accounts",
        description: "Flags administrator or owner-level accounts that do not have multi-factor authentication enforced.",
        severity: "HIGH",
        action: "REVIEW REQUIRED",
        isDefault: false,
        rules: { conditions: ["auth/mfa/not_enforced", "auth/admin/no_mfa"] }
      },
      {
        name: "Flag Missing Authorization Checks on Admin Routes",
        description: "Blocks API routes or server actions under an admin/privileged namespace that lack an explicit role or permission check before executing.",
        severity: "CRITICAL",
        action: "DENY",
        isDefault: false,
        rules: { conditions: ["api/route/admin_no_authz", "api/route/missing_role_check"] }
      },
      {
        name: "Enforce Least-Privilege IAM Policies",
        description: "Flags Infrastructure as Code changes that grant wildcard ('*') actions or resources in IAM policy documents instead of scoping to specific permissions.",
        severity: "HIGH",
        action: "REVIEW REQUIRED",
        isDefault: false,
        rules: { conditions: ["iac/aws/iam/wildcard_action", "iac/aws/iam/wildcard_resource"] }
      },

      // --- 9. Software Supply Chain & Dependencies ---
      {
        name: "Flag Known-Vulnerable Dependencies",
        description: "Flags dependency changes that introduce a package version with a known high or critical severity CVE.",
        severity: "HIGH",
        action: "REVIEW REQUIRED",
        isDefault: false,
        rules: { conditions: ["deps/vulnerability/known_cve", "deps/audit/high_severity"] }
      },
      {
        name: "Block Unpinned Docker Base Images",
        description: "Flags Dockerfiles that reference a base image via a mutable tag (e.g. 'latest') instead of a pinned version or content digest, which can silently change build contents.",
        severity: "MEDIUM",
        action: "REVIEW REQUIRED",
        isDefault: false,
        rules: { conditions: ["docker/image/tag_latest", "docker/image/unpinned_digest"] }
      },

      // --- 10. Client-Side & Frontend Security ---
      {
        name: "Prevent Unsafe DOM Injection (XSS)",
        description: "Blocks use of dangerouslySetInnerHTML, document.write, or eval() with untrusted input, which can lead to cross-site scripting.",
        severity: "CRITICAL",
        action: "DENY",
        isDefault: false,
        rules: { conditions: ["frontend/dom/dangerously_set_inner_html", "frontend/dom/eval_usage", "frontend/dom/document_write"] }
      },
      {
        name: "Enforce Content Security Policy Headers",
        description: "Flags HTTP responses that are missing a Content-Security-Policy header, or that set one with 'unsafe-inline'/'unsafe-eval', weakening XSS protections.",
        severity: "MEDIUM",
        action: "REVIEW REQUIRED",
        isDefault: false,
        rules: { conditions: ["http/headers/missing_csp", "http/headers/csp_unsafe_inline"] }
      },

      // --- 11. Network & Transport Security ---
      {
        name: "Block Plaintext HTTP Endpoints",
        description: "Flags outbound requests or configured endpoints using plain HTTP instead of HTTPS/TLS, exposing data in transit to interception.",
        severity: "HIGH",
        action: "REVIEW REQUIRED",
        isDefault: false,
        rules: { conditions: ["network/protocol/http_no_tls", "config/endpoint/insecure_scheme"] }
      },

      // --- 12. Audit & Compliance Logging ---
      {
        name: "Require Audit Logging for Privileged Actions",
        description: "Flags privileged operations (role changes, deletions, policy toggles) that complete without emitting an audit log entry tied to the acting user.",
        severity: "MEDIUM",
        action: "REVIEW REQUIRED",
        isDefault: false,
        rules: { conditions: ["audit/log/missing_privileged_action", "audit/log/no_actor_trace"] }
      }
    ]
  });

  console.log("Successfully seeded advanced policy templates!");
  console.log("Seeding finished.");
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });