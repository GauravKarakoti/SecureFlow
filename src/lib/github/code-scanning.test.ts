import { gunzipSync } from "node:zlib";
import { describe, it, expect, vi } from "vitest";
import {
  buildSarifDocument,
  encodeSarif,
  FINGERPRINT_KEY,
  isValidCommitSha,
  MAX_RESULTS,
  pullRequestRef,
  uploadSarifAnalysis,
  type CodeScanningFinding,
} from "./code-scanning";

const SHA = "a".repeat(40);

function finding(overrides: Partial<CodeScanningFinding> = {}): CodeScanningFinding {
  return {
    type: "SECRET",
    severity: "CRITICAL",
    fileLocation: "src/config.ts",
    lineStart: 12,
    lineEnd: 12,
    description: "Hardcoded API key",
    fingerprint: "fp-1",
    ...overrides,
  };
}

/** Decode what actually went over the wire, rather than trusting the builder twice. */
function decodeSarif(encoded: string): any {
  return JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"));
}

function clientResolving(data: unknown = { id: "sarif-1", url: "https://api.github.com/x" }) {
  return { request: vi.fn().mockResolvedValue({ data }) };
}

function clientRejecting(status: number) {
  return { request: vi.fn().mockRejectedValue(Object.assign(new Error("boom"), { status })) };
}

