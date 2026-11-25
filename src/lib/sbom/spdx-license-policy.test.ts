import { describe, it, expect } from "vitest";
import {
  parseSpdxExpression,
  SpdxParseError,
  classifySpdxLicense,
  evaluateLicensePolicy,
  evaluateDependenciesLicenses,
  PERMISSIVE_ONLY_POLICY,
  STANDARD_OSS_POLICY,
} from "./spdx-license-policy";
import { detectAndParseSbom } from "./sbom-format-detector";

describe("SPDX License Expression Parser & Copyleft Compliance Engine (#2079)", () => {
  it("parses simple, compound, WITH-exception, and parenthesized SPDX expressions into AST", () => {
    const simple = parseSpdxExpression("MIT");
    expect(simple).toEqual({ type: "license", id: "MIT", plus: false });

    const plus = parseSpdxExpression("GPL-2.0+");
    expect(plus).toEqual({ type: "license", id: "GPL-2.0", plus: true });

    const withExc = parseSpdxExpression("GPL-2.0-only WITH Classpath-exception-2.0");
    expect(withExc).toEqual({
      type: "with",
      license: { type: "license", id: "GPL-2.0-only", plus: false },
      exception: "Classpath-exception-2.0",
    });

    const compound = parseSpdxExpression("(Apache-2.0 OR MIT) AND ISC");
    expect(compound.type).toBe("and");
  });

  it("throws SpdxParseError on malformed expressions", () => {
    expect(() => parseSpdxExpression("")).toThrowError(SpdxParseError);
    expect(() => parseSpdxExpression("(MIT OR Apache-2.0")).toThrowError(SpdxParseError);
    expect(() => parseSpdxExpression("MIT AND")).toThrowError(SpdxParseError);
    expect(() => parseSpdxExpression("OR MIT")).toThrowError(SpdxParseError);
    expect(() => parseSpdxExpression("MIT WITH")).toThrowError(SpdxParseError);
  });

  it("classifies permissive, weak-copyleft, strong-copyleft, proprietary, and unknown licenses", () => {
    expect(classifySpdxLicense("MIT")).toBe("permissive");
    expect(classifySpdxLicense("Apache-2.0")).toBe("permissive");
    expect(classifySpdxLicense("CC0-1.0")).toBe("public-domain");
    expect(classifySpdxLicense("MPL-2.0")).toBe("weak-copyleft");
    expect(classifySpdxLicense("LGPL-3.0-only")).toBe("weak-copyleft");
    expect(classifySpdxLicense("GPL-3.0-only")).toBe("strong-copyleft");
    expect(classifySpdxLicense("AGPL-3.0-or-later")).toBe("strong-copyleft");
    expect(classifySpdxLicense("LicenseRef-Proprietary-Commercial")).toBe("proprietary");
    expect(classifySpdxLicense("NOASSERTION")).toBe("unknown");
  });

  it("allows dual-licensed MIT OR GPL-3.0-only under permissive policy but blocks MIT AND GPL-3.0-only", () => {
    const dual = evaluateLicensePolicy("MIT OR GPL-3.0-only", PERMISSIVE_ONLY_POLICY);
    expect(dual.compliant).toBe(true);
    expect(dual.satisfiedBy).toContain("MIT");
    expect(dual.violatingLicenses).toEqual([]);

    const conjunctive = evaluateLicensePolicy("MIT AND GPL-3.0-only", PERMISSIVE_ONLY_POLICY);
    expect(conjunctive.compliant).toBe(false);
    expect(conjunctive.severity).toBe("HIGH");
    expect(conjunctive.violatingLicenses).toContain("GPL-3.0-only");
  });

  it("evaluates nested boolean license trees accurately", () => {
    const nestedPass = evaluateLicensePolicy(
      "(Apache-2.0 OR BSD-3-Clause) AND (MIT OR AGPL-3.0-only)",
      PERMISSIVE_ONLY_POLICY,
    );
    expect(nestedPass.compliant).toBe(true);

    const nestedFail = evaluateLicensePolicy(
      "(Apache-2.0 OR MIT) AND (GPL-3.0-only OR AGPL-3.0-only)",
      PERMISSIVE_ONLY_POLICY,
    );
    expect(nestedFail.compliant).toBe(false);
    expect(nestedFail.violatingLicenses).toEqual(["GPL-3.0-only", "AGPL-3.0-only"]);
  });

  it("respects weak copyleft differences between PERMISSIVE_ONLY_POLICY and STANDARD_OSS_POLICY", () => {
    const permissiveCheck = evaluateLicensePolicy("MPL-2.0", PERMISSIVE_ONLY_POLICY);
    expect(permissiveCheck.compliant).toBe(false);
    expect(permissiveCheck.severity).toBe("MEDIUM");

    const standardCheck = evaluateLicensePolicy("MPL-2.0", STANDARD_OSS_POLICY);
    expect(standardCheck.compliant).toBe(true);
  });

  it("enforces custom allowlist and denylist overrides", () => {
    const customPolicy = {
      name: "custom-corp",
      allowlist: ["GPL-2.0-only"],
      denylist: ["WTFPL"],
      blockStrongCopyleft: true,
    };

    expect(evaluateLicensePolicy("GPL-2.0-only", customPolicy).compliant).toBe(true);
    expect(evaluateLicensePolicy("WTFPL", customPolicy).compliant).toBe(false);
  });

  it("integrates with CycloneDX and SPDX detectAndParseSbom to extract and evaluate licenses", () => {
    const cyclonedx = {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      components: [
        {
          name: "lodash",
          version: "4.17.21",
          purl: "pkg:npm/lodash@4.17.21",
          licenses: [{ license: { id: "MIT" } }],
        },
        {
          name: "copyleft-pkg",
          version: "1.0.0",
          purl: "pkg:npm/copyleft-pkg@1.0.0",
          licenses: [{ expression: "GPL-3.0-only" }],
        },
      ],
    };

    const cdxResult = detectAndParseSbom(cyclonedx, "bom.json", PERMISSIVE_ONLY_POLICY);
    expect(cdxResult).not.toBeNull();
    expect(cdxResult?.dependencies[0]?.license).toBe("MIT");
    expect(cdxResult?.dependencies[1]?.license).toBe("GPL-3.0-only");
    expect(cdxResult?.licenseCompliance?.compliantCount).toBe(1);
    expect(cdxResult?.licenseCompliance?.violationCount).toBe(1);
    expect(cdxResult?.licenseCompliance?.violations[0]?.dependency.name).toBe("copyleft-pkg");

    const spdx = {
      spdxVersion: "SPDX-2.3",
      packages: [
        {
          name: "requests",
          versionInfo: "2.31.0",
          licenseConcluded: "Apache-2.0",
          externalRefs: [{ referenceLocator: "pkg:pypi/requests@2.31.0" }],
        },
        {
          name: "agpl-tool",
          versionInfo: "2.0.0",
          licenseConcluded: "NOASSERTION",
          licenseDeclared: "AGPL-3.0-only",
        },
      ],
    };

    const spdxResult = detectAndParseSbom(spdx, "app.spdx.json", STANDARD_OSS_POLICY);
    expect(spdxResult).not.toBeNull();
    expect(spdxResult?.dependencies[0]?.license).toBe("Apache-2.0");
    expect(spdxResult?.dependencies[1]?.license).toBe("AGPL-3.0-only");
    expect(spdxResult?.licenseCompliance?.violationCount).toBe(1);

    const summary = evaluateDependenciesLicenses(spdxResult!.dependencies, PERMISSIVE_ONLY_POLICY);
    expect(summary.totalDependencies).toBe(2);
    expect(summary.compliantCount).toBe(1);
  });
});
