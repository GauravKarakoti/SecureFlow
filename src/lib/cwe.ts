/**
 * Common Weakness Enumeration (CWE) Taxonomy and Mapping Engine (#2008)
 *
 * Provides a canonical mapping table between SecureFlow finding types,
 * categories, signature IDs, and security policy categories to standard CWE IDs
 * (e.g. CWE-798, CWE-89, CWE-79, CWE-78).
 *
 * Mappings follow MITRE CWE standards. Unknown categories/policies leave the CWE field empty (undefined).
 */

export interface CweDefinition {
  id: string; // e.g., "CWE-798"
  name: string;
  description: string;
  category: "SECRET" | "VULNERABILITY" | "MISCONFIG" | "OTHER";
}

/**
 * Curated dictionary of standard CWE definitions mapped in SecureFlow.
 */
export const CWE_CATALOG: Readonly<Record<string, CweDefinition>> = {
  "CWE-798": {
    id: "CWE-798",
    name: "Use of Hard-coded Credentials",
    description:
      "The software contains hard-coded credentials, such as a password or cryptographic key.",
    category: "SECRET",
  },
  "CWE-259": {
    id: "CWE-259",
    name: "Use of Hard-coded Password",
    description: "The software uses a hard-coded password for authentication or encryption.",
    category: "SECRET",
  },
  "CWE-312": {
    id: "CWE-312",
    name: "Cleartext Storage of Sensitive Information",
    description: "The software stores sensitive information in cleartext without encryption.",
    category: "SECRET",
  },
  "CWE-200": {
    id: "CWE-200",
    name: "Exposure of Sensitive Information to an Unauthorized Actor",
    description:
      "The software exposes sensitive information to an actor that is not explicitly authorized.",
    category: "SECRET",
  },
  "CWE-89": {
    id: "CWE-89",
    name: "Improper Neutralization of Special Elements used in an SQL Command ('SQL Injection')",
    description:
      "The software constructs all or part of an SQL command using externally-influenced input without neutralization.",
    category: "VULNERABILITY",
  },
  "CWE-78": {
    id: "CWE-78",
    name: "Improper Neutralization of Special Elements used in an OS Command ('OS Command Injection')",
    description:
      "The software constructs all or part of an OS command using externally-influenced input without neutralization.",
    category: "VULNERABILITY",
  },
  "CWE-79": {
    id: "CWE-79",
    name: "Improper Neutralization of Input During Web Page Generation ('Cross-site Scripting')",
    description:
      "The software places user-controllable input into output web pages without neutralization.",
    category: "VULNERABILITY",
  },
  "CWE-94": {
    id: "CWE-94",
    name: "Improper Control of Generation of Code ('Code Injection')",
    description:
      "The software generates or executes code using externally-influenced input without proper neutralization.",
    category: "VULNERABILITY",
  },
  "CWE-22": {
    id: "CWE-22",
    name: "Improper Limitation of a Pathname to a Restricted Directory ('Path Traversal')",
    description:
      "The software uses external input to construct a pathname intended to be within a restricted directory.",
    category: "VULNERABILITY",
  },
  "CWE-918": {
    id: "CWE-918",
    name: "Server-Side Request Forgery (SSRF)",
    description:
      "The web server receives a URL or similar request from an upstream component and fetches resource without validation.",
    category: "VULNERABILITY",
  },
  "CWE-352": {
    id: "CWE-352",
    name: "Cross-Site Request Forgery (CSRF)",
    description:
      "The web application does not sufficiently verify whether a well-formed request was sent deliberately.",
    category: "VULNERABILITY",
  },
  "CWE-502": {
    id: "CWE-502",
    name: "Deserialization of Untrusted Data",
    description:
      "The application deserializes untrusted data without sufficiently verifying that the resulting data will be valid.",
    category: "VULNERABILITY",
  },
  "CWE-327": {
    id: "CWE-327",
    name: "Use of a Broken or Risky Cryptographic Algorithm",
    description:
      "The use of a broken or risky cryptographic algorithm will result in compromised security.",
    category: "VULNERABILITY",
  },
  "CWE-287": {
    id: "CWE-287",
    name: "Improper Authentication",
    description:
      "When an actor claims to have a given identity, the software does not prove or improperly proves that the claim is correct.",
    category: "VULNERABILITY",
  },
  "CWE-862": {
    id: "CWE-862",
    name: "Missing Authorization",
    description:
      "The software does not perform an authorization check when an actor attempts to access a resource.",
    category: "VULNERABILITY",
  },
  "CWE-601": {
    id: "CWE-601",
    name: "URL Redirection to Untrusted Site ('Open Redirect')",
    description:
      "A web application accepts a user-controlled input that specifies a link to an external site, and uses that link in a redirect.",
    category: "VULNERABILITY",
  },
  "CWE-1395": {
    id: "CWE-1395",
    name: "Dependency on Vulnerable Third-Party Component",
    description:
      "The software depends on a vulnerable or typosquatted third-party package or component.",
    category: "VULNERABILITY",
  },
  "CWE-841": {
    id: "CWE-841",
    name: "Improper Enforcement of Behavioral Workflow",
    description: "Smart contract workflow vulnerability such as reentrancy or state mismatch.",
    category: "VULNERABILITY",
  },
  "CWE-16": {
    id: "CWE-16",
    name: "Configuration",
    description: "Weakness related to configuration settings or deployment attributes.",
    category: "MISCONFIG",
  },
  "CWE-250": {
    id: "CWE-250",
    name: "Execution with Unnecessary Privileges",
    description:
      "The software runs with elevated or unnecessary privileges (e.g. root or privileged container).",
    category: "MISCONFIG",
  },
  "CWE-732": {
    id: "CWE-732",
    name: "Incorrect Permission Assignment for Critical Resource",
    description:
      "Critical resource (bucket, security group, workflow) has overly permissive permissions.",
    category: "MISCONFIG",
  },
  "CWE-1004": {
    id: "CWE-1004",
    name: "Sensitive Cookie Without 'HttpOnly' Flag",
    description: "Cookie missing HttpOnly flag, allowing client script access.",
    category: "MISCONFIG",
  },
  "CWE-284": {
    id: "CWE-284",
    name: "Improper Access Control",
    description:
      "The software does not restrict or incorrectly restricts access to a resource from an unauthorized actor.",
    category: "MISCONFIG",
  },
};

