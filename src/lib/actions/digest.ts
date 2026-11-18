"use server";

import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { generateWeeklyDigestForUser } from "@/lib/digest/digest-service";

export async function requestManualDigestGeneration(): Promise<{
  success: boolean;
  message?: string;
  digest?: any;
}> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    throw new Error("Unauthorized");
  }

  const result = await generateWeeklyDigestForUser(userId, { force: true });
  if (result.success) {
    revalidatePath("/dashboard/digest");
    return {
      success: true,
      message: result.emailSent
        ? "Weekly security digest generated and emailed successfully."
        : "Weekly security digest generated successfully.",
      digest: result.digest,
    };
  }

  return {
    success: false,
    message:
      result.error ||
      (result.reason === "no_repositories"
        ? "No active repositories found."
        : result.reason === "opted_out"
          ? "Weekly digests are disabled in your settings."
          : "Could not generate digest."),
  };
}
