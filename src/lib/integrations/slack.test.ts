import { describe, it, expect, vi, afterEach } from "vitest";
import {
  SLACK_ALERT_THRESHOLD,
  buildSlackAlert,
  findingsAboveThreshold,
  notifyHighSeverityFindings,
  pullRequestUrl,
  sendSlackAlert,
  type AlertFinding,
} from "./slack";

function finding(overrides: Partial<AlertFinding> = {}): AlertFinding {
  return {
    type: "Secret",
    severity: "CRITICAL",
    fileLocation: "src/config.ts",
    description: "Hardcoded API key",
    ...overrides,
  };
}

describe("findingsAboveThreshold", () => {
  it("keeps CRITICAL and HIGH, drops the rest", () => {
    const findings = [
      finding({ severity: "CRITICAL" }),
      finding({ severity: "HIGH" }),
      finding({ severity: "MEDIUM" }),
      finding({ severity: "LOW" }),
      finding({ severity: "NONE" }),
    ];

    const kept = findingsAboveThreshold(findings);

    expect(kept.map((f) => f.severity)).toEqual(["CRITICAL", "HIGH"]);
  });

  it("defaults to the HIGH threshold", () => {
    expect(SLACK_ALERT_THRESHOLD).toBe("HIGH");
    expect(findingsAboveThreshold([finding({ severity: "MEDIUM" })])).toEqual([]);
  });

  it("respects custom severity threshold", () => {
    const findings = [
      finding({ severity: "CRITICAL" }),
      finding({ severity: "HIGH" }),
      finding({ severity: "MEDIUM" }),
    ];
    expect(findingsAboveThreshold(findings, "CRITICAL").map((f) => f.severity)).toEqual([
      "CRITICAL",
    ]);
    expect(findingsAboveThreshold(findings, "MEDIUM").map((f) => f.severity)).toEqual([
      "CRITICAL",
      "HIGH",
      "MEDIUM",
    ]);
  });
});

describe("pullRequestUrl", () => {
  it("builds the canonical GitHub PR URL", () => {
    expect(pullRequestUrl("acme/widgets", 42)).toBe("https://github.com/acme/widgets/pull/42");
  });
});

describe("buildSlackAlert", () => {
  it("returns null when nothing clears the threshold", () => {
    expect(
      buildSlackAlert({
        repositoryFullName: "acme/widgets",
        prNumber: 7,
        findings: [finding({ severity: "MEDIUM" }), finding({ severity: "LOW" })],
      }),
    ).toBeNull();
  });

  it("summarises high-severity findings with a PR link", () => {
    const message = buildSlackAlert({
      repositoryFullName: "acme/widgets",
      prNumber: 7,
      findings: [finding({ severity: "CRITICAL", fileLocation: "src/db.ts" })],
    });

    expect(message).not.toBeNull();
    expect(message!.text).toContain("acme/widgets#7");
    const serialized = JSON.stringify(message!.blocks);
    expect(serialized).toContain("https://github.com/acme/widgets/pull/7");
    expect(serialized).toContain("src/db.ts");
    expect(serialized).toContain("1 high-severity finding");
  });

  it("masks secrets in the summary line", () => {
    const message = buildSlackAlert({
      repositoryFullName: "acme/widgets",
      prNumber: 1,
      findings: [
        finding({
          explanation: "Key AKIAIOSFODNN7EXAMPLE is exposed",
        }),
      ],
    });

    const serialized = JSON.stringify(message!.blocks);
    expect(serialized).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("notes overflow when there are many findings", () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      finding({ severity: "HIGH", fileLocation: `src/f${i}.ts` }),
    );

    const message = buildSlackAlert({
      repositoryFullName: "acme/widgets",
      prNumber: 2,
      findings: many,
    });

    expect(JSON.stringify(message!.blocks)).toContain("and 3 more");
  });

  it("respects custom minSeverity threshold in alert building", () => {
    const message = buildSlackAlert({
      repositoryFullName: "acme/widgets",
      prNumber: 7,
      findings: [finding({ severity: "HIGH" }), finding({ severity: "CRITICAL" })],
      minSeverity: "CRITICAL",
    });

    expect(message).not.toBeNull();
    expect(message!.text).toContain("1 critical-severity finding");
  });
});

describe("sendSlackAlert", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns true on a 2xx", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    const ok = await sendSlackAlert("https://hooks.slack.com/services/x", {
      text: "hi",
      blocks: [],
    });

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns false on a non-2xx without throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));
    await expect(
      sendSlackAlert("https://hooks.slack.com/services/x", { text: "hi", blocks: [] }),
    ).resolves.toBe(false);
  });

  it("returns false when fetch rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    await expect(
      sendSlackAlert("https://hooks.slack.com/services/x", { text: "hi", blocks: [] }),
    ).resolves.toBe(false);
  });
});

describe("notifyHighSeverityFindings", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends nothing when no webhook is configured", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const sent = await notifyHighSeverityFindings(null, {
      repositoryFullName: "acme/widgets",
      prNumber: 1,
      findings: [finding()],
    });
    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends nothing when the webhook is blank", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const sent = await notifyHighSeverityFindings("   ", {
      repositoryFullName: "acme/widgets",
      prNumber: 1,
      findings: [finding()],
    });
    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends nothing when no finding clears the threshold", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const sent = await notifyHighSeverityFindings("https://hooks.slack.com/services/x", {
      repositoryFullName: "acme/widgets",
      prNumber: 1,
      findings: [finding({ severity: "LOW" })],
    });
    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to the trimmed webhook when a finding qualifies", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    const sent = await notifyHighSeverityFindings("  https://hooks.slack.com/services/x  ", {
      repositoryFullName: "acme/widgets",
      prNumber: 1,
      findings: [finding({ severity: "CRITICAL" })],
    });

    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hooks.slack.com/services/x",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("respects custom minSeverity when notifying", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    const sent = await notifyHighSeverityFindings(
      "https://hooks.slack.com/services/x",
      {
        repositoryFullName: "acme/widgets",
        prNumber: 1,
        findings: [finding({ severity: "HIGH" })],
      },
      "CRITICAL",
    );

    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
