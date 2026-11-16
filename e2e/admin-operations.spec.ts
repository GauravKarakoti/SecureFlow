import { test, expect } from "./fixtures";

test.describe("Admin queue operations", () => {
  test("admin can cancel a waiting queue job", async ({ page }) => {
    await page.goto("/admin/queue");
    await expect(page.getByText("queue-test-repo")).toBeVisible();
    await page.getByTitle("Remove from queue").click();
    await expect(page.getByText("queue-test-repo")).toHaveCount(0);
    await expect(page.getByText("Job Removed", { exact: true })).toBeVisible();
  });

  test("admin can retry a failed DLQ job", async ({ page }) => {
    await page.goto("/admin/queue");
    await expect(page.getByRole("heading", { name: /dead-letter queue/i })).toBeVisible();
    await expect(page.getByText("mock-owner/mock-repo")).toBeVisible();
    await page.getByTitle("Requeue Job").first().click();
    await expect(page.getByText("Job Requeued")).toBeVisible();
  });
});

test.describe("Admin audit log operations", () => {
  test("admin can search and filter audit logs", async ({ page }) => {
    await page.goto("/admin/logs");
    const search = page.getByPlaceholder("Search action, resource, decision, or actor...");
    await expect(search).toBeVisible();
    await search.fill("nonexistent-e2e-search");
    await expect(page.getByText("No audit logs match your filters.")).toBeVisible();
    await page.getByRole("button", { name: "Clear" }).click();
    await expect(search).toHaveValue("");
  });

  test("admin can filter audit logs by action", async ({ page }) => {
    await page.goto("/admin/logs");
    const actionFilter = page.locator("select").first();
    await expect(actionFilter.locator('option[value="UPDATE_ROLE"]')).toHaveCount(1);
    await actionFilter.selectOption("UPDATE_ROLE");
    await expect(actionFilter).toHaveValue("UPDATE_ROLE");
  });

  test("admin can filter audit logs by another action", async ({ page }) => {
    await page.goto("/admin/logs");
    const actionFilter = page.locator("select").first();
    await actionFilter.selectOption("DELETE_USER");
    await expect(actionFilter).toHaveValue("DELETE_USER");
  });
});

test.describe("Admin user management", () => {
  test("admin can change another user's role", async ({ page }) => {
    await page.goto("/admin/users");
    const userRow = page.getByRole("row").filter({ hasText: "Rio Developer" });
    await expect(userRow).toBeVisible();
    const roleSelect = userRow.getByTitle("Change role");
    await expect(roleSelect).toHaveValue("USER");
    await roleSelect.selectOption("ADMIN");
    await expect(roleSelect).toHaveValue("ADMIN");
  });

  test("admin cannot change their own role", async ({ page }) => {
    await page.goto("/admin/users");
    const adminRow = page.getByRole("row").filter({ hasText: "Mock Admin" });
    await expect(adminRow).toBeVisible();
    const roleSelect = adminRow.getByTitle("You cannot change your own role");
    await expect(roleSelect).toBeDisabled();
  });
});