/**
 * Mapping table of exact normalized finding types and common category aliases to standard CWE IDs.
 */
const TYPE_OR_POLICY_TO_CWE: Readonly<Record<string, string>> = {
  // Secrets / Credentials
  SECRET: "CWE-798",
  SECRETS: "CWE-798",
  HARDCODED_SECRET: "CWE-798",
  HARDCODEDSECRET: "CWE-798",
  HARDCODEDSECRETS: "CWE-798",
  HARDCODED_CREDENTIAL: "CWE-798",
  HARDCODEDCREDENTIAL: "CWE-798",
  HARDCODED_PASSWORD: "CWE-259",
  HARDCODEDPASSWORD: "CWE-259",
  DATALEAK: "CWE-312",
  DATA_LEAK: "CWE-312",
  CREDENTIAL_LEAK: "CWE-798",
  CREDENTIALLEAK: "CWE-798",
  APIKEY: "CWE-798",
  API_KEY: "CWE-798",
  TOKEN: "CWE-798",
  PRIVATEKEY: "CWE-798",
  PRIVATE_KEY: "CWE-798",
  SENSITIVE_DATA_EXPOSURE: "CWE-200",
  INFORMATION_DISCLOSURE: "CWE-200",

  // Specific Vulnerabilities
  SQL_INJECTION: "CWE-89",
  SQLINJECTION: "CWE-89",
  SQLI: "CWE-89",
  COMMAND_INJECTION: "CWE-78",
  COMMANDINJECTION: "CWE-78",
  OS_COMMAND_INJECTION: "CWE-78",
  CODE_INJECTION: "CWE-94",
  CODEINJECTION: "CWE-94",
  XSS: "CWE-79",
  CROSS_SITE_SCRIPTING: "CWE-79",
  CROSSSITESCRIPTING: "CWE-79",
  CSRF: "CWE-352",
  CROSS_SITE_REQUEST_FORGERY: "CWE-352",
  SSRF: "CWE-918",
  SERVER_SIDE_REQUEST_FORGERY: "CWE-918",
  PATH_TRAVERSAL: "CWE-22",
  PATHTRAVERSAL: "CWE-22",
  DIRECTORY_TRAVERSAL: "CWE-22",
  INSECURE_DESERIALIZATION: "CWE-502",
  INSECUREDESERIALIZATION: "CWE-502",
  BROKEN_ACCESS_CONTROL: "CWE-862",
  BROKENACCESSCONTROL: "CWE-862",
  BROKEN_AUTHENTICATION: "CWE-287",
  BROKENAUTHENTICATION: "CWE-287",
  OPEN_REDIRECT: "CWE-601",
  OPENREDIRECT: "CWE-601",
  WEAK_CRYPTOGRAPHY: "CWE-327",
  BROKEN_CRYPTO: "CWE-327",
  REENTRANCY: "CWE-841",
  REENTRANCY_ATTACK: "CWE-841",
  TYPOSQUAT: "CWE-1395",
  MALICIOUS_DEPENDENCY: "CWE-1395",
  SUPPLY_CHAIN: "CWE-1395",

  // Infrastructure / Misconfiguration Policies
  MISCONFIG: "CWE-16",
  SECURITY_MISCONFIGURATION: "CWE-16",
  PRIVILEGED_CONTAINER: "CWE-250",
  ROOT_USER: "CWE-250",
  PUBLIC_BUCKET: "CWE-732",
  OPEN_SECURITY_GROUP: "CWE-284",
  MISSING_ENCRYPTION: "CWE-312",
  UNPINNED_ACTION: "CWE-1395",
  SCRIPT_INJECTION: "CWE-78",
  WRITE_ALL_PERMISSIONS: "CWE-250",
};

