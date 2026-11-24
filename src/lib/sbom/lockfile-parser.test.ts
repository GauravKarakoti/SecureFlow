import { describe, it, expect } from "vitest";
import { isLockfileManifest, parsePackageLockJson, parsePnpmLockYaml } from "./lockfile-parser";

describe("lockfile-parser", () => {
  describe("isLockfileManifest", () => {
    it("identifies package-lock.json and pnpm-lock.yaml", () => {
      expect(isLockfileManifest("package-lock.json")).toBe(true);
      expect(isLockfileManifest("deep/path/package-lock.json")).toBe(true);
      expect(isLockfileManifest("pnpm-lock.yaml")).toBe(true);
      expect(isLockfileManifest("apps/web/pnpm-lock.yaml")).toBe(true);
    });

    it("rejects non-lockfile manifests", () => {
      expect(isLockfileManifest("package.json")).toBe(false);
      expect(isLockfileManifest("requirements.txt")).toBe(false);
      expect(isLockfileManifest("yarn.lock")).toBe(false);
      expect(isLockfileManifest("sbom.json")).toBe(false);
    });
  });

  describe("parsePackageLockJson", () => {
    it("parses npm lockfile v1 (dependencies tree)", () => {
      const v1Lock = JSON.stringify({
        name: "my-app",
        version: "1.0.0",
        lockfileVersion: 1,
        dependencies: {
          lodash: {
            version: "4.17.21",
            resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
          },
          express: {
            version: "4.18.2",
            dependencies: {
              debug: {
                version: "2.6.9",
              },
            },
          },
        },
      });

      const deps = parsePackageLockJson(v1Lock, "package-lock.json");
      expect(deps).toHaveLength(3);

      const lodash = deps.find((d) => d.name === "lodash");
      expect(lodash).toBeDefined();
      expect(lodash?.version).toBe("4.17.21");
      expect(lodash?.isTransitive).toBe(false);
      expect(lodash?.ecosystem).toBe("npm");

      const debug = deps.find((d) => d.name === "debug");
      expect(debug).toBeDefined();
      expect(debug?.version).toBe("2.6.9");
      expect(debug?.isTransitive).toBe(true);
      expect(debug?.parentPackage).toBe("express");
    });

    it("parses npm lockfile v2/v3 (packages map with direct and nested node_modules)", () => {
      const v3Lock = JSON.stringify({
        name: "secureflow",
        version: "0.1.0",
        lockfileVersion: 3,
        packages: {
          "": {
            name: "secureflow",
            dependencies: {
              express: "^4.18.2",
              "@types/node": "^20.0.0",
            },
            devDependencies: {
              typescript: "^5.0.0",
            },
          },
          "node_modules/express": {
            version: "4.18.2",
            dependencies: {
              accepts: "~1.3.8",
            },
          },
          "node_modules/@types/node": {
            version: "20.10.0",
          },
          "node_modules/typescript": {
            version: "5.3.3",
            dev: true,
          },
          "node_modules/express/node_modules/accepts": {
            version: "1.3.8",
          },
        },
      });

      const deps = parsePackageLockJson(v3Lock, "package-lock.json");
      expect(deps.length).toBe(4);

      const express = deps.find((d) => d.name === "express");
      expect(express).toBeDefined();
      expect(express?.version).toBe("4.18.2");
      expect(express?.isTransitive).toBe(false);

      const typesNode = deps.find((d) => d.name === "@types/node");
      expect(typesNode).toBeDefined();
      expect(typesNode?.version).toBe("20.10.0");
      expect(typesNode?.isTransitive).toBe(false);

      const typescript = deps.find((d) => d.name === "typescript");
      expect(typescript).toBeDefined();
      expect(typescript?.version).toBe("5.3.3");
      expect(typescript?.isTransitive).toBe(false);

      const accepts = deps.find((d) => d.name === "accepts");
      expect(accepts).toBeDefined();
      expect(accepts?.version).toBe("1.3.8");
      expect(accepts?.isTransitive).toBe(true);
      expect(accepts?.parentPackage).toBe("express");
    });

    it("returns empty array for invalid JSON or empty packages", () => {
      expect(parsePackageLockJson("{ invalid json ", "package-lock.json")).toEqual([]);
      expect(parsePackageLockJson("{}", "package-lock.json")).toEqual([]);
    });
  });

  describe("parsePnpmLockYaml", () => {
    it("parses pnpm lockfile v5 style package entries", () => {
      const v5Content = `
lockfileVersion: 5.4
specifiers:
  lodash: ^4.17.21
dependencies:
  lodash: 4.17.21
packages:
  /lodash/4.17.21:
    resolution: {integrity: sha512-...}
    dev: false
  /@scope/helper/1.2.3:
    resolution: {integrity: sha512-...}
    dev: true
`;
      const deps = parsePnpmLockYaml(v5Content, "pnpm-lock.yaml");
      expect(deps).toHaveLength(2);

      const lodash = deps.find((d) => d.name === "lodash");
      expect(lodash).toBeDefined();
      expect(lodash?.version).toBe("4.17.21");
      expect(lodash?.isTransitive).toBe(false);

      const scopeHelper = deps.find((d) => d.name === "@scope/helper");
      expect(scopeHelper).toBeDefined();
      expect(scopeHelper?.version).toBe("1.2.3");
      expect(scopeHelper?.isTransitive).toBe(true);
    });

    it("parses pnpm lockfile v6/v9 style package entries with peer dependency suffixes", () => {
      const v6Content = `
lockfileVersion: '6.0'
settings:
  autoInstallPeers: true
dependencies:
  react:
    specifier: ^18.2.0
    version: 18.2.0
packages:
  react@18.2.0:
    resolution: {integrity: sha512-...}
  '@tanstack/react-query@5.17.0(react@18.2.0)':
    resolution: {integrity: sha512-...}
  'lodash@4.17.21':
    resolution: {integrity: sha512-...}
`;
      const deps = parsePnpmLockYaml(v6Content, "pnpm-lock.yaml");
      expect(deps).toHaveLength(3);

      const react = deps.find((d) => d.name === "react");
      expect(react?.version).toBe("18.2.0");
      expect(react?.isTransitive).toBe(false);

      const query = deps.find((d) => d.name === "@tanstack/react-query");
      expect(query?.version).toBe("5.17.0");
      expect(query?.isTransitive).toBe(true);

      const lodash = deps.find((d) => d.name === "lodash");
      expect(lodash?.version).toBe("4.17.21");
      expect(lodash?.isTransitive).toBe(true);
    });

    it("returns empty array for empty or unparseable yaml", () => {
      expect(parsePnpmLockYaml("", "pnpm-lock.yaml")).toEqual([]);
      expect(parsePnpmLockYaml("no packages here: 123", "pnpm-lock.yaml")).toEqual([]);
    });
  });
});
