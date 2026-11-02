import { test, expect, setMockSession } from "./fixtures";

const ADMIN_ROUTES = ["/admin", "/admin/queue", "/admin/users", "/admin/logs"];

test.describe("Admin portal RBAC", () => {
  for (const role of ["none", "user"] as const) {
    for (const route of ADMIN_ROUTES) {
      test(`${role} session visiting ${route} is redirected away`, async ({ page, baseURL }) => {
        await setMockSession(page, role, baseURL);
        await page.goto(route);
        await page.waitForURL((url) => !url.pathname.startsWith("/admin"), {
          timeout: 15_000,
        });
        await expect(page.getByText("SecureFlow System Control")).toBeHidden();
        await expect(page.getByRole("heading", { name: "Dashboard Overview" })).toBeHidden();
      });
    }
  }
});
