"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";

export async function togglePolicy(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) return;

  const templateId = formData.get("templateId") as string;
  const currentState = formData.get("currentState") === "true";

  await prisma.userPolicyToggle.upsert({
    where: {
      userId_policyTemplateId: {
        userId: session.user.id,
        policyTemplateId: templateId,
      },
    },
    update: { isActive: !currentState },
    create: {
      userId: session.user.id,
      policyTemplateId: templateId,
      isActive: !currentState,
    },
  });

  revalidatePath("/dashboard/policies");
}
