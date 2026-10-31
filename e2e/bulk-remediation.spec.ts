import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

const PROGRESS_URL = "**/api/findings/bulk-remediate/progress**";

const sse = (...events: Array<object | string>) =>
  events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");

/** Enter bulk mode and select the SECRET finding. Seed data mixes types, so a
 *  homogeneous selection is required before patch generation is enabled. */
async function selectHomogeneousFinding(page: Page) {
  await page.goto("/dashboard/findings", { waitUntil: "domcontentloaded" });

  const toolbar = page.getByTestId("findings-toolbar");
  const bulkToggle = toolbar.getByRole("button", { name: "Bulk select" });

  // Retry the click in case it lands before React has hydrated.
  await expect(async () => {
    await bulkToggle.click({ timeout: 3_000 });
    await expect(toolbar.getByRole("button", { name: "Cancel bulk select" })).toBeVisible({
      timeout: 3_000,
    });
  }).toPass({ timeout: 45_000 });

  await page.getByLabel("Select finding in src/config/secrets.ts").check();
  await expect(page.getByTestId("bulk-remediation-bar")).toBeVisible();
}

test.describe("Bulk Remediation (#1447)", () => {
  test("selecting findings shows the bulk remediation bar", async ({ page }) => {
    await selectHomogeneousFinding(page);

    await expect(page.getByRole("heading", { name: "Bulk Remediation" })).toBeVisible();
    await expect(page.getByTestId("generate-bulk-patch-button")).toBeEnabled();
  });

  test("multi-select of mixed vulnerability types disables patch generation", async ({ page }) => {
    await selectHomogeneousFinding(page);
    await page.getByLabel("Select finding in package.json").check();

    await expect(page.getByTestId("bulk-remediation-mixed-warning")).toBeVisible();
    await expect(page.getByTestId("generate-bulk-patch-button")).toBeDisabled();
  });

  test("shows progress while generating, then the combined patch", async ({ page }) => {
    await page.route(PROGRESS_URL, async (route) => {
      // Delay so the processing UI stays visible long enough to assert.
      await new Promise((r) => setTimeout(r, 1000));
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        },
        body: sse(
          {
            processed: 1,
            total: 1,
            progress: 50,
            status: "processing",
            message: "Remediating finding 1 of 1...",
          },
          {
            success: true,
            status: "completed",
            patchDiff: "+++ b/src/config/secrets.ts",
            patch: { patchDiff: "+++ b/src/config/secrets.ts", status: "GENERATED" },
            explanation: "Moved secret to env var",
            processed: 1,
            progress: 100,
          },
          "[DONE]",
        ),
      });
    });

    await selectHomogeneousFinding(page);
    await page.getByTestId("generate-bulk-patch-button").click();

    await expect(page.getByText("Initializing bulk patch generation...")).toBeVisible();
    await expect(page.getByText(/0 \/ 1 \(0%\)/)).toBeVisible();

    await expect(page.getByTestId("bulk-patch-review")).toBeVisible();
    await expect(page.getByText("Review Combined Patch")).toBeVisible();
    await expect(page.getByText("+++ b/src/config/secrets.ts")).toBeVisible();
    await expect(page.getByText(/git apply/)).toBeVisible();
  });

  test("progress request carries the selected finding ids", async ({ page }) => {
    let requestedUrl = "";
    await page.route(PROGRESS_URL, async (route) => {
      requestedUrl = route.request().url();
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sse({ status: "completed", patchDiff: "+++ b/x", explanation: "ok" }, "[DONE]"),
      });
    });

    await selectHomogeneousFinding(page);
    await page.getByTestId("generate-bulk-patch-button").click();
    await expect(page.getByTestId("bulk-patch-review")).toBeVisible();

    const url = new URL(requestedUrl);
    expect(url.pathname).toContain("/api/findings/bulk-remediate/progress");
    expect(url.searchParams.get("total")).toBe("1");
    expect(url.searchParams.get("ids")?.split(",")).toHaveLength(1);
  });

  test("closing the diff returns to the generate button", async ({ page }) => {
    await page.route(PROGRESS_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sse({ status: "completed", patchDiff: "+++ b/x", explanation: "ok" }, "[DONE]"),
      }),
    );

    await selectHomogeneousFinding(page);
    await page.getByTestId("generate-bulk-patch-button").click();
    await expect(page.getByTestId("bulk-patch-review")).toBeVisible();

    await page.getByRole("button", { name: /close diff/i }).click();
    await expect(page.getByTestId("bulk-patch-review")).toHaveCount(0);
    await expect(page.getByTestId("generate-bulk-patch-button")).toBeVisible();
  });

  test("shows an error when generation fails", async ({ page }) => {
    await page.route(PROGRESS_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sse({ status: "FAILED", error: "AI provider unavailable" }, "[DONE]"),
      }),
    );

    await selectHomogeneousFinding(page);
    await page.getByTestId("generate-bulk-patch-button").click();

    await expect(page.getByText("AI provider unavailable").first()).toBeVisible();
    await expect(page.getByTestId("bulk-patch-review")).toHaveCount(0);
  });
});
