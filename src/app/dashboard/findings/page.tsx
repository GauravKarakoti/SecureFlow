import FindingsClient from "./findings-client";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { getUserFindingFilters, getUserFindings } from "@/lib/actions/findings";
import { fromSearchParams } from "@/lib/findings/query";
import { SbomScanResult } from "@/types/sbom";

export const dynamic = "force-dynamic";

/**
 * Security Findings (#561).
 *
 * Filters, sort and page number are read from `searchParams` rather than held in
 * client state, so a narrowed view is bookmarkable and shareable and survives a
 * reload. Every query — the list, the total and the three stat tiles — is built
 * from one `buildFindingsWhere` call inside `getUserFindings`, which is what
 * stops the tiles and the list disagreeing the way they used to.
 *
 * This page previously inlined four Prisma queries with a hard-coded `take: 50`,
 * no `skip` and no filters. They now live in `src/lib/actions/findings.ts`, with
 * every decidable part pure and unit-tested in `src/lib/findings/query.ts`.
 */
export default async function FindingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }

  const params = await searchParams;
  const query = fromSearchParams(params);

  const [result, filterOptions] = await Promise.all([
    getUserFindings(query),
    getUserFindingFilters(),
  ]);

  // [NEW] Calculate SBOM-specific stats for the report card
  const sbomFindings = result.findings.filter(
    (finding) => finding.type === 'DEPENDENCY_VULNERABILITY'
  );

  const sbomReport = sbomFindings.length > 0 ? {
    scanId: 'aggregated-scan',
    timestamp: new Date(),
    totalDependencies: sbomFindings.length,
    vulnerabilities: sbomFindings.map((v: any) => ({
      dependency: {
        name: v.file.split('/').pop() || v.file,
        version: 'latest',
        manifestFile: v.file,
        ecosystem: v.file.endsWith('package.json') ? 'npm' : 'pip'
      },
      cveId: v.description.match(/CVE-\d{4}-\d+/)?.[0] || 'CVE-Aggregated',
      severity: v.severity,
      description: v.description,
      patchedVersion: v.remediation.match(/version\s+(\S+)/i)?.[1] || 'N/A'
    })),
    status: sbomFindings.some(f => f.severity === 'CRITICAL' || f.severity === 'HIGH') ? 'VULNERABLE' : 'WARNING'
  } : null;

  return (
    <FindingsClient
      findings={result.findings}
      stats={result.stats}
      filterOptions={filterOptions}
      page={result.page}
      pageSize={result.pageSize}
      total={result.total}
      totalPages={result.totalPages}
      sbomReport={sbomReport as SbomScanResult | null}
    />
  );
}
