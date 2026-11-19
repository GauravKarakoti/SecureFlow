import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { fetchRepositoryHealthData } from "@/lib/repositories/health-service";
import RepositoriesClient from "./repositories-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Repository Health Overview | SecureFlow",
  description: "Comparative security health benchmarks, open finding distributions, and 8-week trends.",
};

export default async function RepositoriesPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }

  const data = await fetchRepositoryHealthData(session.user.id);

  return <RepositoriesClient initialData={data} />;
}
