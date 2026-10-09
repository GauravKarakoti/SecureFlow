import FindingsClient from "./findings-client";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { getUserFindingFilters, getUserFindings } from "@/lib/actions/findings";
import { fromSearchParams } from "@/lib/findings/query";
import { buildSbomReport } from "@/lib/sbom/findings-report";

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

  // Dependency findings from the SBOM worker are stored as VULNERABILITY rows with a
  // "Dependency: name@version" snippet; there is no separate finding type to filter on.
  const sbomReport = buildSbomReport(result.findings);

  return (
    <FindingsClient
      findings={result.findings}
      stats={result.stats}
      filterOptions={filterOptions}
      page={result.page}
      pageSize={result.pageSize}
      total={result.total}
      totalPages={result.totalPages}
      sbomReport={sbomReport}
    />
  );
}
