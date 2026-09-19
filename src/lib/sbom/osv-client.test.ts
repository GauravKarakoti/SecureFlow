import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Dependency } from "@/types/sbom";
import {
  mapEcosystem,
  extractCveId,
  extractSeverity,
  extractFixedVersion,
  queryOsvForDependency,
  mapOsvVulns,
  type OsvVulnerability,
} from "./osv-client";

describe("osv-client", () => {
  describe("mapEcosystem", () => {
    it.each([
      ["npm", "npm"],
      ["pypi", "PyPI"],
      ["maven", "Maven"],
      ["gem", "RubyGems"],
    ])("maps %s → %s", (input, expected) => {
      expect(mapEcosystem(input)).toBe(expected);
    });

    it("returns null for unknown ecosystems", () => {
      expect(mapEcosystem("cargo")).toBeNull();
      expect(mapEcosystem("")).toBeNull();
    });
  });

  describe("extractCveId", () => {
    it("returns CVE alias when present", () => {
      const vuln: OsvVulnerability = {
        id: "GHSA-jf85-cpcp-j695",
        aliases: ["CVE-2020-8203"],
      };
      expect(extractCveId(vuln)).toBe("CVE-2020-8203");
    });

    it("returns first CVE when multiple aliases exist", () => {
      const vuln: OsvVulnerability = {
        id: "GHSA-abc",
        aliases: ["PYSEC-123", "CVE-2021-99999", "CVE-2021-00001"],
      };
      expect(extractCveId(vuln)).toBe("CVE-2021-99999");
    });

    it("falls back to OSV id when no CVE alias", () => {
      const vuln: OsvVulnerability = {
        id: "GHSA-jf85-cpcp-j695",
        aliases: ["PYSEC-2020-123"],
      };
      expect(extractCveId(vuln)).toBe("GHSA-jf85-cpcp-j695");
    });

    it("falls back to OSV id when aliases is missing", () => {
      const vuln: OsvVulnerability = { id: "GHSA-xyz" };
      expect(extractCveId(vuln)).toBe("GHSA-xyz");
    });
  });

  describe("extractSeverity", () => {
    it("reads top-level database_specific.severity", () => {
      const vuln: OsvVulnerability = {
        id: "GHSA-1",
        database_specific: { severity: "CRITICAL" },
      };
      expect(extractSeverity(vuln)).toBe("CRITICAL");
    });

    it("handles case-insensitive severity", () => {
      const vuln: OsvVulnerability = {
        id: "GHSA-2",
        database_specific: { severity: "high" },
      };
      expect(extractSeverity(vuln)).toBe("HIGH");
    });

    it("maps MODERATE to MEDIUM", () => {
      const vuln: OsvVulnerability = {
        id: "GHSA-moderate",
        database_specific: { severity: "MODERATE" },
      };
      expect(extractSeverity(vuln)).toBe("MEDIUM");
    });

    it("reads affected[].database_specific.severity as fallback", () => {
      const vuln: OsvVulnerability = {
        id: "GHSA-3",
        affected: [
          {
            package: { name: "lodash", ecosystem: "npm" },
            database_specific: { severity: "LOW" },
          },
        ],
      };
      expect(extractSeverity(vuln)).toBe("LOW");
    });

    it("defaults to MEDIUM when no severity data", () => {
      const vuln: OsvVulnerability = { id: "GHSA-4" };
      expect(extractSeverity(vuln)).toBe("MEDIUM");
    });

    it("defaults to MEDIUM for unrecognized severity strings", () => {
      const vuln: OsvVulnerability = {
        id: "GHSA-5",
        database_specific: { severity: "UNKNOWN_LEVEL" },
      };
      expect(extractSeverity(vuln)).toBe("MEDIUM");
    });
  });

  describe("extractFixedVersion", () => {
    it("extracts fixed version from matching package", () => {
      const vuln: OsvVulnerability = {
        id: "GHSA-1",
        affected: [
          {
            package: { name: "lodash", ecosystem: "npm" },
            ranges: [
              {
                type: "ECOSYSTEM",
                events: [{ introduced: "0" }, { fixed: "4.17.21" }],
              },
            ],
          },
        ],
      };
      expect(extractFixedVersion(vuln, "lodash")).toBe("4.17.21");
    });

    it("matches package name case-insensitively", () => {
      const vuln: OsvVulnerability = {
        id: "GHSA-1",
        affected: [
          {
            package: { name: "Django", ecosystem: "PyPI" },
            ranges: [
              {
                type: "ECOSYSTEM",
                events: [{ introduced: "0" }, { fixed: "3.2.4" }],
              },
            ],
          },
        ],
      };
      expect(extractFixedVersion(vuln, "django")).toBe("3.2.4");
    });

    it("falls back to any affected entry when name doesn't match", () => {
      const vuln: OsvVulnerability = {
        id: "GHSA-1",
        affected: [
          {
            package: { name: "other-pkg", ecosystem: "npm" },
            ranges: [
              {
                type: "ECOSYSTEM",
                events: [{ introduced: "0" }, { fixed: "2.0.0" }],
              },
            ],
          },
        ],
      };
      expect(extractFixedVersion(vuln, "no-match")).toBe("2.0.0");
    });

    it("returns null when no fixed event exists", () => {
      const vuln: OsvVulnerability = {
        id: "GHSA-1",
        affected: [
          {
            package: { name: "lodash", ecosystem: "npm" },
            ranges: [
              {
                type: "ECOSYSTEM",
                events: [{ introduced: "0" }, { last_affected: "4.17.20" }],
              },
            ],
          },
        ],
      };
      expect(extractFixedVersion(vuln, "lodash")).toBeNull();
    });

    it("returns null when affected is empty", () => {
      const vuln: OsvVulnerability = { id: "GHSA-1", affected: [] };
      expect(extractFixedVersion(vuln, "lodash")).toBeNull();
    });
  });

  describe("mapOsvVulns", () => {
    const dep: Dependency = {
      name: "lodash",
      version: "4.17.20",
      manifestFile: "package.json",
      ecosystem: "npm",
    };

    it("maps vulnerability array to VulnerabilityMatch[]", () => {
      const vulns: OsvVulnerability[] = [
        {
          id: "GHSA-jf85-cpcp-j695",
          summary: "Prototype Pollution in lodash",
          aliases: ["CVE-2020-8203"],
          database_specific: { severity: "HIGH" },
          affected: [
            {
              package: { name: "lodash", ecosystem: "npm" },
              ranges: [
                {
                  type: "ECOSYSTEM",
                  events: [{ introduced: "0" }, { fixed: "4.17.21" }],
                },
              ],
            },
          ],
        },
      ];

      const matches = mapOsvVulns(dep, vulns);

      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({
        dependency: dep,
        cveId: "CVE-2020-8203",
        severity: "HIGH",
        description: "Prototype Pollution in lodash",
        patchedVersion: "4.17.21",
      });
    });

    it("handles multiple vulns", () => {
      const vulns: OsvVulnerability[] = [
        {
          id: "GHSA-aaa",
          summary: "Vuln A",
          aliases: ["CVE-2021-11111"],
          database_specific: { severity: "HIGH" },
          affected: [],
        },
        {
          id: "GHSA-bbb",
          summary: "Vuln B",
          aliases: ["CVE-2021-22222"],
          database_specific: { severity: "CRITICAL" },
          affected: [],
        },
      ];

      const matches = mapOsvVulns(dep, vulns);
      expect(matches).toHaveLength(2);
      expect(matches[0].cveId).toBe("CVE-2021-11111");
      expect(matches[1].cveId).toBe("CVE-2021-22222");
    });

    it("returns empty array for no vulns", () => {
      expect(mapOsvVulns(dep, [])).toEqual([]);
    });
  });

  describe("queryOsvForDependency", () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      globalThis.fetch = vi.fn();
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("sends correct request and returns parsed vulns", async () => {
      const dep: Dependency = {
        name: "lodash",
        version: "4.17.20",
        manifestFile: "package.json",
        ecosystem: "npm",
      };

      const mockVulns: OsvVulnerability[] = [
        {
          id: "GHSA-jf85-cpcp-j695",
          summary: "Prototype Pollution",
          aliases: ["CVE-2020-8203"],
          database_specific: { severity: "HIGH" },
          affected: [],
        },
      ];

      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ vulns: mockVulns }),
      } as Response);

      const result = await queryOsvForDependency(dep);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.osv.dev/v1/query",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            package: { name: "lodash", ecosystem: "npm" },
            version: "4.17.20",
          }),
        }),
      );
      expect(result).toEqual(mockVulns);
    });

    it("returns empty array for unknown version", async () => {
      const dep: Dependency = {
        name: "flask",
        version: "unknown",
        manifestFile: "requirements.txt",
        ecosystem: "pypi",
      };

      const result = await queryOsvForDependency(dep);

      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it("returns empty array for unsupported ecosystem", async () => {
      const dep: Dependency = {
        name: "serde",
        version: "1.0.0",
        manifestFile: "Cargo.toml",
        ecosystem: "cargo" as any,
      };

      const result = await queryOsvForDependency(dep);

      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it("returns empty array when API returns no vulns field", async () => {
      const dep: Dependency = {
        name: "express",
        version: "4.18.2",
        manifestFile: "package.json",
        ecosystem: "npm",
      };

      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response);

      const result = await queryOsvForDependency(dep);
      expect(result).toEqual([]);
    });

    it("throws on non-OK HTTP response", async () => {
      const dep: Dependency = {
        name: "lodash",
        version: "4.17.20",
        manifestFile: "package.json",
        ecosystem: "npm",
      };

      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      } as Response);

      await expect(queryOsvForDependency(dep)).rejects.toThrow(
        "OSV API error: 500 Internal Server Error",
      );
    });

    it("maps PyPI ecosystem correctly in request", async () => {
      const dep: Dependency = {
        name: "django",
        version: "3.2.0",
        manifestFile: "requirements.txt",
        ecosystem: "pypi",
      };

      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ vulns: [] }),
      } as Response);

      await queryOsvForDependency(dep);

      const body = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0][1]!.body as string);
      expect(body.package.ecosystem).toBe("PyPI");
    });

    it("returns empty list when version is unknown or missing", async () => {
      const fetchSpy = vi.mocked(globalThis.fetch);
      const depUnknown: Dependency = {
        name: "express",
        version: "unknown",
        manifestFile: "package.json",
        ecosystem: "npm",
      };
      const result = await queryOsvForDependency(depUnknown);
      expect(result).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("mapOsvVulns — fallback handling", () => {
    it("uses details slice when summary is missing", () => {
      const dep: Dependency = {
        name: "lodash",
        version: "4.17.20",
        manifestFile: "package.json",
        ecosystem: "npm",
      };
      const vulns: OsvVulnerability[] = [
        {
          id: "GHSA-details-only",
          details: "Detailed security explanation of vulnerability in lodash",
        },
      ];

      const matches = mapOsvVulns(dep, vulns);
      expect(matches).toHaveLength(1);
      expect(matches[0].description).toBe(
        "Detailed security explanation of vulnerability in lodash",
      );
    });

    it("uses generic fallback when both summary and details are missing", () => {
      const dep: Dependency = {
        name: "express",
        version: "4.18.2",
        manifestFile: "package.json",
        ecosystem: "npm",
      };
      const vulns: OsvVulnerability[] = [{ id: "GHSA-no-desc" }];

      const matches = mapOsvVulns(dep, vulns);
      expect(matches[0].description).toBe("Known vulnerability in express");
    });
  });
});