/**
 * Keyword patterns checked against explanation, description, or policy names
 * when exact type lookup does not match.
 */
const PATTERN_MAPPINGS: ReadonlyArray<{ pattern: RegExp; cwe: string }> = [
  { pattern: /\b(sql\s*injection|sqli)\b/i, cwe: "CWE-89" },
  { pattern: /\b(command\s*injection|shell\s*injection|os\s*command)\b/i, cwe: "CWE-78" },
  { pattern: /\b(cross[-\s]?site\s*scripting|xss)\b/i, cwe: "CWE-79" },
  { pattern: /\b(path\s*traversal|directory\s*traversal)\b/i, cwe: "CWE-22" },
  { pattern: /\b(server[-\s]?side\s*request\s*forgery|ssrf)\b/i, cwe: "CWE-918" },
  { pattern: /\b(deserializ|pickle\.loads|yaml\.load)\b/i, cwe: "CWE-502" },
  {
    pattern:
      /\b(hardcoded\s*(secret|password|credential|token|api\s*key)|exposed\s*secret|secret\s*key|api\s*key)\b/i,
    cwe: "CWE-798",
  },
  { pattern: /\b(reentrancy|cross[-\s]?function\s*race)\b/i, cwe: "CWE-841" },
  { pattern: /\b(open\s*redirect)\b/i, cwe: "CWE-601" },
  { pattern: /\b(typosquat|malicious\s*dependency)\b/i, cwe: "CWE-1395" },
  { pattern: /\b(root\s*user|privileged\s*container|write-all)\b/i, cwe: "CWE-250" },
  {
    pattern: /\b(0\.0\.0\.0\/0|open\s*security\s*group|public\s*s3\s*bucket|public\s*bucket)\b/i,
    cwe: "CWE-732",
  },
  { pattern: /\b(weak\s*hash|md5|sha1|des\s*cipher)\b/i, cwe: "CWE-327" },
];

/**
 * Validates whether a given string is a canonical CWE identifier (e.g. "CWE-798").
 */
export function isValidCwe(cwe: unknown): cwe is string {
  if (typeof cwe !== "string") return false;
  return /^CWE-\d+$/i.test(cwe.trim());
}

/**
 * Normalizes a CWE input string to canonical uppercase form (e.g. "cwe-89" -> "CWE-89").
 */
export function normalizeCwe(cwe: string): string {
  const match = cwe.trim().match(/CWE[-_](\d+)/i);
  return match ? `CWE-${match[1]}` : cwe.trim().toUpperCase();
}

/**
 * Generates official MITRE definition link for a given CWE ID.
 * Returns empty string if invalid.
 */
export function getCweUrl(cwe: string): string {
  const match = cwe.trim().match(/CWE[-_](\d+)/i);
  if (!match) return "";
  return `https://cwe.mitre.org/data/definitions/${match[1]}.html`;
}

/**
 * Resolves a CWE identifier from finding properties (type, policy name, explanation, or code snippet).
 * If unknown, returns undefined (field remains empty).
 */
export function resolveCwe(finding: {
  cwe?: string | null;
  type?: string | null;
  policy?: string | null;
  ruleId?: string | null;
  explanation?: string | null;
  description?: string | null;
  codeSnippet?: string | null;
  fileLocation?: string | null;
}): string | undefined {
  // 1. If explicit valid CWE already provided, normalize and return
  if (finding.cwe && isValidCwe(finding.cwe)) {
    return normalizeCwe(finding.cwe);
  }

  // 2. Check ruleId if it contains a CWE
  if (finding.ruleId) {
    const match = finding.ruleId.match(/CWE[-_](\d+)/i);
    if (match) return `CWE-${match[1]}`;
  }

  // 3. Exact matching on type / policy
  const candidates = [finding.type, finding.policy]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) =>
      v
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, "_"),
    );

  for (const candidate of candidates) {
    if (TYPE_OR_POLICY_TO_CWE[candidate]) {
      return TYPE_OR_POLICY_TO_CWE[candidate];
    }
  }

  // 4. Keyword / Regex search across description, explanation, type, policy
  const fullText = [
    finding.type,
    finding.policy,
    finding.explanation,
    finding.description,
    finding.codeSnippet,
  ]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ");

  // Direct embedded CWE string check
  const embeddedMatch = fullText.match(/\bCWE[-_](\d+)\b/i);
  if (embeddedMatch) {
    return `CWE-${embeddedMatch[1]}`;
  }

  // Pattern checks
  for (const { pattern, cwe } of PATTERN_MAPPINGS) {
    if (pattern.test(fullText)) {
      return cwe;
    }
  }

  // Unknown categories leave the field empty
  return undefined;
}
