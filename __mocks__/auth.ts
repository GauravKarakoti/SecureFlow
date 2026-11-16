/**
 * Mock Auth.js / NextAuth Module (Security Audit Cleaned - #1303)
 *
 * Ensures all session mocks return safe, sanitized dummy profiles and tokens
 * without any hardcoded production secrets, session keys, or private credentials.
 */
import { vi } from "vitest";
import { SAFE_MOCK_SESSION } from "./next-auth/index.js";

export { SAFE_MOCK_SESSION };
export const SAFE_MOCK_AUTH_SESSION = SAFE_MOCK_SESSION;

export const auth =
  (handler?: any) =>
  async (req?: any, ...args: any[]) => {
    if (typeof handler === "function") {
      return handler(req, ...args);
    }
    return SAFE_MOCK_SESSION;
  };

export const signIn = vi.fn();
export const signOut = vi.fn();
export const handlers = {};
