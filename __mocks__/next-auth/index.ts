/**
 * Mock next-auth Module (Security Audit Cleaned - #1303, #1354)
 *
 * This mock ensures test suites run with synthetic authentication context
 * without requiring or storing hardcoded OAuth tokens, client secrets, or user credentials.
 */
import { vi } from "vitest";
import { SAFE_MOCK_SESSION } from "../../tests/fixtures/mock-session";
export { SAFE_MOCK_SESSION };

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
