import { describe, it, expect } from "vitest";
import {
  MAX_FILES_PER_REQUEST,
  MAX_FILE_CONTENT_LENGTH,
  MAX_PATH_LENGTH,
  MAX_SCAN_REQUEST_BYTES,
  cliScanRequestSchema as serverScanSchema,
  cliScanResponseSchema as serverResponseSchema,
} from "../src/app/api/cli/scan/route";
import {
  cliScanRequestSchema as contractsScanSchema,
  cliScanResponseSchema as contractsResponseSchema,
  MAX_FILES_PER_REQUEST as CONTRACTS_MAX_FILES,
} from "../cli/src/contracts/index";

describe("Shared API Contracts Integration (#1696)", () => {
  it("ensures server route and CLI contracts share identical schema references", () => {
    expect(serverScanSchema).toBe(contractsScanSchema);
    expect(serverResponseSchema).toBe(contractsResponseSchema);
  });

  it("ensures boundary constants match", () => {
    expect(MAX_FILES_PER_REQUEST).toBe(CONTRACTS_MAX_FILES);
    expect(MAX_FILE_CONTENT_LENGTH).toBe(512 * 1024);
    expect(MAX_PATH_LENGTH).toBe(1024);
    expect(MAX_SCAN_REQUEST_BYTES).toBe(10 * 1024 * 1024);
  });

  it("validates request payload compatibility between CLI and Server", () => {
    const payload = {
      files: [{ path: "test.ts", content: "const secret = '123';" }],
      voice: false,
    };

    const serverParsed = serverScanSchema.safeParse(payload);
    const contractsParsed = contractsScanSchema.safeParse(payload);

    expect(serverParsed.success).toBe(true);
    expect(contractsParsed.success).toBe(true);
    if (serverParsed.success && contractsParsed.success) {
      expect(serverParsed.data).toEqual(contractsParsed.data);
    }
  });
});
