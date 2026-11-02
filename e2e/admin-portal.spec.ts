import { expect, test } from "./fixtures";

test.describe("Admin Portal Management & Observability (#1332)", () => {
  test("renders Admin Dashboard Overview with metrics and audit activity", async ({
    page,
    baseURL,
  }) => {
    await page.goto(`${baseURL ?? "http://localhost:9002"}/admin`);

    // Verify layout header and system control branding
    await expect(page.getByText("SecureFlow System Control").first()).toBeVisible({
      timeout: 15_000,
    });

    // Verify main overview header
    await expect(page.getByRole("heading", { name: "Dashboard Overview" })).toBeVisible();
    await expect(page.getByText("Total Users")).toBeVisible();
    await expect(page.getByText("Pull Requests Scanned")).toBeVisible();
    await expect(page.getByText("Audit Logs").first()).toBeVisible();

    // Verify recent audit activity section
    await expect(page.getByRole("heading", { name: "Recent Audit Activity" })).toBeVisible();
  });

  test("navigates to Queue Monitor and displays BullMQ pipeline metrics & DLQ", async ({
    page,
    baseURL,
  }) => {
    await page.goto(`${baseURL ?? "http://localhost:9002"}/admin/queue`);

    await expect(page.getByRole("heading", { name: "Queue Monitor" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText(/Real-time observability of the BullMQ async processing pipelines/i),
    ).toBeVisible();

    // Verify queue status metric cards
    await expect(page.getByText("Waiting")).toBeVisible();
    await expect(page.getByText("Active")).toBeVisible();
    await expect(page.getByText("Completed")).toBeVisible();
    await expect(page.getByText("Failed (DLQ)")).toBeVisible();
    await expect(page.getByText("Delayed")).toBeVisible();

    // Verify Dead-Letter Queue section and controls
    await expect(page.getByRole("heading", { name: "Dead-Letter Queue (DLQ)" })).toBeVisible();
    await expect(page.getByPlaceholder("Filter DLQ jobs by repo, event, action...")).toBeVisible();
  });

  test("navigates to User Management and displays metrics and user directory", async ({
    page,
    baseURL,
  }) => {
    await page.goto(`${baseURL ?? "http://localhost:9002"}/admin/users`);

    await expect(page.getByRole("heading", { name: "User Management" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText("Manage user roles, access levels, and account status across SecureFlow."),
    ).toBeVisible();

    // Verify user management metric cards
    await expect(page.getByText("Total Users")).toBeVisible();
    await expect(page.getByText("Administrators")).toBeVisible();
    await expect(page.getByText("New (24h)")).toBeVisible();
  });

  test("navigates to Audit Logs and supports system log filtering", async ({ page, baseURL }) => {
    await page.goto(`${baseURL ?? "http://localhost:9002"}/admin/logs`);

    await expect(page.getByRole("heading", { name: "Audit Logs" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText("Comprehensive audit trail of every administrative and system event."),
    ).toBeVisible();

    // Verify audit log metrics
    await expect(page.getByText("Total Logs")).toBeVisible();
    await expect(page.getByText("Last 24 Hours")).toBeVisible();
    await expect(page.getByText("Top Action")).toBeVisible();
  });
});
