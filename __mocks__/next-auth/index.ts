/**
 * Mock next-auth Module (Security Audit Cleaned - #1303, #1354)
 *
 * This mock ensures test suites run with synthetic authentication context
 * without requiring or storing hardcoded OAuth tokens, client secrets, or user credentials.
 */
import { vi } from "vitest";

export const SAFE_MOCK_SESSION = Object.freeze({
  user: {
    id: "mock_test_user_id",
    name: "Mock Security Engineer",
    email: "mock-user@secureflow.internal.test",
    image: null,
  },
  expires: "2099-01-01T00:00:00.000Z",
});

export const auth = vi.fn(async () => SAFE_MOCK_SESSION);
export const signIn = vi.fn();
export const signOut = vi.fn();
export const useSession = vi.fn(() => ({
  data: SAFE_MOCK_SESSION,
  status: "authenticated",
}));
export const SessionProvider = ({ children }: { children: unknown }) => children;

const NextAuth = vi.fn(() => ({
  handlers: { GET: vi.fn(), POST: vi.fn() },
  auth,
  signIn,
  signOut,
}));

export default NextAuth;
