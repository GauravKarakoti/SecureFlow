"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";

export async function updateSlackWebhook(url: string | null) {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    throw new Error("Unauthorized");
  }

  // Basic validation for URL
  if (url !== null && url.trim() !== "") {
    try {
      new URL(url);
    } catch {
      throw new Error("Invalid URL format");
    }
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      slackWebhookUrl: url && url.trim() !== "" ? url.trim() : null,
    },
  });

  revalidatePath("/dashboard/settings");
  return { success: true };
}

export async function getSlackWebhook() {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { slackWebhookUrl: true },
  });

  return user?.slackWebhookUrl || null;
}
