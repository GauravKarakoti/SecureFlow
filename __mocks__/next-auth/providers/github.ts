/**
 * Mock next-auth GitHub Provider Module (Security Audit Cleaned - #1303)
 *
 * Ensures tests mock OAuth configuration safely without requiring or exposing
 * live GitHub Client IDs or GitHub Client Secrets.
 */
import { vi } from "vitest";

export default vi.fn((config: Record<string, any> = {}) => ({
  id: "github",
  type: "oauth",
  name: "GitHub",
  config: {
    clientId: "mock_key",
    clientSecret: "mock_secret",
    ...config,
  },
}));
