import { test, expect } from '@playwright/test';

test.describe('Admin Panel', () => {
  test.beforeEach(async ({ context }) => {
    // Set the cookie to make the middleware and auth wrapper recognize the mock admin session.
    await context.addCookies([
      {
        name: 'mock-session',
        value: 'admin',
        domain: 'localhost',
        path: '/',
      },
    ]);
  });

  test('admin dashboard renders correctly', async ({ page }) => {
    await page.goto('/admin');

    await expect(page.getByRole('heading', { name: 'Dashboard Overview' })).toBeVisible();
    await expect(page.getByText('System-wide metrics and administrative analytics.')).toBeVisible();
    await expect(page.getByText('Total Users')).toBeVisible();
    await expect(page.getByText('Pull Requests Scanned')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Audit Logs' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Recent Audit Activity' })).toBeVisible();
  });

  test('user management renders and shows users', async ({ page }) => {
    await page.goto('/admin/users');

    await expect(page.getByRole('heading', { name: 'User Management' })).toBeVisible();
    await expect(page.getByText('Total Users')).toBeVisible();
    await expect(page.getByText('Administrators')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Mock Admin' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Rio Developer' })).toBeVisible();
  });

  test('audit logs page renders and shows log entries', async ({ page }) => {
    await page.goto('/admin/logs');

    await expect(page.getByRole('heading', { name: 'Audit Logs' })).toBeVisible();
    await expect(page.getByText('Total Logs')).toBeVisible();
    await expect(page.getByText('Last 24 Hours')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'UPDATE_ROLE' }).first()).toBeVisible();
    await expect(page.getByRole('cell', { name: 'DELETE_USER' }).first()).toBeVisible();
  });

  test('queue monitor page renders and shows job metrics', async ({ page }) => {
    await page.goto('/admin/queue');

    await expect(page.getByRole('heading', { name: 'Queue Monitor' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Waiting' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Active' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Completed' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Failed (DLQ)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Delayed' })).toBeVisible();
  });
});
