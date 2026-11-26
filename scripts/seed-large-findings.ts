import prisma from "../src/lib/prisma";
import crypto from "crypto";

/**
 * Benchmark Seed Script: Generates a large dataset of findings (5,000 records)
 * for testing server-side pagination, sorting, and filtering under heavy loads.
 */
export async function seedLargeFindings(totalCount = 5000) {
  console.log(`🚀 Starting large sample dataset seed (${totalCount.toLocaleString()} findings)...`);
  const startTime = Date.now();

  // 1. Get or create benchmark test user
  let user = await prisma.user.findFirst({
    where: { email: "perf-test@secureflow.dev" },
  });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: "perf-test@secureflow.dev",
        name: "Performance Benchmark User",
        codename: "PerfTester",
      },
    });
  }

  // 2. Get or create benchmark repository
  let repo = await prisma.repository.findFirst({
    where: { fullName: "secureflow-benchmark/large-mono-repo", userId: user.id },
  });
  if (!repo) {
    repo = await prisma.repository.create({
      data: {
        githubId: BigInt(99990001),
        fullName: "secureflow-benchmark/large-mono-repo",
        owner: "secureflow-benchmark",
        userId: user.id,
      },
    });
  }

  // 3. Get or create pull request
  let pr = await prisma.pullRequest.findFirst({
    where: { repositoryId: repo.id, prNumber: 101 },
  });
  if (!pr) {
    pr = await prisma.pullRequest.create({
      data: {
        githubId: BigInt(99990002),
        prNumber: 101,
        title: "Large Benchmark PR (#101)",
        repositoryId: repo.id,
      },
    });
  }

  // 4. Get or create scan result
  let scan = await prisma.scanResult.findFirst({
    where: { pullRequestId: pr.id },
  });
  if (!scan) {
    scan = await prisma.scanResult.create({
      data: {
        pullRequestId: pr.id,
        riskScore: 92,
        policyDecision: "BLOCK",
      },
    });
  }

  const severities = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;
  const types = ["SECRET", "VULNERABILITY", "MISCONFIG"] as const;
  const sampleFiles = [
    "src/auth/jwt-authenticator.ts",
    "src/lib/database/connection-pool.ts",
    "src/server/api/v1/billing.ts",
    "src/services/payment-gateway.ts",
    "src/crypto/encryption-vault.ts",
    "infra/terraform/aws-s3-buckets.tf",
    "infra/k8s/production-ingress.yaml",
    "docker/Dockerfile.production",
    "src/routes/admin/users.ts",
    "src/utils/sanitizer.ts",
  ];

  const batchSize = 1000;
  const totalBatches = Math.ceil(totalCount / batchSize);

  for (let b = 0; b < totalBatches; b++) {
    const currentBatchSize = Math.min(batchSize, totalCount - b * batchSize);
    const data = [];

    for (let i = 0; i < currentBatchSize; i++) {
      const idx = b * batchSize + i;
      const severity = severities[idx % severities.length]!;
      const type = types[idx % types.length]!;
      const fileLocation = sampleFiles[idx % sampleFiles.length]!;
      const lineStart = 1 + (idx % 250);
      const lineEnd = lineStart + (idx % 3);

      const snippet =
        type === "SECRET"
          ? `const apiKey_${idx} = "sk_live_${crypto.randomBytes(16).toString("hex")}";`
          : type === "VULNERABILITY"
            ? `const query = "SELECT * FROM users WHERE token = '" + rawToken_${idx} + "';";`
            : `allowed_origins = ["*"] // Insecure wildcard CORS policy #${idx}`;

      const fingerprint = crypto
        .createHash("sha256")
        .update(`seed:${repo.id}:${fileLocation}:${idx}:${severity}`)
        .digest("hex");

      const createdDaysAgo = idx % 90;
      const createdAt = new Date(Date.now() - createdDaysAgo * 86400000 - (idx % 86400000));

      data.push({
        scanResultId: scan.id,
        type,
        severity,
        fileLocation,
        lineStart,
        lineEnd,
        codeSnippet: snippet,
        explanation: `Automated vulnerability classification for benchmark finding #${idx + 1} (${severity} ${type}).`,
        remediation: `Use parameterized statements, secrets manager integration, or strict CORS origins.`,
        fingerprint,
        cwe: type === "SECRET" ? "CWE-798" : type === "VULNERABILITY" ? "CWE-89" : "CWE-16",
        isBaseline: idx % 4 === 0,
        createdAt,
      });
    }

    await prisma.finding.createMany({
      data,
      skipDuplicates: true,
    });

    console.log(
      `  ✓ Inserted batch ${b + 1}/${totalBatches} (${Math.min((b + 1) * batchSize, totalCount).toLocaleString()} / ${totalCount.toLocaleString()})`,
    );
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`✨ Successfully generated ${totalCount.toLocaleString()} findings in ${durationSec}s.`);
}

// Allow CLI invocation: npx tsx scripts/seed-large-findings.ts
if (process.argv[1]?.includes("seed-large-findings")) {
  const countArg = process.argv.find((a) => a.startsWith("--count="));
  const rawCount = countArg ? countArg.split("=")[1] : process.env.COUNT;
  const count = rawCount ? parseInt(rawCount, 10) : 5000;

  seedLargeFindings(count)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("❌ Seeding failed:", err);
      process.exit(1);
    });
}
