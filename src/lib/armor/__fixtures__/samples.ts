import type { ScannerPolicy } from "../scanner";
import type { PromptRegressionSample } from "./types";

/**
 * Creates a valid unified diff patch string from a newly added code block.
 */
export function createUnifiedPatch(code: string): string {
  const lines = code.split("\n");
  return `@@ -0,0 +1,${lines.length} @@\n` + lines.map((line) => `+${line}`).join("\n");
}

/**
 * Default scanner policies applied when running prompt regression scans.
 */
export const DEFAULT_PROMPT_REGRESSION_POLICIES: ScannerPolicy[] = [
  {
    description:
      "Detect SQL injection, command injection, path traversal, and input validation vulnerabilities.",
  },
  {
    description:
      "Detect security misconfigurations including wildcard CORS headers and running containers as root user.",
  },
  {
    description:
      "Detect hardcoded secrets, API tokens, and credentials in application source code.",
  },
];

// Synthetic secrets built to avoid secret scanner false alarms during git push.
const SYNTHETIC_AWS_KEY = "AKIA" + "99XM2PLKD93HTRWN";
const SYNTHETIC_AWS_SECRET = "wJal" + "rXUtnFEMI/K7MDENG/bPxRfiCY9KR3X4";
const SYNTHETIC_PEM_PRIVATE_KEY =
  "-----BEGIN RSA " +
  "PRIVATE KEY-----\n" +
  "MIIEowIBAAKCAQEA0Y1+SyntheticDummyPrivateKeyPayloadForRegressionTests==\n" +
  "-----END RSA " +
  "PRIVATE KEY-----";

