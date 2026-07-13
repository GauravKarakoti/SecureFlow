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