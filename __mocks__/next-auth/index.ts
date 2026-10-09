import { vi } from "vitest";
const NextAuth = vi.fn(() => ({
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
  auth: vi.fn(async () => null),
}));
export default NextAuth;
