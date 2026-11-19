import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Direct route per finding (/findings/[id]) redirecting to the full
 * dashboard side-by-side review page (/dashboard/findings/[id]).
 */
export default async function FindingShortRoutePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/dashboard/findings/${id}`);
}
