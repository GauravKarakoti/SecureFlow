import { expect, setMockSession, test } from "./fixtures";

test.describe("Repository sync API", () => {
  test("rejects unauthenticated requests", async ({ page, baseURL }) => {
    await setMockSession(page, "none", baseURL);

    const res = await page.request.post("/api/repositories/sync");

    expect([401, 403]).toContain(res.status());
  });

  test("does not error for an authenticated admin", async ({ page }) => {
    const res = await page.request.post("/api/repositories/sync");

    expect(res.status()).toBeLessThan(500);
    expect(res.status()).not.toBe(401);
  });
});
