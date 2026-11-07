import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  documentedPaths,
  findOpenApiIgnore,
  findOpenApiYaml,
  isRouteIgnored,
  listApiRoutes,
  parseIgnoreList,
  verifyOpenApiSync,
} from "./verify-openapi";

describe("scripts/verify-openapi.ts (#1354, #1538)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-openapi-test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("findOpenApiYaml", () => {
    it("finds openapi.yaml in the specified directory", () => {
      const openapiPath = path.join(tempDir, "openapi.yaml");
      fs.writeFileSync(openapiPath, "openapi: 3.1.0\npaths:\n", "utf8");

      const found = findOpenApiYaml(tempDir);
      expect(found).toBe(openapiPath);
    });

    it("traverses up to parent directories to locate openapi.yaml", () => {
      const openapiPath = path.join(tempDir, "openapi.yaml");
      fs.writeFileSync(openapiPath, "openapi: 3.1.0\npaths:\n", "utf8");

      const subDir = path.join(tempDir, "nested", "subfolder");
      fs.mkdirSync(subDir, { recursive: true });

      const found = findOpenApiYaml(subDir);
      expect(found).toBe(openapiPath);
    });

    it("returns null when openapi.yaml does not exist in hierarchy", () => {
      const isolatedDir = path.join(tempDir, "isolated");
      fs.mkdirSync(isolatedDir, { recursive: true });

      const found = findOpenApiYaml(isolatedDir);
      expect(found).toBeNull();
    });
  });

  describe("findOpenApiIgnore", () => {
    it("finds .openapiignore in the specified directory", () => {
      const ignorePath = path.join(tempDir, ".openapiignore");
      fs.writeFileSync(ignorePath, "/api/internal/*\n", "utf8");

      const found = findOpenApiIgnore(tempDir);
      expect(found).toBe(ignorePath);
    });

    it("traverses parent directories to locate .openapiignore", () => {
      const ignorePath = path.join(tempDir, ".openapiignore");
      fs.writeFileSync(ignorePath, "/api/internal/*\n", "utf8");

      const subDir = path.join(tempDir, "sub", "child");
      fs.mkdirSync(subDir, { recursive: true });

      const found = findOpenApiIgnore(subDir);
      expect(found).toBe(ignorePath);
    });

    it("returns null if .openapiignore does not exist", () => {
      expect(findOpenApiIgnore(tempDir)).toBeNull();
    });
  });

  describe("parseIgnoreList & isRouteIgnored", () => {
    it("parses lines and ignores comments and empty lines", () => {
      const content = `
# This is a comment
/api/internal/health

/api/admin/*
# Another comment
/api/secret
`;
      const patterns = parseIgnoreList(content);
      expect(patterns).toEqual(["/api/internal/health", "/api/admin/*", "/api/secret"]);
    });

    it("correctly matches exact routes", () => {
      const patterns = ["/api/internal/health", "/api/secret"];
      expect(isRouteIgnored("/api/internal/health", patterns)).toBe(true);
      expect(isRouteIgnored("/api/internal/health2", patterns)).toBe(false);
      expect(isRouteIgnored("/api/secret", patterns)).toBe(true);
      expect(isRouteIgnored("/api/other", patterns)).toBe(false);
    });

    it("correctly matches wildcard prefix routes", () => {
      const patterns = ["/api/admin/*", "/api/legacy*"];
      expect(isRouteIgnored("/api/admin", patterns)).toBe(true);
      expect(isRouteIgnored("/api/admin/metrics", patterns)).toBe(true);
      expect(isRouteIgnored("/api/admin/metrics/sub", patterns)).toBe(true);
      expect(isRouteIgnored("/api/administrator", patterns)).toBe(false);
      expect(isRouteIgnored("/api/legacy-v1", patterns)).toBe(true);
      expect(isRouteIgnored("/api/public", patterns)).toBe(false);
    });
  });

  describe("listApiRoutes", () => {
    it("maps [param] to {param}, drops route groups and skips catch-all routes", () => {
      const api = path.join(tempDir, "api");
      for (const dir of ["findings/[id]", "(internal)/health", "auth/[...nextauth]", "og/heist"]) {
        fs.mkdirSync(path.join(api, dir), { recursive: true });
      }
      fs.writeFileSync(path.join(api, "findings/[id]/route.ts"), "", "utf8");
      fs.writeFileSync(path.join(api, "(internal)/health/route.ts"), "", "utf8");
      fs.writeFileSync(path.join(api, "auth/[...nextauth]/route.ts"), "", "utf8");
      fs.writeFileSync(path.join(api, "og/heist/route.tsx"), "", "utf8");

      expect(listApiRoutes(api)).toEqual(["/api/findings/{id}", "/api/health", "/api/og/heist"]);
    });

    it("returns no routes when the directory does not exist", () => {
      expect(listApiRoutes(path.join(tempDir, "missing"))).toEqual([]);
    });
  });

  describe("documentedPaths", () => {
    it("reads the path keys, with LF or CRLF line endings", () => {
      const spec =
        "openapi: 3.1.0\r\npaths:\r\n  /api/a:\r\n    get:\r\n  /api/b/{id}:\n    post:\n";
      expect(documentedPaths(spec)).toEqual(new Set(["/api/a", "/api/b/{id}"]));
    });
  });

  describe("verifyOpenApiSync", () => {
    it("returns true when openapi.yaml is valid with openapi and paths keys", () => {
      const openapiPath = path.join(tempDir, "openapi.yaml");
      fs.writeFileSync(
        openapiPath,
        "openapi: 3.1.0\ninfo:\n  title: SecureFlow API\npaths:\n  /api/health:\n    get:\n",
        "utf8",
      );

      const isValid = verifyOpenApiSync({ cwd: tempDir, exitOnError: false });
      expect(isValid).toBe(true);
    });

    it("verifies the workspace repository openapi.yaml successfully", () => {
      const isValid = verifyOpenApiSync({ exitOnError: false });
      expect(isValid).toBe(true);
    });

    it("returns false and logs error when openapi.yaml is not found", () => {
      const emptyDir = path.join(tempDir, "empty");
      fs.mkdirSync(emptyDir, { recursive: true });

      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const isValid = verifyOpenApiSync({ cwd: emptyDir, exitOnError: false });

      expect(isValid).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("openapi.yaml could not be found"),
      );
    });

    it("returns false when openapi.yaml is missing openapi version header", () => {
      const openapiPath = path.join(tempDir, "openapi.yaml");
      fs.writeFileSync(openapiPath, "paths:\n  /api/health:\n    get:\n", "utf8");

      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const isValid = verifyOpenApiSync({ cwd: tempDir, exitOnError: false });

      expect(isValid).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("openapi.yaml appears to be invalid or malformed"),
      );
    });

    it("returns false and names a route handler the spec does not document", () => {
      fs.writeFileSync(
        path.join(tempDir, "openapi.yaml"),
        "openapi: 3.1.0\npaths:\n  /api/health:\n    get:\n",
        "utf8",
      );
      for (const route of ["health", "findings/[id]/remediate"]) {
        fs.mkdirSync(path.join(tempDir, "src", "app", "api", route), { recursive: true });
        fs.writeFileSync(path.join(tempDir, "src", "app", "api", route, "route.ts"), "", "utf8");
      }

      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const isValid = verifyOpenApiSync({ cwd: tempDir, exitOnError: false });

      expect(isValid).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/findings/{id}/remediate"),
      );
    });

    it("allows undocumented routes if they match .openapiignore", () => {
      fs.writeFileSync(
        path.join(tempDir, "openapi.yaml"),
        "openapi: 3.1.0\npaths:\n  /api/health:\n    get:\n",
        "utf8",
      );
      fs.writeFileSync(
        path.join(tempDir, ".openapiignore"),
        "# Internal routes\n/api/internal/*\n",
        "utf8",
      );

      for (const route of ["health", "internal/metrics"]) {
        fs.mkdirSync(path.join(tempDir, "src", "app", "api", route), { recursive: true });
        fs.writeFileSync(path.join(tempDir, "src", "app", "api", route, "route.ts"), "", "utf8");
      }

      const isValid = verifyOpenApiSync({ cwd: tempDir, exitOnError: false });
      expect(isValid).toBe(true);
    });

    it("returns false when openapi.yaml is missing paths declaration (schema drift)", () => {
      const openapiPath = path.join(tempDir, "openapi.yaml");
      fs.writeFileSync(openapiPath, "openapi: 3.1.0\ninfo:\n  title: Test\n", "utf8");

      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const isValid = verifyOpenApiSync({ cwd: tempDir, exitOnError: false });

      expect(isValid).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("openapi.yaml appears to be invalid or malformed"),
      );
    });
  });
});
