import { describe, it, expect, vi, afterEach } from "vitest";
import {
  assertSlackWebhookUrl,
  packSectionBodies,
  SLACK_SECTION_TEXT_LIMIT,
  SLACK_ALERT_THRESHOLD,
  buildSlackAlert,
  describeFlaggedFindings,
  findingsAboveThreshold,
  notifyHighSeverityFindings,
  pullRequestUrl,
  sendSlackAlert,
  type AlertFinding,
} from "./slack";
// Imported separately so parallel changes to the list above do not collide.
import { escapeSlackText } from "./slack";

describe("assertSlackWebhookUrl", () => {
  it("accepts a valid Slack Incoming Webhook URL", () => {
    const url = assertSlackWebhookUrl("https://hooks.slack.com/services/T000/B000/XXXX");
    expect(url.href).toBe("https://hooks.slack.com/services/T000/B000/XXXX");
  });

  it("trims surrounding whitespace", () => {
    const url = assertSlackWebhookUrl("  https://hooks.slack.com/services/T000/B000/XXXX  ");
    expect(url.href).toBe("https://hooks.slack.com/services/T000/B000/XXXX");
  });

  it("rejects non-string or empty input", () => {
    expect(() => assertSlackWebhookUrl("")).toThrow("Slack webhook URL is missing.");
    expect(() => assertSlackWebhookUrl("   ")).toThrow("Slack webhook URL is missing.");
    expect(() => assertSlackWebhookUrl(null as unknown as string)).toThrow(
      "Slack webhook URL is missing.",
    );
  });

  it("rejects malformed URL format", () => {
    expect(() => assertSlackWebhookUrl("not a url")).toThrow("Invalid Slack webhook URL format.");
  });

  it.each([
    ["http", "http://hooks.slack.com/services/T000/B000/XXXX"],
    ["ftp", "ftp://hooks.slack.com/services/T000/B000/XXXX"],
    ["file", "file:///services/T000/B000/XXXX"],
  ])("rejects non-HTTPS scheme: %s", (_scheme, raw) => {
    expect(() => assertSlackWebhookUrl(raw)).toThrow(/only https is allowed/);
  });

  it.each([
    ["arbitrary domain", "https://evil.example.com/services/T000/B000/XXXX"],
    ["subdomain suffix", "https://hooks.slack.com.evil.example/services/T000/B000/XXXX"],
    ["attacker subdomain", "https://evil.hooks.slack.com/services/T000/B000/XXXX"],
    ["IPv4 loopback", "https://127.0.0.1/services/T000/B000/XXXX"],
    ["localhost", "https://localhost/services/T000/B000/XXXX"],
    ["private 10.0.0.0/8", "https://10.0.0.1/services/T000/B000/XXXX"],
    ["cloud metadata", "https://169.254.169.254/services/T000/B000/XXXX"],
    ["IPv6 loopback", "https://[::1]/services/T000/B000/XXXX"],
    ["IPv6 link-local", "https://[fe80::1]/services/T000/B000/XXXX"],
  ])("rejects non-slack hostname: %s", (_label, raw) => {
    expect(() => assertSlackWebhookUrl(raw)).toThrow(/only hooks\.slack\.com is allowed/);
  });

  it("rejects embedded credentials", () => {
    expect(() =>
      assertSlackWebhookUrl("https://user:pass@hooks.slack.com/services/T000/B000/XXXX"),
    ).toThrow("Slack webhook URL must not embed credentials.");
  });

  it("rejects custom ports", () => {
    expect(() =>
      assertSlackWebhookUrl("https://hooks.slack.com:8080/services/T000/B000/XXXX"),
    ).toThrow("Slack webhook URL must not specify a custom port.");
  });

  it.each([
    ["root path", "https://hooks.slack.com/"],
    ["non-services path", "https://hooks.slack.com/not-services/T000/B000/XXXX"],
    ["api endpoint", "https://hooks.slack.com/api/chat.postMessage"],
  ])("rejects invalid path: %s", (_label, raw) => {
    expect(() => assertSlackWebhookUrl(raw)).toThrow(
      "Slack webhook URL path must start with /services/.",
    );
  });

  it.each([
    ["query string", "https://hooks.slack.com/services/T000/B000/XXXX?token=secret"],
    ["fragment", "https://hooks.slack.com/services/T000/B000/XXXX#section"],
  ])("rejects unexpected URL components: %s", (_label, raw) => {
    expect(() => assertSlackWebhookUrl(raw)).toThrow(
      "Slack webhook URL must not include query parameters or fragments.",
    );
  });
});

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
    expect(serialized).toContain("1 critical-severity finding");
  });

  it("labels the heading with the severities present, not the threshold", () => {
    const message = buildSlackAlert({
      repositoryFullName: "acme/widgets",
      prNumber: 7,
      findings: [
        finding({ severity: "CRITICAL" }),
        finding({ severity: "CRITICAL" }),
        finding({ severity: "HIGH" }),
        finding({ severity: "LOW" }),
      ],
    });

    expect(message!.text).toBe("🛡️ SecureFlow: 3 findings (2 critical, 1 high) in acme/widgets#7");
    expect(JSON.stringify(message!.blocks)).not.toContain("high-severity findings");
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

describe("describeFlaggedFindings", () => {
  it("names the single severity when every finding shares it", () => {
    expect(describeFlaggedFindings([finding({ severity: "HIGH" })])).toBe(
      "1 high-severity finding",
    );
    expect(
      describeFlaggedFindings([
        finding({ severity: "CRITICAL" }),
        finding({ severity: "CRITICAL" }),
      ]),
    ).toBe("2 critical-severity findings");
  });

  it("breaks a mixed set down from most to least severe", () => {
    expect(
      describeFlaggedFindings([
        finding({ severity: "HIGH" }),
        finding({ severity: "CRITICAL" }),
        finding({ severity: "HIGH" }),
      ]),
    ).toBe("3 findings (1 critical, 2 high)");
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

  describe("SSRF bypass prevention", () => {
    it.each([
      ["IPv4 loopback", "https://127.0.0.1/services/x"],
      ["localhost", "https://localhost/services/x"],
      ["private 10.0.0.0/8", "https://10.0.0.1/services/x"],
      ["cloud metadata", "https://169.254.169.254/services/x"],
      ["IPv6 loopback", "https://[::1]/services/x"],
      ["arbitrary public host", "https://evil.example.com/services/x"],
      ["subdomain suffix", "https://hooks.slack.com.evil.example/services/x"],
      ["insecure HTTP", "http://hooks.slack.com/services/x"],
      ["embedded credentials", "https://user:pass@hooks.slack.com/services/x"],
      ["custom port", "https://hooks.slack.com:8443/services/x"],
      ["invalid path", "https://hooks.slack.com/api/chat.postMessage"],
      ["query parameters", "https://hooks.slack.com/services/x?foo=bar"],
    ])("rejects SSRF destination (%s) and avoids network dispatch", async (_label, url) => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const result = await sendSlackAlert(url, { text: "hi", blocks: [] });

      expect(result).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("never logs the secret webhook token on failure", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const secretUrl = "https://hooks.slack.com/services/T12345/B67890/SECRETTOKENVAL123";

      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network failure"));

      const result = await sendSlackAlert(secretUrl, { text: "hi", blocks: [] });
      expect(result).toBe(false);

      const loggedCalls = consoleSpy.mock.calls.flat().map(String).join(" ");
      expect(loggedCalls).not.toContain("SECRETTOKENVAL123");
      expect(loggedCalls).not.toContain("T12345/B67890");
    });
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

  it("safely rejects malicious or SSRF URLs without calling fetch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const sent = await notifyHighSeverityFindings("http://127.0.0.1:8080/services/x", {
      repositoryFullName: "acme/widgets",
      prNumber: 1,
      findings: [finding({ severity: "CRITICAL" })],
    });

    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("escapeSlackText", () => {
  it("escapes the three characters Slack's mrkdwn treats as control characters", () => {
    expect(escapeSlackText("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
  });

  it("escapes & first so existing entities are not double-decoded", () => {
    expect(escapeSlackText("&lt;!channel&gt;")).toBe("&amp;lt;!channel&amp;gt;");
  });
});

describe("buildSlackAlert escaping", () => {
  function findingsText(overrides: Partial<AlertFinding>) {
    const message = buildSlackAlert({
      repositoryFullName: "acme/widgets",
      prNumber: 3,
      findings: [finding(overrides)],
    });
    const blocks = message!.blocks as Array<{ type: string; text?: { text: string } }>;
    return blocks[2]!.text!.text;
  }

  it("cannot be made to mention the whole channel by the code under review", () => {
    const text = findingsText({
      description: "Hardcoded token <!channel> please rotate",
    });

    expect(text).not.toContain("<!channel>");
    expect(text).toContain("&lt;!channel&gt;");
  });

  it("cannot be made to render a spoofed link", () => {
    const text = findingsText({
      explanation: "Fix at <https://evil.example/login|github.com/acme/widgets>",
    });

    expect(text).not.toMatch(/<https:\/\/evil/);
  });

  it("escapes the finding type and file location too", () => {
    const text = findingsText({ type: "XSS <script>", fileLocation: "src/a&b.tsx" });

    expect(text).toContain("*XSS &lt;script&gt;*");
    expect(text).toContain("`src/a&amp;b.tsx`");
  });

  it("keeps the PR link in the heading clickable", () => {
    const message = buildSlackAlert({
      repositoryFullName: "acme/widgets",
      prNumber: 3,
      findings: [finding()],
    });

    expect(JSON.stringify(message!.blocks)).toContain(
      "<https://github.com/acme/widgets/pull/3|acme/widgets#3>",
    );
  });
});

describe("Block Kit section limits", () => {
  /** A finding whose rendered line lands near the 300-character summary cap. */
  function bigFinding(i: number) {
    return {
      type: "HARDCODED_SECRET",
      severity: "CRITICAL" as const,
      fileLocation: `packages/services/billing/src/internal/handlers/webhook-${i}.ts`,
      explanation: "A".repeat(600),
    };
  }

  function sectionTexts(message: { blocks: unknown[] }): string[] {
    return message.blocks
      .filter((b) => (b as { type?: string }).type === "section")
      .map((b) => (b as { text: { text: string } }).text.text);
  }

  it("keeps every section under Slack's text limit for a full page of findings", () => {
    // Ten findings at the summary cap came to roughly 4,000 characters in one
    // section. Slack answers 400 invalid_blocks and drops the whole message, so
    // the alert reporting the most findings was the one that never arrived.
    const message = buildSlackAlert({
      repositoryFullName: "acme/app",
      prNumber: 42,
      findings: Array.from({ length: 12 }, (_, i) => bigFinding(i)),
    });

    expect(message).not.toBeNull();
    for (const text of sectionTexts(message!)) {
      expect(text.length).toBeLessThanOrEqual(SLACK_SECTION_TEXT_LIMIT);
    }
  });

  it("splits rather than drops: every listed finding still appears", () => {
    const message = buildSlackAlert({
      repositoryFullName: "acme/app",
      prNumber: 42,
      findings: Array.from({ length: 12 }, (_, i) => bigFinding(i)),
    });

    const body = sectionTexts(message!).join("\n\n");
    // MAX_LISTED_FINDINGS is 10, and the remaining two are reported as a count.
    for (let i = 0; i < 10; i++) {
      expect(body).toContain(`webhook-${i}.ts`);
    }
    expect(body).toContain("_…and 2 more._");
  });

  it("still emits a single section when everything fits", () => {
    const message = buildSlackAlert({
      repositoryFullName: "acme/app",
      prNumber: 42,
      findings: [
        {
          type: "HARDCODED_SECRET",
          severity: "CRITICAL",
          fileLocation: "src/a.ts",
          explanation: "short",
        },
      ],
    });

    // The heading section plus one findings section — no extra blocks.
    expect(sectionTexts(message!)).toHaveLength(2);
  });
});

describe("packSectionBodies", () => {
  it("packs as many lines per body as fit", () => {
    expect(packSectionBodies(["aaa", "bbb", "ccc"], 100)).toEqual(["aaa\n\nbbb\n\nccc"]);
  });

  it("starts a new body when the separator would push it over", () => {
    // "aaaa" + "\n\n" + "bbbb" is 10, which is over a limit of 9.
    expect(packSectionBodies(["aaaa", "bbbb"], 9)).toEqual(["aaaa", "bbbb"]);
  });

  it("clips a single line that cannot fit anywhere, rather than dropping it", () => {
    const [body] = packSectionBodies(["x".repeat(50)], 10);
    expect(body).toHaveLength(10);
    expect(body.endsWith("…")).toBe(true);
  });

  it("returns nothing for no lines", () => {
    expect(packSectionBodies([], 100)).toEqual([]);
  });

  it("defaults to Slack's limit", () => {
    const [body] = packSectionBodies(["y".repeat(SLACK_SECTION_TEXT_LIMIT + 100)]);
    expect(body.length).toBe(SLACK_SECTION_TEXT_LIMIT);
  });
});
