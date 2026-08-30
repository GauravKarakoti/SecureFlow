import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { getRepoOverviews } from "@/lib/actions/repositories";
import ReposClient from "./repos-client";

export const dynamic = "force-dynamic";

export default async function ReposPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/api/auth/signin");

  const repos = await getRepoOverviews(session.user.id);

  return <ReposClient repos={repos} />;
}
