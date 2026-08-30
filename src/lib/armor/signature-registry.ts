import {
  type PayloadSignature,
  DynamicFingerprintEngine,
  dynamicFingerprintEngine
} from './fingerprint';

/**
 * Extended metadata interface for language- and framework-aware security signatures.
 */
export interface ExtendedPayloadSignature extends PayloadSignature {
  targetLanguages?: string[];
  targetFrameworks?: string[];
  cweIds?: string[];
  owaspCategories?: string[];
  remediationGuidance?: string;
}

/**
 * Curated registry of multi-language and framework-specific security payload signatures.
 * Covers Python, Node/JS/TS, Java/Spring, Go, PHP/Laravel, Ruby/Rails, Rust/C++, and IaC/Docker.
 */
export const EXPANDED_SIGNATURE_REGISTRY: ExtendedPayloadSignature[] = [
  // --- Python / Django / Flask Signatures ---
  {
    id: 'SIG-PY-001',
    name: 'Python Insecure Deserialization (pickle/marshal/shelve)',
    pattern: /(?:pickle|cPickle|_pickle|shelve|marshal)\s*\.\s*(?:loads?|dump|read|load_build)\s*\(/i,
    severity: 'CRITICAL',
    category: 'RCE',
    version: '1.1.0',
    description: 'Detects unsafe Python object deserialization via pickle, marshal, or shelve.',
    targetLanguages: ['python'],
    targetFrameworks: ['django', 'flask', 'fastapi'],
    cweIds: ['CWE-502'],
    owaspCategories: ['A08:2021-Software and Data Integrity Failures'],
    remediationGuidance: 'Avoid deserializing untrusted data with pickle. Use safe structured serialization formats like JSON, MessagePack, or Protocol Buffers.'
  },
  {
    id: 'SIG-PY-002',
    name: 'Python Unsanitized Command Injection (subprocess/os.system)',
    pattern: /(?:os\.system|os\.popen|os\.exec[lv]p?e?|subprocess\.(?:call|run|Popen|check_output))\s*\(\s*(?:['"][^'"]*%\s*|f['"][^'"]*\{|format\(|[a-zA-Z_]\w*\s*(?:,\s*shell\s*=\s*True|\+\s*))/i,
    severity: 'CRITICAL',
    category: 'RCE',
    version: '1.1.0',
    description: 'Detects shell command execution with dynamic concatenation or shell=True.',
    targetLanguages: ['python'],
    targetFrameworks: ['django', 'flask', 'fastapi'],
    cweIds: ['CWE-78'],
    owaspCategories: ['A03:2021-Injection'],
    remediationGuidance: 'Pass arguments as a sequence without shell=True, or use shlex.quote to escape dynamic arguments.'
  },
  {
    id: 'SIG-PY-003',
    name: 'Python Server-Side Template Injection (Jinja2/Flask render_template_string)',
    pattern: /(?:render_template_string|Environment\s*\(.*?\)\.from_string)\s*\(\s*(?:f['"]|['"].*?%|[a-zA-Z_]\w*\s*\+)/i,
    severity: 'HIGH',
    category: 'INJECTION',
    version: '1.1.0',
    description: 'Detects dynamic template string rendering susceptible to Jinja2 SSTI.',
    targetLanguages: ['python'],
    targetFrameworks: ['flask', 'jinja2'],
    cweIds: ['CWE-1336'],
    owaspCategories: ['A03:2021-Injection'],
    remediationGuidance: 'Render static template files with render_template() and pass variables as template context instead of formatting strings directly.'
  },
  {
    id: 'SIG-PY-004',
    name: 'Django Raw SQL Query Parameter Concatenation',
    pattern: /(?:\.raw|\.extra|cursor\.execute)\s*\(\s*(?:f['"]|['"][^'"]*%\s*\(|['"][^'"]*\s*\+\s*[a-zA-Z_])/i,
    severity: 'CRITICAL',
    category: 'INJECTION',
    version: '1.1.0',
    description: 'Detects string-formatted or interpolated raw SQL queries in Django models or database cursors.',
    targetLanguages: ['python'],
    targetFrameworks: ['django'],
    cweIds: ['CWE-89'],
    owaspCategories: ['A03:2021-Injection'],
    remediationGuidance: 'Use parameterized queries with Django ORM expressions or pass parameters as the second argument to raw() or execute().'
  },
  {
    id: 'SIG-PY-005',
    name: 'Python Hardcoded Secret / Insecure Debug Configuration',
    pattern: /(?:DEBUG\s*=\s*True|SECRET_KEY\s*=\s*['"][a-zA-Z0-9_\-+=/]{16,}['"]|JWT_SECRET\s*=\s*['"][^'"]+['"])/i,
    severity: 'HIGH',
    category: 'SECRET_LEAK',
    version: '1.1.0',
    description: 'Detects hardcoded Django/Flask SECRET_KEY or DEBUG mode enabled.',
    targetLanguages: ['python'],
    targetFrameworks: ['django', 'flask', 'fastapi'],
    cweIds: ['CWE-798', 'CWE-489'],
    owaspCategories: ['A05:2021-Security Misconfiguration'],
    remediationGuidance: 'Load configuration and secrets from environment variables or secret management services.'
  },

  // --- Node.js / TypeScript / Express / Next.js Signatures ---
  {
    id: 'SIG-JS-001',
    name: 'Node.js Dynamic Code Execution via child_process or eval',
    pattern: /(?:child_process\.(?:exec|execSync|spawn|execFile)|require\s*\(\s*['"]child_process['"]\s*\)\.(?:exec|execSync))\s*\(\s*(?:`[^`]*\$\{|['"][^'"]*\s*\+)/i,
    severity: 'CRITICAL',
    category: 'RCE',
    version: '1.1.0',
    description: 'Detects dynamic shell command construction via Node.js child_process.',
    targetLanguages: ['javascript', 'typescript'],
    targetFrameworks: ['node', 'express', 'nextjs'],
    cweIds: ['CWE-78'],
    owaspCategories: ['A03:2021-Injection'],
    remediationGuidance: 'Use execFile or spawn with argument arrays rather than concatenating user input into shell commands.'
  },
  {
    id: 'SIG-JS-002',
    name: 'Node.js Sandbox Escape / VM Context Injection',
    pattern: /(?:vm\.(?:runInThisContext|runInNewContext|runInContext|Script)|new\s+vm\.Script)\s*\(\s*(?:`|['"][^'"]*\+|[a-zA-Z_]\w*)/i,
    severity: 'CRITICAL',
    category: 'ZERO_DAY_EXPLOIT',
    version: '1.1.0',
    description: 'Detects unsafe execution in Node.js vm module which does not guarantee a secure sandbox.',
    targetLanguages: ['javascript', 'typescript'],
    targetFrameworks: ['node'],
    cweIds: ['CWE-94'],
    owaspCategories: ['A03:2021-Injection'],
    remediationGuidance: 'Do not use the core vm module for untrusted code execution. Use isolated-vm or external sandboxing processes.'
  },
  {
    id: 'SIG-JS-003',
    name: 'Next.js / React Unsanitized dangerouslySetInnerHTML',
    pattern: /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*(?:`[^`]*\$\{|[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*\s*(?!\.sanitize))/i,
    severity: 'HIGH',
    category: 'INJECTION',
    version: '1.1.0',
    description: 'Detects direct rendering of unsanitized dynamic markup via dangerouslySetInnerHTML.',
    targetLanguages: ['javascript', 'typescript'],
    targetFrameworks: ['react', 'nextjs'],
    cweIds: ['CWE-79'],
    owaspCategories: ['A03:2021-Injection'],
    remediationGuidance: 'Sanitize HTML input with DOMPurify before setting dangerouslySetInnerHTML or use standard JSX rendering.'
  },
  {
    id: 'SIG-JS-004',
    name: 'Insecure JWT Verification / None Algorithm Bypass',
    pattern: /jwt\.(?:verify|decode)\s*\([^,]+,\s*(?:['"]none['"]|null|undefined|false|{\s*algorithms\s*:\s*\[\s*['"]none['"]\s*\])/i,
    severity: 'CRITICAL',
    category: 'ZERO_DAY_EXPLOIT',
    version: '1.1.0',
    description: 'Detects JWT verification disabling algorithm validation or permitting "none" algorithm.',
    targetLanguages: ['javascript', 'typescript'],
    targetFrameworks: ['node', 'express', 'nextjs'],
    cweIds: ['CWE-347', 'CWE-287'],
    owaspCategories: ['A07:2021-Identification and Authentication Failures'],
    remediationGuidance: 'Explicitly enforce supported asymmetric or HMAC algorithms (e.g. HS256, RS256) and always provide a secret key.'
  },
  {
    id: 'SIG-JS-005',
    name: 'Server-Side Request Forgery (SSRF) in Fetch/Axios',
    pattern: /(?:axios\.(?:get|post|put|delete|request)|fetch|got|needle)\s*\(\s*(?:req\.(?:query|body|params|headers)|params\.|searchParams\.get\()/i,
    severity: 'HIGH',
    category: 'ANOMALOUS_PAYLOAD',
    version: '1.1.0',
    description: 'Detects outbound HTTP requests using direct unvalidated request parameters as target URL.',
    targetLanguages: ['javascript', 'typescript'],
    targetFrameworks: ['express', 'node', 'nextjs'],
    cweIds: ['CWE-918'],
    owaspCategories: ['A10:2021-Server-Side Request Forgery (SSRF)'],
    remediationGuidance: 'Validate target hostnames against an explicit domain whitelist and block loopback/internal IP addresses (RFC 1918/link-local).'
  },

  // --- Java / Spring Boot / JVM Signatures ---
  {
    id: 'SIG-JAVA-001',
    name: 'Java Log4j JNDI Remote Code Execution Pattern (Log4Shell)',
    pattern: /\$\{jndi:(?:ldap|rmi|dns|nis|iiop|corba|nds|http|https):\/\/[^}]+\}/i,
    severity: 'CRITICAL',
    category: 'ZERO_DAY_EXPLOIT',
    version: '1.1.0',
    description: 'Detects JNDI lookup expressions commonly leveraged in Log4Shell exploits.',
    targetLanguages: ['java', 'kotlin', 'scala'],
    targetFrameworks: ['spring', 'log4j', 'log4j2'],
    cweIds: ['CWE-502', 'CWE-94'],
    owaspCategories: ['A06:2021-Vulnerable and Outdated Components'],
    remediationGuidance: 'Upgrade log4j to >= 2.17.1 and set log4j2.formatMsgNoLookups=true in runtime JVM options.'
  },
  {
    id: 'SIG-JAVA-002',
    name: 'Spring Expression Language (SpEL) Remote Code Execution',
    pattern: /(?:T\s*\(\s*java\.lang\.Runtime\s*\)\.getRuntime\(\)\.exec|SpelExpressionParser|parseExpression\s*\(\s*(?:request|req|\w+Input))/i,
    severity: 'CRITICAL',
    category: 'RCE',
    version: '1.1.0',
    description: 'Detects unvalidated Spring Expression Language evaluation leading to RCE (Spring4Shell vectors).',
    targetLanguages: ['java', 'kotlin'],
    targetFrameworks: ['spring', 'spring-boot'],
    cweIds: ['CWE-94'],
    owaspCategories: ['A03:2021-Injection'],
    remediationGuidance: 'Use SimpleEvaluationContext instead of StandardEvaluationContext when evaluating untrusted expressions.'
  },
  {
    id: 'SIG-JAVA-003',
    name: 'Java Unsafe Object Deserialization (ObjectInputStream.readObject)',
    pattern: /(?:new\s+ObjectInputStream\s*\(|XMLDecoder\s*\(|readObject\s*\(\s*\)|readUnshared\s*\(\s*\))/i,
    severity: 'CRITICAL',
    category: 'RCE',
    version: '1.1.0',
    description: 'Detects Java native binary deserialization with ObjectInputStream without object filtering.',
    targetLanguages: ['java', 'kotlin'],
    targetFrameworks: ['spring', 'jakarta', 'java-ee'],
    cweIds: ['CWE-502'],
    owaspCategories: ['A08:2021-Software and Data Integrity Failures'],
    remediationGuidance: 'Implement ObjectInputFilter or migrate to safe serialization libraries such as Jackson/Gson with strict typing.'
  },
  {
    id: 'SIG-JAVA-004',
    name: 'Java XML External Entity (XXE) Injection',
    pattern: /(?:DocumentBuilderFactory\.newInstance|SAXParserFactory\.newInstance|XMLInputFactory\.newFactory)\s*\(\s*\)(?![\s\S]*?FEATURE_SECURE_PROCESSING)/i,
    severity: 'HIGH',
    category: 'INJECTION',
    version: '1.1.0',
    description: 'Detects XML parsers configured without disabling external DTDs and general entity resolution.',
    targetLanguages: ['java'],
    targetFrameworks: ['spring', 'jakarta'],
    cweIds: ['CWE-611'],
    owaspCategories: ['A05:2021-Security Misconfiguration'],
    remediationGuidance: 'Enable XMLConstants.FEATURE_SECURE_PROCESSING and disable external DTDs and stylesheet references.'
  },

  // --- Go (Golang) Signatures ---
  {
    id: 'SIG-GO-001',
    name: 'Go Command Injection via exec.Command with Shell Interpreter',
    pattern: /exec\.Command\s*\(\s*['"](?:sh|bash|cmd|powershell)['"]\s*,\s*['"]-(?:c|Command)['"]\s*,\s*(?:fmt\.Sprintf|[a-zA-Z_]\w*\s*\+)/i,
    severity: 'CRITICAL',
    category: 'RCE',
    version: '1.1.0',
    description: 'Detects dynamic shell command invocation in Go via exec.Command and shell arguments.',
    targetLanguages: ['go'],
    targetFrameworks: ['gin', 'fiber', 'echo', 'standard-library'],
    cweIds: ['CWE-78'],
    owaspCategories: ['A03:2021-Injection'],
    remediationGuidance: 'Pass binary executable and arguments directly as separate slice arguments to exec.Command without invoking an intermediate shell.'
  },
  {
    id: 'SIG-GO-002',
    name: 'Go Insecure TLS Configuration (InsecureSkipVerify: true)',
    pattern: /tls\.Config\s*\{[\s\S]*?InsecureSkipVerify\s*:\s*true/i,
    severity: 'HIGH',
    category: 'ANOMALOUS_PAYLOAD',
    version: '1.1.0',
    description: 'Detects TLS certificate verification disabled in Go http client or server transport config.',
    targetLanguages: ['go'],
    targetFrameworks: ['standard-library', 'gin', 'fiber'],
    cweIds: ['CWE-295'],
    owaspCategories: ['A02:2021-Cryptographic Failures'],
    remediationGuidance: 'Never set InsecureSkipVerify to true in production; load proper CA root certificate pools.'
  },
  {
    id: 'SIG-GO-003',
    name: 'Go Unescaped HTML Rendering (template.HTML / text/template)',
    pattern: /(?:template\.HTML\s*\([a-zA-Z_]\w*\)|text\/template[\s\S]*?\.Execute\s*\()/i,
    severity: 'HIGH',
    category: 'INJECTION',
    version: '1.1.0',
    description: 'Detects unescaped HTML casting or use of text/template for HTML generation resulting in XSS.',
    targetLanguages: ['go'],
    targetFrameworks: ['html/template', 'gin', 'echo'],
    cweIds: ['CWE-79'],
    owaspCategories: ['A03:2021-Injection'],
    remediationGuidance: 'Use html/template package which automatically contextualizes and escapes dynamic output.'
  },

  // --- PHP / Laravel Signatures ---
  {
    id: 'SIG-PHP-001',
    name: 'PHP Unsafe Deserialization (unserialize)',
    pattern: /(?:unserialize\s*\(\s*\$_(?:GET|POST|REQUEST|COOKIE|SERVER)|unserialize\s*\(\s*\$[a-zA-Z_]\w*(?!\s*,\s*\[\s*['"]allowed_classes['"]\s*=>\s*false))/i,
    severity: 'CRITICAL',
    category: 'RCE',
    version: '1.1.0',
    description: 'Detects unsafe PHP object deserialization via unserialize() with user input or allowed classes.',
    targetLanguages: ['php'],
    targetFrameworks: ['laravel', 'symfony', 'wordpress'],
    cweIds: ['CWE-502'],
    owaspCategories: ['A08:2021-Software and Data Integrity Failures'],
    remediationGuidance: 'Use json_encode/json_decode or pass ["allowed_classes" => false] to unserialize.'
  },
  {
    id: 'SIG-PHP-002',
    name: 'PHP Arbitrary Code / Command Execution (eval/assert/shell_exec)',
    pattern: /(?:eval\s*\(\s*\$|assert\s*\(\s*\$|passthru\s*\(\s*\$|shell_exec\s*\(\s*\$|system\s*\(\s*\$|exec\s*\(\s*\$_(?:GET|POST|REQUEST))/i,
    severity: 'CRITICAL',
    category: 'RCE',
    version: '1.1.0',
    description: 'Detects dynamic evaluation or system shell command execution using user-controlled PHP variables.',
    targetLanguages: ['php'],
    targetFrameworks: ['laravel', 'symfony'],
    cweIds: ['CWE-94', 'CWE-78'],
    owaspCategories: ['A03:2021-Injection'],
    remediationGuidance: 'Eliminate eval/assert. Use escapeshellarg/escapeshellcmd if shell invocation is strictly necessary.'
  },
  {
    id: 'SIG-PHP-003',
    name: 'Laravel Raw SQL / Query Builder String Concatenation',
    pattern: /(?:DB::raw|whereRaw|havingRaw|orderByRaw|selectRaw)\s*\(\s*(?:['"][^'"]*['"]\s*\.\s*\$|\$_(?:GET|POST|REQUEST)|f?['"][^'"]*\{\$)/i,
    severity: 'CRITICAL',
    category: 'INJECTION',
    version: '1.1.0',
    description: 'Detects raw SQL expression interpolation in Laravel Eloquent queries.',
    targetLanguages: ['php'],
    targetFrameworks: ['laravel'],
    cweIds: ['CWE-89'],
    owaspCategories: ['A03:2021-Injection'],
    remediationGuidance: 'Pass query bindings as array parameter: DB::raw("status = ?", [$status]).'
  },

  // --- Ruby / Ruby on Rails Signatures ---
  {
    id: 'SIG-RB-001',
    name: 'Ruby Unsafe YAML/Marshal Deserialization',
    pattern: /(?:YAML\.(?:load|load_file)\s*\((?!.*?safe_load)|Marshal\.load\s*\()/i,
    severity: 'CRITICAL',
    category: 'RCE',
    version: '1.1.0',
    description: 'Detects unsafe YAML.load or Marshal.load vulnerable to arbitrary object instantiation.',
    targetLanguages: ['ruby'],
    targetFrameworks: ['rails', 'sinatra'],
    cweIds: ['CWE-502'],
    owaspCategories: ['A08:2021-Software and Data Integrity Failures'],
    remediationGuidance: 'Use YAML.safe_load instead of YAML.load and avoid Marshal for untrusted payload ingestion.'
  },
  {
    id: 'SIG-RB-002',
    name: 'Ruby on Rails Strong Parameters Bypass (params.permit!)',
    pattern: /params(?:\.[a-zA-Z_]\w*)?\s*\.permit!\s*/i,
    severity: 'HIGH',
    category: 'ZERO_DAY_EXPLOIT',
    version: '1.1.0',
    description: 'Detects explicit permit! bypass allowing mass-assignment on Rails active models.',
    targetLanguages: ['ruby'],
    targetFrameworks: ['rails'],
    cweIds: ['CWE-915'],
    owaspCategories: ['A04:2021-Insecure Design'],
    remediationGuidance: 'Explicitly whitelist permitted attributes using params.require(:model).permit(:field1, :field2).'
  },

  // --- Rust / C / C++ Signatures ---
  {
    id: 'SIG-NATIVE-001',
    name: 'C/C++ Deprecated Insecure Memory / String Functions',
    pattern: /(?:strcpy|strcat|gets|sprintf|vsprintf)\s*\(\s*[a-zA-Z_]\w*\s*,/i,
    severity: 'HIGH',
    category: 'ZERO_DAY_EXPLOIT',
    version: '1.1.0',
    description: 'Detects standard C string manipulation functions with unbounded buffer lengths.',
    targetLanguages: ['c', 'cpp'],
    targetFrameworks: ['standard-library'],
    cweIds: ['CWE-120', 'CWE-676'],
    owaspCategories: ['A06:2021-Vulnerable and Outdated Components'],
    remediationGuidance: 'Replace with bounded variants (strncpy, snprintf, strlcpy) or standard C++ std::string containers.'
  },
  {
    id: 'SIG-RUST-001',
    name: 'Rust Unchecked Transmute / Unsafe Memory Pointer Aliasing',
    pattern: /std::mem::transmute\s*(?:::<[^>]+>)?\s*\(|core::mem::transmute/i,
    severity: 'HIGH',
    category: 'ZERO_DAY_EXPLOIT',
    version: '1.1.0',
    description: 'Detects arbitrary type transmutation which can violate memory safety invariants.',
    targetLanguages: ['rust'],
    targetFrameworks: ['standard-library'],
    cweIds: ['CWE-704'],
    owaspCategories: ['A04:2021-Insecure Design'],
    remediationGuidance: 'Use safe conversion traits (From/Into, TryFrom/TryInto) or zerocopy / bytemuck crates with verified alignments.'
  },

  // --- Infrastructure-as-Code / Docker / Kubernetes Signatures ---
  {
    id: 'SIG-IAC-001',
    name: 'Dockerfile Exposed Hardcoded Secret / Insecure Root Execution',
    pattern: /(?:ENV\s+(?:AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|PRIVATE_KEY|DATABASE_PASSWORD)\s*=\s*['"]?[^\s'"]+|USER\s+root\s*$)/im,
    severity: 'HIGH',
    category: 'SECRET_LEAK',
    version: '1.1.0',
    description: 'Detects plain-text credentials or non-root degradation in container build recipes.',
    targetLanguages: ['dockerfile'],
    targetFrameworks: ['docker', 'kubernetes'],
    cweIds: ['CWE-798', 'CWE-250'],
    owaspCategories: ['A05:2021-Security Misconfiguration'],
    remediationGuidance: 'Use Docker build secrets (--mount=type=secret) and specify an unprivileged USER.'
  },
  {
    id: 'SIG-IAC-002',
    name: 'Kubernetes Permissive Cluster-Admin RBAC Binding',
    pattern: /kind:\s*ClusterRoleBinding[\s\S]*?name:\s*cluster-admin/i,
    severity: 'HIGH',
    category: 'ANOMALOUS_PAYLOAD',
    version: '1.1.0',
    description: 'Detects full cluster-admin permissions bound to non-system service accounts.',
    targetLanguages: ['yaml', 'json'],
    targetFrameworks: ['kubernetes', 'helm'],
    cweIds: ['CWE-269'],
    owaspCategories: ['A01:2021-Broken Access Control'],
    remediationGuidance: 'Grant minimum required role verbs/resources within a specific namespace RoleBinding.'
  }
];

/**
 * Filter signatures by targeted programming language (e.g., 'python', 'javascript', 'java', 'go', 'php', 'ruby', 'rust', 'dockerfile').
 */
export function getSignaturesByLanguage(language: string): ExtendedPayloadSignature[] {
  const normalized = language.trim().toLowerCase();
  return EXPANDED_SIGNATURE_REGISTRY.filter(sig =>
    sig.targetLanguages?.some(lang => lang.toLowerCase() === normalized)
  );
}

/**
 * Filter signatures by targeted framework (e.g., 'django', 'spring', 'express', 'nextjs', 'laravel', 'rails', 'kubernetes').
 */
export function getSignaturesByFramework(framework: string): ExtendedPayloadSignature[] {
  const normalized = framework.trim().toLowerCase();
  return EXPANDED_SIGNATURE_REGISTRY.filter(sig =>
    sig.targetFrameworks?.some(fw => fw.toLowerCase() === normalized)
  );
}

/**
 * Filter signatures by category.
 */
export function getSignaturesByCategory(
  category: PayloadSignature['category']
): ExtendedPayloadSignature[] {
  return EXPANDED_SIGNATURE_REGISTRY.filter(sig => sig.category === category);
}

/**
 * Filter signatures by severity.
 */
export function getSignaturesBySeverity(
  severity: PayloadSignature['severity']
): ExtendedPayloadSignature[] {
  return EXPANDED_SIGNATURE_REGISTRY.filter(sig => sig.severity === severity);
}

/**
 * Search signatures matching a keyword query against id, name, description, or remediation guidance.
 */
export function searchSignatures(query: string): ExtendedPayloadSignature[] {
  const lower = query.toLowerCase().trim();
  if (!lower) return [...EXPANDED_SIGNATURE_REGISTRY];

  return EXPANDED_SIGNATURE_REGISTRY.filter(sig =>
    sig.id.toLowerCase().includes(lower) ||
    sig.name.toLowerCase().includes(lower) ||
    (sig.description && sig.description.toLowerCase().includes(lower)) ||
    (sig.remediationGuidance && sig.remediationGuidance.toLowerCase().includes(lower)) ||
    sig.cweIds?.some(cwe => cwe.toLowerCase().includes(lower)) ||
    sig.targetLanguages?.some(l => l.toLowerCase().includes(lower)) ||
    sig.targetFrameworks?.some(f => f.toLowerCase().includes(lower))
  );
}

export interface LoadRegistryOptions {
  languages?: string[];
  frameworks?: string[];
  categories?: PayloadSignature['category'][];
  version?: string;
}

/**
 * Load the expanded signature registry into a DynamicFingerprintEngine instance.
 * Defaults to the global singleton engine if none is supplied.
 */
export function loadRegistryIntoEngine(
  engine: DynamicFingerprintEngine = dynamicFingerprintEngine,
  options?: LoadRegistryOptions
): number {
  let signaturesToLoad = EXPANDED_SIGNATURE_REGISTRY;

  if (options?.languages && options.languages.length > 0) {
    const langSet = new Set(options.languages.map(l => l.toLowerCase()));
    signaturesToLoad = signaturesToLoad.filter(s =>
      s.targetLanguages?.some(l => langSet.has(l.toLowerCase()))
    );
  }

  if (options?.frameworks && options.frameworks.length > 0) {
    const fwSet = new Set(options.frameworks.map(f => f.toLowerCase()));
    signaturesToLoad = signaturesToLoad.filter(s =>
      s.targetFrameworks?.some(f => fwSet.has(f.toLowerCase()))
    );
  }

  if (options?.categories && options.categories.length > 0) {
    const catSet = new Set(options.categories);
    signaturesToLoad = signaturesToLoad.filter(s => catSet.has(s.category));
  }

  engine.updateSignatureDatabase(signaturesToLoad, options?.version || '1.1.0');
  return signaturesToLoad.length;
}

export interface SignatureCatalogSummary {
  totalSignatures: number;
  languages: string[];
  frameworks: string[];
  categories: Record<string, number>;
  severities: Record<string, number>;
  version: string;
}

/**
 * Export catalog summary statistics about the curated signature registry.
 */
export function exportSignatureCatalogSummary(): SignatureCatalogSummary {
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  const categories: Record<string, number> = {};
  const severities: Record<string, number> = {};

  for (const sig of EXPANDED_SIGNATURE_REGISTRY) {
    sig.targetLanguages?.forEach(l => languages.add(l));
    sig.targetFrameworks?.forEach(f => frameworks.add(f));
    categories[sig.category] = (categories[sig.category] || 0) + 1;
    severities[sig.severity] = (severities[sig.severity] || 0) + 1;
  }

  return {
    totalSignatures: EXPANDED_SIGNATURE_REGISTRY.length,
    languages: Array.from(languages).sort(),
    frameworks: Array.from(frameworks).sort(),
    categories,
    severities,
    version: '1.1.0'
  };
}
