import { auth } from "@/auth";
import { redirect } from "next/navigation";
import NewPolicyClient from "./new-policy-client";

export default async function NewPolicyPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/api/auth/signin");

  return <NewPolicyClient />;
}
