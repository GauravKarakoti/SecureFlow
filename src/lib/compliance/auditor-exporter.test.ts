import {
  calculateMTTR,
  generateAuditorComplianceDossier,
  generateAuditorPdfHtml,
} from "./auditor-exporter";

describe("Auditor Compliance Exporter Engine", () => {
  describe("MTTR Calculation", () => {
    it("should calculate mean time to remediate accurately", () => {
      const base = new Date("2026-09-01T10:00:00Z");
      const resolved1 = new Date("2026-09-01T14:00:00Z"); // 4 hours
      const resolved2 = new Date("2026-09-01T16:00:00Z"); // 6 hours

      const triages = [
        { createdAt: base, updatedAt: resolved1, status: "RESOLVED" },
        { createdAt: base, updatedAt: resolved2, status: "RESOLVED" },
        { createdAt: base, updatedAt: base, status: "OPEN" },
      ];

      const mttr = calculateMTTR(triages);
      expect(mttr.hours).toBe(5);
      expect(mttr.days).toBeCloseTo(0.2, 1);
    });

    it("should return 0 when no findings have been resolved", () => {
      const triages = [{ createdAt: new Date(), updatedAt: new Date(), status: "OPEN" }];
      expect(calculateMTTR(triages)).toEqual({ hours: 0, days: 0 });
    });
  });

  describe("Compliance Dossier & PDF Generation", () => {
    it("should generate a full auditor compliance dossier structure", async () => {
      const dossier = await generateAuditorComplianceDossier();

      expect(dossier).toHaveProperty("reportId");
      expect(dossier).toHaveProperty("metrics");
      expect(dossier).toHaveProperty("frameworks");
      expect(dossier).toHaveProperty("cryptographicProof");

      expect(dossier.frameworks).toHaveProperty("SOC2");
      expect(dossier.frameworks).toHaveProperty("PCI-DSS");
      expect(dossier.frameworks).toHaveProperty("OWASP");

      expect(dossier.cryptographicProof).toHaveProperty("chainIntegrity");
    });

    it("should generate printable HTML/PDF containing executive metrics and matrix", async () => {
      const dossier = await generateAuditorComplianceDossier();
      const html = generateAuditorPdfHtml(dossier);

      expect(html).toContain("SecureFlow Compliance Audit Report");
      expect(html).toContain("Compliance Framework Matrix");
      expect(html).toContain("Cryptographic Audit Event Ledger");
      expect(html).toContain(dossier.reportId);
    });
  });
});
