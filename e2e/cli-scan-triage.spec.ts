import { test, expect } from "./fixtures";

/**
 * End-to-End test suite for:
 * 1. CLI scan payload ingestion (/api/cli/scan)
 * 2. Finding triage dismissal via dashboard UI and API
 * 3. Persistence of dismissal state on page reload
 *
 * Implements Issue #1555.
 */

test.describe("CLI Scan Upload & Finding Triage Dismissal E2E Suite", () => {
  test.describe("1. CLI Scan Upload API (/api/cli/scan)", () => {
    test("successfully ingests mock CLI scan payload and returns detected findings", async ({
      page,
    }) => {
      const payload = {
        files: [
          {
            path: "src/secrets/auth-token.ts",
            content: `export const GITHUB_SECRET = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";\n`,
          },
          {
            path: "src/server/database.ts",
            content: `export const DB_PASS = "postgres://admin:supersecretpassword123@db.prod.internal:5432/core";\n`,
          },
        ],
      };

      const response = await page.request.post("/api/cli/scan", {
        data: payload,
        headers: {
          "Content-Type": "application/json",
        },
      });

      expect(response.status()).toBe(200);
      const data = await response.json();

      expect(data).toHaveProperty("findings");
      expect(Array.isArray(data.findings)).toBe(true);
      expect(data.findings.length).toBeGreaterThan(0);

      // Verify structure of findings returned by scanner
      const secretFinding = data.findings.find(
        (f: { fileLocation?: string; type?: string }) =>
          f.fileLocation?.includes("auth-token.ts") || f.type === "SECRET",
      );
      expect(secretFinding).toBeDefined();
      expect(secretFinding).toHaveProperty("severity");
    });

    test("returns empty findings list for clean source code files", async ({ page }) => {
      const cleanPayload = {
        files: [
          {
            path: "src/utils/math.ts",
            content: `export function add(a: number, b: number): number { return a + b; }\n`,
          },
        ],
      };

      const response = await page.request.post("/api/cli/scan", {
        data: cleanPayload,
      });

      expect(response.status()).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("findings");
      expect(Array.isArray(data.findings)).toBe(true);
      expect(data.findings.length).toBe(0);
    });

    test("validates request schema and rejects empty files array with 400 Bad Request", async ({
      page,
    }) => {
      const invalidPayload = {
        files: [],
      };

      const response = await page.request.post("/api/cli/scan", {
        data: invalidPayload,
      });

      expect(response.status()).toBe(400);
      const data = await response.json();
      expect(data).toHaveProperty("error");
    });

    test("rejects malformed non-JSON body with 400 Bad Request", async ({ page }) => {
      const response = await page.request.post("/api/cli/scan", {
        headers: {
          "Content-Type": "application/json",
        },
        data: "{ invalid json string",
      });

      expect(response.status()).toBe(400);
      const data = await response.json();
      expect(data).toHaveProperty("error");
    });

    test("rejects payload when file path is missing or empty with 400", async ({ page }) => {
      const invalidPayload = {
        files: [
          {
            path: "",
            content: "some content",
          },
        ],
      };

      const response = await page.request.post("/api/cli/scan", {
        data: invalidPayload,
      });

      expect(response.status()).toBe(400);
      const data = await response.json();
      expect(data).toHaveProperty("error");
    });

    test("handles multiple mixed files and identifies findings only in vulnerable files", async ({
      page,
    }) => {
      const mixedPayload = {
        files: [
          {
            path: "src/config/safe-constants.ts",
            content: `export const TIMEOUT = 5000;\nexport const RETRY_ATTEMPTS = 3;\n`,
          },
          {
            path: "src/config/private-key.env",
            content: `export const GITHUB_TOKEN = "ghp_111122223333444455556666777788889999";\n`,
          },
        ],
      };

      const response = await page.request.post("/api/cli/scan", {
        data: mixedPayload,
      });

      expect(response.status()).toBe(200);
      const data = await response.json();
      expect(Array.isArray(data.findings)).toBe(true);
      expect(data.findings.length).toBeGreaterThan(0);
    });
  });

  test.describe("2. Dashboard Finding Triage & Dismissal Lifecycle", () => {
    test("navigates to findings page, views finding details, and dismisses via detail view", async ({
      page,
    }) => {
      // Step 1: Upload a scan finding via CLI scan API to verify ingestion pipeline
      const cliUpload = await page.request.post("/api/cli/scan", {
        data: {
          files: [
            {
              path: "src/config/secrets.ts",
              content: `export const API_KEY = "ghp_123456789012345678901234567890123456";\n`,
            },
          ],
        },
      });
      expect(cliUpload.status()).toBe(200);

      // Step 2: Open dashboard findings view
      await page.goto("/dashboard/findings", {
        waitUntil: "domcontentloaded",
      });

      // Verify findings list displays
      await expect(page.getByRole("heading", { name: "Security Findings" }).first()).toBeVisible();
      await expect(page.getByText("SECRET Detected").first()).toBeVisible();

      // Step 3: Navigate directly to the finding's detail page
      await page.goto("/dashboard/findings/finding-1", {
        waitUntil: "domcontentloaded",
      });

      // Assert detail page components are mounted
      await expect(page.getByText("SECRET Detected").first()).toBeVisible();
      await expect(page.getByText("Triage & Management")).toBeVisible();

      // Step 4: Dismiss finding by changing triage status to DISMISSED via detail actions
      const statusSelectTrigger = page.locator("#triage-status-select");
      await expect(statusSelectTrigger).toBeVisible();
      await statusSelectTrigger.click();

      // Select "Dismissed" from dropdown
      const dismissedOption = page.getByRole("option", { name: "Dismissed" });
      await expect(dismissedOption).toBeVisible();
      await dismissedOption.click();

      // Step 5: Fill in required triage note
      const triageNote = page.locator("#triage-note");
      await expect(triageNote).toBeVisible();
      const testDismissalReasonNote =
        "Verified false positive in staging environment; accepted risk for test fixture.";
      await triageNote.fill(testDismissalReasonNote);

      // Step 6: Save changes
      const saveButton = page.getByRole("button", { name: "Save Changes" });
      await expect(saveButton).toBeEnabled();
      await saveButton.click();

      // Verify toast notification appears
      await expect(page.getByText("Finding updated", { exact: true })).toBeVisible();

      // Step 7: Reload page to verify persistence of dismissal status and note
      await page.reload({ waitUntil: "domcontentloaded" });

      await expect(page.getByText("SECRET Detected").first()).toBeVisible();
      await expect(page.getByText("Triage & Management")).toBeVisible();

      // Verify current badge reflects Dismissed
      await expect(page.locator("#triage-status-select")).toHaveText(/Dismissed/i);
    });

    test("performs triage status change via REST API (/api/findings/[id]) and verifies UI persistence", async ({
      page,
    }) => {
      // 1. Ingest CLI scan payload
      const scanRes = await page.request.post("/api/cli/scan", {
        data: {
          files: [
            {
              path: "src/config/secrets.ts",
              content: `const TOKEN = "ghp_123456789012345678901234567890123456";\n`,
            },
          ],
        },
      });
      expect(scanRes.status()).toBe(200);

      // 2. Perform finding triage update via PATCH API with DISMISSED status & note
      const patchRes = await page.request.patch("/api/findings/finding-1", {
        headers: {
          "Content-Type": "application/json",
        },
        data: {
          triageStatus: "DISMISSED",
          note: "Dismissed via automated security triage review in E2E spec.",
        },
      });

      expect(patchRes.status()).toBe(200);
      const patchData = await patchRes.json();
      expect(patchData).toHaveProperty("id", "finding-1");

      // 3. Navigate to finding detail page and assert triage state reflects DISMISSED
      await page.goto("/dashboard/findings/finding-1", {
        waitUntil: "domcontentloaded",
      });

      await expect(page.locator("#triage-status-select")).toHaveText(/Dismissed/i);

      // 4. Reload page and assert persistence
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator("#triage-status-select")).toHaveText(/Dismissed/i);
    });

    test("reopening a dismissed finding restores OPEN status and persists on reload", async ({
      page,
    }) => {
      // Set to DISMISSED first via API
      await page.request.patch("/api/findings/finding-1", {
        headers: { "Content-Type": "application/json" },
        data: {
          triageStatus: "DISMISSED",
          note: "Dismissed temporarily.",
        },
      });

      // Navigate to finding detail page
      await page.goto("/dashboard/findings/finding-1", {
        waitUntil: "domcontentloaded",
      });

      // Change status back to Open
      const statusSelect = page.locator("#triage-status-select");
      await statusSelect.click();
      await page.getByRole("option", { name: "Open" }).click();

      // Fill update note
      const triageNote = page.locator("#triage-note");
      await triageNote.fill("Reopening finding after security audit confirmation.");

      // Save changes
      const saveBtn = page.getByRole("button", { name: "Save Changes" });
      await expect(saveBtn).toBeEnabled();
      await saveBtn.click();

      await expect(page.getByText("Finding updated", { exact: true })).toBeVisible();

      // Reload and assert OPEN status persists
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator("#triage-status-select")).toHaveText(/Open/i);
    });

    test("dismissing finding as FALSE_POSITIVE displays proper badge and survives reload", async ({
      page,
    }) => {
      // Update via API first to test persistence roundtrip
      const patchRes = await page.request.patch("/api/findings/finding-1", {
        headers: { "Content-Type": "application/json" },
        data: {
          triageStatus: "FALSE_POSITIVE",
          note: "Marked as False Positive from unit test fixture.",
        },
      });
      expect(patchRes.status()).toBe(200);

      // Navigate to finding detail page
      await page.goto("/dashboard/findings/finding-1", {
        waitUntil: "domcontentloaded",
      });

      await expect(page.locator("#triage-status-select")).toHaveText(/False Positive/i);

      // Reload and assert False Positive status persists
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator("#triage-status-select")).toHaveText(/False Positive/i);
    });
  });

  test.describe("3. Finding Triage Validation & Edge Cases", () => {
    test("rejects PATCH on /api/findings/[id] with invalid triage status", async ({ page }) => {
      const res = await page.request.patch("/api/findings/finding-1", {
        data: {
          triageStatus: "INVALID_STATUS_VALUE",
        },
      });

      expect(res.status()).toBe(400);
      const data = await res.json();
      expect(data).toHaveProperty("error");
    });

    test("rejects PATCH on /api/findings/[id] with empty update body", async ({ page }) => {
      const res = await page.request.patch("/api/findings/finding-1", {
        data: {},
      });

      expect(res.status()).toBe(400);
      const data = await res.json();
      expect(data).toHaveProperty("error");
    });

    test("rejects PATCH on non-existent finding ID with 404 Not Found", async ({ page }) => {
      const res = await page.request.patch("/api/findings/non-existent-finding-uuid-9999", {
        data: {
          triageStatus: "DISMISSED",
          note: "Attempting triage on nonexistent row",
        },
      });

      expect(res.status()).toBe(404);
      const data = await res.json();
      expect(data).toHaveProperty("error");
    });

    test("allows adjusting finding severity alongside triage status", async ({ page }) => {
      const res = await page.request.patch("/api/findings/finding-1", {
        data: {
          triageStatus: "DISMISSED",
          severity: "MEDIUM",
          note: "Downgraded severity to MEDIUM and dismissed.",
        },
      });

      expect(res.status()).toBe(200);
      const data = await res.json();
      expect(data.severity).toBe("MEDIUM");

      // Verify on UI
      await page.goto("/dashboard/findings/finding-1", {
        waitUntil: "domcontentloaded",
      });

      await expect(page.locator("#triage-status-select")).toHaveText(/Dismissed/i);
      await expect(page.locator("#severity-select")).toHaveText(/Medium/i);
    });

    test("verifies GET /api/findings/[id] returns 404 for non-existent finding", async ({
      page,
    }) => {
      const res = await page.request.get("/api/findings/non-existent-finding-id-1234");
      expect(res.status()).toBe(404);
    });

    test("verifies GET /api/findings/[id] returns finding details for authenticated user", async ({
      page,
    }) => {
      const res = await page.request.get("/api/findings/finding-1");
      expect(res.status()).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty("id", "finding-1");
      expect(data).toHaveProperty("type", "SECRET");
    });
  });
});
