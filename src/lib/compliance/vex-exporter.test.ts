import { describe, expect, it } from "vitest";
import {
  OPENVEX_CONTEXT_V020,
  buildOpenVexFromDossier,
  exportOpenVexDocument,
  mapTriageToVexStatus,
  validateOpenVexDocument,
} from "./vex-exporter";
import {
  exportComplianceDossierAsOpenVex,
  type AuditorComplianceDossier,
} from "./auditor-exporter";

describe("OpenVEX v0.2.0 Exporter", () => {
  it("maps triage statuses to OpenVEX statuses with spec-compliant defaults", () => {
    expect(mapTriageToVexStatus("FALSE_POSITIVE")).toMatchObject({
      status: "not_affected",
      defaultJustification: "vulnerable_code_not_present",
    });
    expect(mapTriageToVexStatus("ACCEPTED_RISK")).toMatchObject({
      status: "not_affected",
      defaultJustification: "inline_mitigations_already_exist",
    });
    expect(mapTriageToVexStatus("RESOLVED").status).toBe("fixed");
    expect(mapTriageToVexStatus("IN_REVIEW").status).toBe("under_investigation");
    expect(mapTriageToVexStatus("OPEN").status).toBe("affected");
  });

  it("generates and validates a complete OpenVEX v0.2.0 document", () => {
    const doc = exportOpenVexDocument(
      [
        {
          vulnerabilityId: "CVE-2024-3094",
          vulnerabilityDescription: "Backdoor in xz-utils",
          aliases: ["GHSA-rxwq-x6h5-x525"],
          productPurl: "pkg:npm/secureflow-app@1.0.0",
          subcomponentPurls: ["pkg:generic/xz@5.6.0"],
          triageStatus: "FALSE_POSITIVE",
          justification: "component_not_present",
          impactStatement: "xz-utils 5.6.0 is not bundled in runtime container.",
        },
        {
          vulnerabilityId: "CVE-2024-21538",
          productPurl: "pkg:npm/cross-spawn@7.0.3",
          triageStatus: "OPEN",
          actionStatement: "Upgrade cross-spawn to >= 7.0.5.",
        },
        {
          vulnerabilityId: "CVE-2023-45857",
          productPurl: "pkg:npm/axios@1.5.0",
          triageStatus: "RESOLVED",
        },
      ],
      {
        author: "SecureFlow Security Team",
        timestamp: "2026-11-27T12:00:00.000Z",
        version: 2,
      },
    );

    expect(doc["@context"]).toBe(OPENVEX_CONTEXT_V020);
    expect(doc.version).toBe(2);
    expect(doc.statements).toHaveLength(3);
    expect(doc.statements[0].status).toBe("not_affected");
    expect(doc.statements[0].justification).toBe("component_not_present");
    expect(doc.statements[1].status).toBe("affected");
    expect(doc.statements[1].action_statement).toContain("7.0.5");
    expect(doc.statements[2].status).toBe("fixed");

    const validation = validateOpenVexDocument(doc);
    expect(validation).toEqual({ valid: true, errors: [] });
  });

  it("rejects invalid OpenVEX statements missing justification or action_statement", () => {
    const doc = exportOpenVexDocument([
      {
        vulnerabilityId: "CVE-2024-0001",
        productPurl: "pkg:npm/demo@1.0.0",
        vexStatus: "not_affected",
      },
    ]);
    // Force-clear both justification and impact_statement to verify validator catches spec violation
    delete doc.statements[0].justification;
    delete doc.statements[0].impact_statement;

    const validation = validateOpenVexDocument(doc);
    expect(validation.valid).toBe(false);
    expect(validation.errors[0]).toContain(
      "not_affected requires justification or impact_statement",
    );
  });

  it("exports an AuditorComplianceDossier as a valid OpenVEX document", () => {
    const mockDossier: AuditorComplianceDossier = {
      generatedAt: "2026-11-27T12:00:00.000Z",
      reportId: "RPT-2026-001",
      timeWindow: { from: "2026-09-01T00:00:00.000Z", to: "2026-11-27T12:00:00.000Z" },
      metrics: {
        totalPullRequests: 10,
        passedPullRequests: 8,
        blockedPullRequests: 2,
        reviewRequiredPullRequests: 0,
        prPassRatePercentage: 80,
        totalFindings: 2,
        openFindings: 1,
        resolvedFindings: 1,
        meanTimeToRemediateHours: 4,
        meanTimeToRemediateDays: 0.17,
      },
      frameworks: {} as AuditorComplianceDossier["frameworks"],
      cryptographicProof: {
        chainIntegrity: "VALID",
        totalLedgerEvents: 0,
        genesisVerified: true,
        latestBlockSeq: 0,
        merkleRoot: null,
        recentAuditRecords: [],
      },
      topViolatedControls: [],
      recentFindingsSample: [
        {
          id: "f-1",
          type: "SQL_INJECTION",
          severity: "CRITICAL",
          fileLocation: "src/api/users.ts",
          complianceTags: ["SOC2-CC6.1", "OWASP-A03"],
          cwe: "CWE-89",
          createdAt: "2026-11-26T10:00:00.000Z",
        },
        {
          id: "f-2",
          type: "XSS",
          severity: "HIGH",
          fileLocation: "src/ui/comment.tsx",
          complianceTags: ["OWASP-A03"],
          cwe: "CWE-79",
          createdAt: "2026-11-26T11:00:00.000Z",
        },
      ],
    };

    const viaDossier = exportComplianceDossierAsOpenVex(mockDossier);
    expect(viaDossier["@id"]).toBe("https://secureflow.dev/vex/RPT-2026-001");
    expect(viaDossier.statements).toHaveLength(2);
    expect(viaDossier.statements[0].vulnerability.name).toBe("CWE-89");
    expect(validateOpenVexDocument(viaDossier).valid).toBe(true);

    const withOverride = buildOpenVexFromDossier(mockDossier, {
      triageByFindingId: {
        "f-2": { status: "FALSE_POSITIVE", justification: "vulnerable_code_not_in_execute_path" },
      },
    });
    expect(withOverride.statements[1].status).toBe("not_affected");
    expect(withOverride.statements[1].justification).toBe("vulnerable_code_not_in_execute_path");
  });
});