describe("buildSarifDocument", () => {
  it("carries the finding's own fingerprint as partialFingerprints", () => {
    const doc = buildSarifDocument([finding({ fingerprint: "abc123" })]);

    // Without this GitHub re-opens a moved finding as a new alert and the
    // triage a developer did on it is lost.
    expect(doc.runs[0].results[0].partialFingerprints).toEqual({
      [FINGERPRINT_KEY]: "abc123",
    });
  });

  it("omits partialFingerprints rather than sending an empty one", () => {
    const doc = buildSarifDocument([finding({ fingerprint: null })]);

    expect(doc.runs[0].results[0].partialFingerprints).toBeUndefined();
  });

  it("keeps a distinct fingerprint per finding", () => {
    const doc = buildSarifDocument([
      finding({ fingerprint: "one" }),
      finding({ fingerprint: "two", severity: "HIGH" }),
    ]);

    const fingerprints = doc.runs[0].results.map((r) => r.partialFingerprints?.[FINGERPRINT_KEY]);
    expect(fingerprints).toEqual(["one", "two"]);
  });

  it("maps severity onto SARIF levels and GitHub's security-severity", () => {
    const doc = buildSarifDocument([
      finding({ severity: "CRITICAL" }),
      finding({ severity: "MEDIUM" }),
      finding({ severity: "LOW" }),
    ]);

    expect(doc.runs[0].results.map((r) => r.level)).toEqual(["error", "warning", "note"]);
    expect(doc.runs[0].tool.driver.rules.map((r) => r.properties["security-severity"])).toEqual([
      "9.5",
      "5.5",
      "3.0",
    ]);
  });

  it("orders results most severe first", () => {
    const doc = buildSarifDocument([
      finding({ severity: "LOW", fingerprint: "low" }),
      finding({ severity: "CRITICAL", fingerprint: "critical" }),
      finding({ severity: "MEDIUM", fingerprint: "medium" }),
    ]);

    expect(doc.runs[0].results.map((r) => r.partialFingerprints?.[FINGERPRINT_KEY])).toEqual([
      "critical",
      "medium",
      "low",
    ]);
  });

  it("caps results at the documented ceiling, keeping the most severe", () => {
    const many = [
      ...Array.from({ length: MAX_RESULTS }, () => finding({ severity: "LOW" })),
      finding({ severity: "CRITICAL", fingerprint: "keep-me" }),
    ];

    const doc = buildSarifDocument(many);

    expect(doc.runs[0].results).toHaveLength(MAX_RESULTS);
    expect(doc.runs[0].results[0].partialFingerprints?.[FINGERPRINT_KEY]).toBe("keep-me");
  });

  it("emits a valid empty run when everything is fixed", () => {
    const doc = buildSarifDocument([]);

    // An empty run is how GitHub closes alerts that no longer reproduce.
    expect(doc.version).toBe("2.1.0");
    expect(doc.runs[0].results).toEqual([]);
    expect(doc.runs[0].tool.driver.name).toBe("SecureFlow");
  });

  it("normalises Windows separators and ./ prefixes in the artifact path", () => {
    const doc = buildSarifDocument([finding({ fileLocation: ".\\src\\lib\\config.ts" })]);

    expect(doc.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe(
      "src/lib/config.ts",
    );
  });

  it("omits the region when the scanner could not place the finding", () => {
    const doc = buildSarifDocument([finding({ lineStart: null, lineEnd: null })]);

    // GitHub rejects a region without a valid startLine, and pointing an
    // unplaced finding at line 1 would misreport where the problem is.
    expect(doc.runs[0].results[0].locations[0].physicalLocation.region).toBeUndefined();
  });

  it("drops an end line that precedes the start line", () => {
    const doc = buildSarifDocument([finding({ lineStart: 20, lineEnd: 5 })]);

    expect(doc.runs[0].results[0].locations[0].physicalLocation.region).toEqual({ startLine: 20 });
  });

  it("prefers the AI explanation for the alert message", () => {
    const doc = buildSarifDocument([
      finding({ explanation: "This leaks a production key.", description: "Hardcoded API key" }),
    ]);

    expect(doc.runs[0].results[0].message.text).toBe("This leaks a production key.");
  });

  it("falls back to a readable message when a finding carries no text", () => {
    const doc = buildSarifDocument([
      finding({ explanation: null, description: null, remediation: null }),
    ]);

    expect(doc.runs[0].results[0].message.text).toMatch(/SecureFlow flagged a secret finding/i);
  });

  it("reuses one rule per category and severity pair", () => {
    const doc = buildSarifDocument([
      finding({ severity: "CRITICAL" }),
      finding({ severity: "CRITICAL" }),
    ]);

    expect(doc.runs[0].tool.driver.rules).toHaveLength(1);
    expect(doc.runs[0].results.every((r) => r.ruleIndex === 0)).toBe(true);
    expect(doc.runs[0].results[0].ruleId).toBe(doc.runs[0].tool.driver.rules[0].id);
  });

  it("files an unrecognised finding type under OTHER rather than dropping it", () => {
    const doc = buildSarifDocument([finding({ type: "SOMETHING_NEW" })]);

    expect(doc.runs[0].results).toHaveLength(1);
    expect(doc.runs[0].tool.driver.rules[0].id).toContain("other");
  });
});

describe("encodeSarif", () => {
  it("gzips then Base64-encodes, which is what the endpoint requires", () => {
    const doc = buildSarifDocument([finding()]);

    const encoded = encodeSarif(doc);

    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(decodeSarif(encoded)).toEqual(doc);
  });
});

describe("uploadSarifAnalysis", () => {
  it("posts the repository, commit, ref and encoded payload GitHub expects", async () => {
    const client = clientResolving();
    const document = buildSarifDocument([finding({ fingerprint: "wire-check" })]);

    const outcome = await uploadSarifAnalysis(client, {
      owner: "GauravKarakoti",
      repo: "SecureFlow",
      commitSha: SHA,
      ref: pullRequestRef(42),
      document,
    });

    expect(outcome).toEqual({ status: "uploaded", id: "sarif-1", url: "https://api.github.com/x" });

    const [route, params] = client.request.mock.calls[0];
    expect(route).toBe("POST /repos/{owner}/{repo}/code-scanning/sarifs");
    expect(params.owner).toBe("GauravKarakoti");
    expect(params.repo).toBe("SecureFlow");
    expect(params.commit_sha).toBe(SHA);
    expect(params.ref).toBe("refs/pull/42/head");

    // The payload must survive the round trip with the fingerprint intact.
    const sent = decodeSarif(params.sarif as string);
    expect(sent.runs[0].results[0].partialFingerprints[FINGERPRINT_KEY]).toBe("wire-check");
  });

  it("sends checkout_uri only when one is supplied", async () => {
    const client = clientResolving();

    await uploadSarifAnalysis(client, {
      owner: "o",
      repo: "r",
      commitSha: SHA,
      ref: pullRequestRef(1),
      document: buildSarifDocument([]),
    });

    expect(client.request.mock.calls[0][1]).not.toHaveProperty("checkout_uri");
  });

  it("treats 403 as code scanning being unavailable, not as a failure", async () => {
    // A private repository without Advanced Security answers 403, and that must
    // never turn a green scan into a failed pull request check.
    const outcome = await uploadSarifAnalysis(clientRejecting(403), {
      owner: "o",
      repo: "r",
      commitSha: SHA,
      ref: pullRequestRef(1),
      document: buildSarifDocument([finding()]),
    });

    expect(outcome).toEqual({
      status: "skipped",
      reason: "code-scanning-unavailable",
      statusCode: 403,
    });
  });

  it("treats 404 the same way, which is what a missing permission looks like", async () => {
    const outcome = await uploadSarifAnalysis(clientRejecting(404), {
      owner: "o",
      repo: "r",
      commitSha: SHA,
      ref: pullRequestRef(1),
      document: buildSarifDocument([finding()]),
    });

    expect(outcome).toMatchObject({ status: "skipped", reason: "code-scanning-unavailable" });
  });

  it("reports an oversized payload distinctly", async () => {
    const outcome = await uploadSarifAnalysis(clientRejecting(413), {
      owner: "o",
      repo: "r",
      commitSha: SHA,
      ref: pullRequestRef(1),
      document: buildSarifDocument([finding()]),
    });

    expect(outcome).toMatchObject({ status: "skipped", reason: "payload-too-large" });
  });

  it("swallows any other failure so the scan still completes", async () => {
    const outcome = await uploadSarifAnalysis(clientRejecting(500), {
      owner: "o",
      repo: "r",
      commitSha: SHA,
      ref: pullRequestRef(1),
      document: buildSarifDocument([finding()]),
    });

    expect(outcome).toMatchObject({ status: "skipped", reason: "upload-failed", statusCode: 500 });
  });

  it("refuses to call GitHub with a commit SHA it would reject", async () => {
    const client = clientResolving();

    const outcome = await uploadSarifAnalysis(client, {
      owner: "o",
      repo: "r",
      commitSha: "not-a-sha",
      ref: pullRequestRef(1),
      document: buildSarifDocument([finding()]),
    });

    expect(outcome).toEqual({ status: "skipped", reason: "invalid-commit-sha" });
    expect(client.request).not.toHaveBeenCalled();
  });
});

describe("isValidCommitSha", () => {
  it("accepts SHA-1 and SHA-256 commit ids and rejects anything else", () => {
    expect(isValidCommitSha(SHA)).toBe(true);
    expect(isValidCommitSha("b".repeat(64))).toBe(true);
    expect(isValidCommitSha("a".repeat(39))).toBe(false);
    expect(isValidCommitSha("z".repeat(40))).toBe(false);
    expect(isValidCommitSha(undefined)).toBe(false);
  });
});

describe("pullRequestRef", () => {
  it("builds the ref format the endpoint documents", () => {
    expect(pullRequestRef(7)).toBe("refs/pull/7/head");
  });
});
