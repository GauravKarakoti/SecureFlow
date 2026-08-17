import { vi } from "vitest";

export const auth =
  (handler: any) =>
  async (req: any, ...args: any[]) =>
    handler(req, ...args);

export const signIn = vi.fn();
export const signOut = vi.fn();
export const handlers = {};