export const PROMPT_REGRESSION_SAMPLES: PromptRegressionSample[] = [
  // ──────────────── Positive Samples (Vulnerabilities / Secrets / Misconfigs) ────────────────
  {
    id: "hardcoded-secret",
    name: "Hardcoded AWS Access Key and Secret",
    filename: "src/config/aws.ts",
    code: `export const awsConfig = {
  region: "us-east-1",
  accessKeyId: "${SYNTHETIC_AWS_KEY}",
  secretAccessKey: "${SYNTHETIC_AWS_SECRET}",
};`,
    patch: createUnifiedPatch(`export const awsConfig = {
  region: "us-east-1",
  accessKeyId: "${SYNTHETIC_AWS_KEY}",
  secretAccessKey: "${SYNTHETIC_AWS_SECRET}",
};`),
    expected: {
      shouldDetect: true,
      category: "SECRET",
      minSeverity: "CRITICAL",
      descriptionSnippet: "AWS",
    },
    policies: DEFAULT_PROMPT_REGRESSION_POLICIES,
  },
  {
    id: "sql-injection",
    name: "SQL Injection in Raw Query Interpolation",
    filename: "src/api/users.ts",
    code: `export async function getUser(req: Request, db: any) {
  const userId = new URL(req.url).searchParams.get("id");
  const query = \`SELECT * FROM users WHERE id = '\${userId}'\`;
  return db.execute(query);
}`,
    patch: createUnifiedPatch(`export async function getUser(req: Request, db: any) {
  const userId = new URL(req.url).searchParams.get("id");
  const query = \`SELECT * FROM users WHERE id = '\${userId}'\`;
  return db.execute(query);
}`),
    expected: {
      shouldDetect: true,
      category: "VULNERABILITY",
      minSeverity: "HIGH",
      descriptionSnippet: "SQL",
    },
    policies: DEFAULT_PROMPT_REGRESSION_POLICIES,
  },
  {
    id: "wildcard-cors",
    name: "Insecure Wildcard CORS Configuration",
    filename: "src/middleware/cors.ts",
    code: `export function setCorsHeaders(res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
}`,
    patch: createUnifiedPatch(`export function setCorsHeaders(res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
}`),
    expected: {
      shouldDetect: true,
      category: "MISCONFIG",
      minSeverity: "MEDIUM",
      descriptionSnippet: "CORS",
    },
    policies: DEFAULT_PROMPT_REGRESSION_POLICIES,
  },
  {
    id: "root-container",
    name: "Container Process Running as Root User",
    filename: "Dockerfile",
    code: `FROM node:20-alpine
WORKDIR /app
COPY . .
USER root
CMD ["npm", "start"]`,
    patch: createUnifiedPatch(`FROM node:20-alpine
WORKDIR /app
COPY . .
USER root
CMD ["npm", "start"]`),
    expected: {
      shouldDetect: true,
      category: "MISCONFIG",
      minSeverity: "MEDIUM",
      descriptionSnippet: "root",
    },
    policies: DEFAULT_PROMPT_REGRESSION_POLICIES,
  },
  {
    id: "command-injection",
    name: "OS Command Injection via Unsanitized Input",
    filename: "src/utils/ping.ts",
    code: `import { exec } from "child_process";

export function pingHost(host: string) {
  exec(\`ping -c 4 \${host}\`, (err, stdout) => {
    console.log(stdout);
  });
}`,
    patch: createUnifiedPatch(`import { exec } from "child_process";

export function pingHost(host: string) {
  exec(\`ping -c 4 \${host}\`, (err, stdout) => {
    console.log(stdout);
  });
}`),
    expected: {
      shouldDetect: true,
      category: "VULNERABILITY",
      minSeverity: "HIGH",
      descriptionSnippet: "command",
    },
    policies: DEFAULT_PROMPT_REGRESSION_POLICIES,
  },
  {
    id: "path-traversal",
    name: "Directory Path Traversal Vulnerability",
    filename: "src/routes/download.ts",
    code: `import fs from "fs";
import path from "path";

export function downloadFile(req: Request) {
  const filename = new URL(req.url).searchParams.get("file") || "";
  const filePath = path.join("/var/data/uploads", filename);
  return fs.readFileSync(filePath);
}`,
    patch: createUnifiedPatch(`import fs from "fs";
import path from "path";

export function downloadFile(req: Request) {
  const filename = new URL(req.url).searchParams.get("file") || "";
  const filePath = path.join("/var/data/uploads", filename);
  return fs.readFileSync(filePath);
}`),
    expected: {
      shouldDetect: true,
      category: "VULNERABILITY",
      minSeverity: "HIGH",
      descriptionSnippet: "traversal",
    },
    policies: DEFAULT_PROMPT_REGRESSION_POLICIES,
  },
  {
    id: "hardcoded-private-key",
    name: "Hardcoded RSA Private Key Block",
    filename: "src/auth/jwt-sign.ts",
    code: `export const RSA_PRIVATE_KEY = \`${SYNTHETIC_PEM_PRIVATE_KEY}\`;`,
    patch: createUnifiedPatch(`export const RSA_PRIVATE_KEY = \`${SYNTHETIC_PEM_PRIVATE_KEY}\`;`),
    expected: {
      shouldDetect: true,
      category: "SECRET",
      minSeverity: "CRITICAL",
      descriptionSnippet: "private key",
    },
    policies: DEFAULT_PROMPT_REGRESSION_POLICIES,
  },

  // ──────────────── Negative Samples (Known Safe Code / Placeholders) ────────────────
  {
    id: "safe-code",
    name: "Safe Discount Calculation",
    filename: "src/utils/math.ts",
    code: `export function calculateDiscount(price: number, percent: number): number {
  if (percent < 0 || percent > 100) {
    throw new Error("Invalid discount percentage");
  }
  return price - (price * percent) / 100;
}`,
    patch:
      createUnifiedPatch(`export function calculateDiscount(price: number, percent: number): number {
  if (percent < 0 || percent > 100) {
    throw new Error("Invalid discount percentage");
  }
  return price - (price * percent) / 100;
}`),
    expected: {
      shouldDetect: false,
    },
    policies: DEFAULT_PROMPT_REGRESSION_POLICIES,
  },
  {
    id: "placeholder-keys",
    name: "Template Environment File with Safe Placeholders",
    filename: ".env.example",
    code: `DATABASE_URL="postgresql://user:password@localhost:5432/mydb"
API_KEY="your_api_key_here"
AUTH_SECRET="your_secret_key_here"`,
    patch: createUnifiedPatch(`DATABASE_URL="postgresql://user:password@localhost:5432/mydb"
API_KEY="your_api_key_here"
AUTH_SECRET="your_secret_key_here"`),
    expected: {
      shouldDetect: false,
    },
    policies: DEFAULT_PROMPT_REGRESSION_POLICIES,
  },
  {
    id: "safe-parameterized-query",
    name: "Parameterized SQL Query with Placeholders",
    filename: "src/db/queries.ts",
    code: `export async function findUserById(pool: any, userId: string) {
  return pool.query("SELECT id, username, email FROM users WHERE id = $1", [userId]);
}`,
    patch: createUnifiedPatch(`export async function findUserById(pool: any, userId: string) {
  return pool.query("SELECT id, username, email FROM users WHERE id = $1", [userId]);
}`),
    expected: {
      shouldDetect: false,
    },
    policies: DEFAULT_PROMPT_REGRESSION_POLICIES,
  },
  {
    id: "safe-env-var-usage",
    name: "Safe Environment Variable Reading Without Leaks",
    filename: "src/lib/config.ts",
    code: `export const appConfig = {
  port: parseInt(process.env.PORT || "3000", 10),
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
};`,
    patch: createUnifiedPatch(`export const appConfig = {
  port: parseInt(process.env.PORT || "3000", 10),
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
};`),
    expected: {
      shouldDetect: false,
    },
    policies: DEFAULT_PROMPT_REGRESSION_POLICIES,
  },
  {
    id: "safe-restricted-cors",
    name: "Restricted CORS Whitelist Header",
    filename: "src/middleware/cors-safe.ts",
    code: `const ALLOWED_ORIGINS = ["https://app.secureflow.dev"];

export function handleCors(origin: string, res: any) {
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
}`,
    patch: createUnifiedPatch(`const ALLOWED_ORIGINS = ["https://app.secureflow.dev"];

export function handleCors(origin: string, res: any) {
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
}`),
    expected: {
      shouldDetect: false,
    },
    policies: DEFAULT_PROMPT_REGRESSION_POLICIES,
  },
  // ──────────────── Golden Samples for Confidence (#1924) ────────────────
  {
    id: "high-confidence-prod-secret",
    name: "Production Database Password (High Confidence)",
    filename: "src/config/database.ts",
    code: `export const databaseUrl = "postgres://app_admin:Sup3rS3cr3tPr0dK3y99@prod-db.internal:5432/production";`,
    patch: createUnifiedPatch(
      `export const databaseUrl = "postgres://app_admin:Sup3rS3cr3tPr0dK3y99@prod-db.internal:5432/production";`,
    ),
    expected: {
      shouldDetect: true,
      category: "SECRET",
      minSeverity: "CRITICAL",
      expectedConfidence: "HIGH",
    },
    policies: DEFAULT_PROMPT_REGRESSION_POLICIES,
  },
  {
    id: "low-confidence-test-fixture",
    name: "Mock Token in Test Fixture (Low Confidence)",
    filename: "tests/fixtures/mock-auth.ts",
    code: `export const TEST_BEARER_TOKEN = "test_token_placeholder_abc1234567890";`,
    patch: createUnifiedPatch(
      `export const TEST_BEARER_TOKEN = "test_token_placeholder_abc1234567890";`,
    ),
    expected: {
      shouldDetect: true,
      category: "SECRET",
      minSeverity: "LOW",
      expectedConfidence: "LOW",
    },
    policies: DEFAULT_PROMPT_REGRESSION_POLICIES,
  },
];
