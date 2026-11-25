import { describe, it, expect } from "vitest";
import {
  isLockfileManifest,
  parsePackageLockJson,
  parsePnpmLockYaml,
  parseYarnLock,
  parseCargoLock,
  parseGoSum,
} from "./lockfile-parser";
import { isSupportedManifest, parseManifestFile } from "./dependency-parser";
import { mapEcosystem } from "./osv-client";

describe("lockfile-parser", () => {
  describe("isLockfileManifest", () => {
    it("identifies package-lock.json, pnpm-lock.yaml, yarn.lock, Cargo.lock, and go.sum", () => {
      expect(isLockfileManifest("package-lock.json")).toBe(true);
      expect(isLockfileManifest("deep/path/package-lock.json")).toBe(true);
      expect(isLockfileManifest("pnpm-lock.yaml")).toBe(true);
      expect(isLockfileManifest("apps/web/pnpm-lock.yaml")).toBe(true);
      expect(isLockfileManifest("yarn.lock")).toBe(true);
      expect(isLockfileManifest("services/api/Cargo.lock")).toBe(true);
      expect(isLockfileManifest("cmd/server/go.sum")).toBe(true);
    });

    it("rejects non-lockfile manifests", () => {
      expect(isLockfileManifest("package.json")).toBe(false);
      expect(isLockfileManifest("requirements.txt")).toBe(false);
      expect(isLockfileManifest("Gemfile.lock")).toBe(false);
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

  describe("parseYarnLock (#2081)", () => {
    it("parses Yarn Classic v1 lockfile with scoped and multi-specifier entries", () => {
      const yarnV1 = `
# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1

"@babel/core@^7.0.0", "@babel/core@^7.12.0":
  version "7.24.4"
  resolved "https://registry.yarnpkg.com/@babel/core/-/core-7.24.4.tgz"

lodash@^4.17.21:
  version "4.17.21"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz"
`;
      const deps = parseYarnLock(yarnV1, "yarn.lock");
      expect(deps).toHaveLength(2);
      expect(deps.find((d) => d.name === "@babel/core")?.version).toBe("7.24.4");
      expect(deps.find((d) => d.name === "lodash")?.version).toBe("4.17.21");
      expect(deps[0]?.ecosystem).toBe("npm");
    });

    it("parses Yarn Berry (v2+/v4) YAML lockfile and ignores __metadata and workspaces", () => {
      const yarnBerry = `
__metadata:
  version: 8
  cacheKey: 10

"my-monorepo@workspace:.":
  version: 0.0.0-use.local
  resolution: "my-monorepo@workspace:."

"@tanstack/react-query@npm:^5.17.0":
  version: 5.17.0
  resolution: "@tanstack/react-query@npm:5.17.0"

"express@npm:^4.18.0, express@npm:^4.19.2":
  version: 4.19.2
  resolution: "express@npm:4.19.2"
`;
      const deps = parseYarnLock(yarnBerry, "yarn.lock");
      expect(deps).toHaveLength(2);
      expect(deps.find((d) => d.name === "@tanstack/react-query")?.version).toBe("5.17.0");
      expect(deps.find((d) => d.name === "express")?.version).toBe("4.19.2");
    });
  });

  describe("parseCargoLock (#2081)", () => {
    it("parses Rust Cargo.lock [[package]] tables and maps cargo ecosystem", () => {
      const cargoLock = `
# This file is automatically @generated by Cargo.
version = 3

[[package]]
name = "my-service"
version = "0.1.0"
dependencies = [
  "serde",
]

[[package]]
name = "serde"
version = "1.0.197"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "abc123"
`;
      const deps = parseCargoLock(cargoLock, "Cargo.lock");
      expect(deps).toHaveLength(2);

      const rootPkg = deps.find((d) => d.name === "my-service");
      expect(rootPkg?.version).toBe("0.1.0");
      expect(rootPkg?.ecosystem).toBe("cargo");
      expect(rootPkg?.isTransitive).toBe(false);

      const serdePkg = deps.find((d) => d.name === "serde");
      expect(serdePkg?.version).toBe("1.0.197");
      expect(serdePkg?.isTransitive).toBe(true);
      expect(mapEcosystem("cargo")).toBe("crates.io");
    });
  });

  describe("parseGoSum (#2081)", () => {
    it("parses and deduplicates Go go.sum entries including /go.mod and +incompatible", () => {
      const goSum = `
github.com/gin-gonic/gin v1.9.1 h1:4idEAncQnU5cB7BeOkPtxjfCSye0AAm1R0RVIqJ+Jmg=
github.com/gin-gonic/gin v1.9.1/go.mod h1:hPrL7Yrp+...
github.com/dgrijalva/jwt-go v3.2.0+incompatible h1:7qlOGliEK...
github.com/dgrijalva/jwt-go v3.2.0+incompatible/go.mod h1:E3ru+11k...
`;
      const deps = parseGoSum(goSum, "go.sum");
      expect(deps).toHaveLength(2);

      const gin = deps.find((d) => d.name === "github.com/gin-gonic/gin");
      expect(gin?.version).toBe("1.9.1");
      expect(gin?.ecosystem).toBe("go");

      const jwt = deps.find((d) => d.name === "github.com/dgrijalva/jwt-go");
      expect(jwt?.version).toBe("3.2.0");
      expect(mapEcosystem("go")).toBe("Go");
    });
  });

  describe("dependency-parser integration (#2081)", () => {
    it("routes yarn.lock, Cargo.lock, and go.sum through parseManifestFile", () => {
      expect(isSupportedManifest("yarn.lock")).toBe(true);
      expect(isSupportedManifest("Cargo.lock")).toBe(true);
      expect(isSupportedManifest("go.sum")).toBe(true);

      const goDeps = parseManifestFile("golang.org/x/crypto v0.21.0 h1:abc=\n", "go.sum");
      expect(goDeps).toHaveLength(1);
      expect(goDeps[0]?.name).toBe("golang.org/x/crypto");
      expect(goDeps[0]?.version).toBe("0.21.0");
    });
  });
});
