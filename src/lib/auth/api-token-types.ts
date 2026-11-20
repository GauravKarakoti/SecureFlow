/**
 * Shared types and constants for Personal API Tokens.
 * Safe for client-side and server-side usage.
 */

export const API_TOKEN_SCOPES = [
  "findings:read",
  "findings:write",
  "scans:read",
  "scans:write",
  "policies:read",
  "policies:write",
  "audit:read",
] as const;

export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export const TOKEN_PREFIX = "sft_";
export const TOKEN_PREFIX_DISPLAY_LENGTH = 12;
