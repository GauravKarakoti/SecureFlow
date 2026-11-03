import { expect, test } from "@playwright/test";
import { setMockSession } from "./fixtures";

test.describe("Compliance Export API E2E (#1524)", () => {
  test("rejects unauthenticated requests with 401 Unauthorized", async ({ request }) => {
    // Making request without auth cookies
    const res = await request.get("/api/compliance/export");
    expect(res.status()).toBe(401);
    const json = await res.json();
    expect(json.error).toMatch(/unauthorized/i);
  });

  test("rejects export with invalid date query parameters", async ({ page, baseURL }) => {
    await setMockSession(page, "admin", baseURL);

    const res = await page.request.get("/api/compliance/export?from=invalid-date-format");
    expect(res.status()).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/invalid.*date|from/i);
  });

  test("exports default JSON compliance dossier for authorized admin", async ({
    page,
    baseURL,
  }) => {
    await setMockSession(page, "admin", baseURL);

    const res = await page.request.get("/api/compliance/export");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/json");
    expect(res.headers()["x-compliance-report-id"]).toBeDefined();

    const data = await res.json();
    expect(data).toHaveProperty("reportId");
    expect(data).toHaveProperty("generatedAt");
    expect(data).toHaveProperty("summary");
    expect(data.summary).toHaveProperty("totalFindings");
  });

  test("exports compliance report in SARIF format with valid schema and headers", async ({
    page,
    baseURL,
  }) => {
    await setMockSession(page, "admin", baseURL);

    const res = await page.request.get("/api/compliance/export?format=sarif");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/sarif+json");
    expect(res.headers()["content-disposition"]).toContain(".sarif");
    expect(res.headers()["x-compliance-findings-count"]).toBeDefined();

    const sarif = await res.json();
    expect(sarif).toHaveProperty("version", "2.1.0");
    expect(sarif).toHaveProperty("runs");
    expect(Array.isArray(sarif.runs)).toBe(true);
    if (sarif.runs.length > 0) {
      expect(sarif.runs[0]).toHaveProperty("tool");
      expect(sarif.runs[0].tool.driver.name).toBe("SecureFlow");
    }
  });

  test("exports printable PDF/HTML compliance dossier with executive styling", async ({
    page,
    baseURL,
  }) => {
    await setMockSession(page, "admin", baseURL);

    const res = await page.request.get("/api/compliance/export?format=html");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");
    expect(res.headers()["content-disposition"]).toContain(".html");
    expect(res.headers()["x-compliance-report-id"]).toBeDefined();

    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("SecureFlow Compliance");
    expect(html).toContain("Executive Audit Dossier");
  });

  test("supports filtering compliance exports by repository and framework", async ({
    page,
    baseURL,
  }) => {
    await setMockSession(page, "admin", baseURL);

    const res = await page.request.get(
      "/api/compliance/export?framework=SOC2&repositoryId=repo_test_123&limit=50",
    );
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("reportId");
    expect(data).toHaveProperty("filters");
    expect(data.filters.framework).toBe("SOC2");
    expect(data.filters.repositoryId).toBe("repo_test_123");
  });
});
