"use server";

import { signIn } from "@/auth";

export async function handleGithubSignIn(formData: FormData) {
  const callbackUrl = formData.get("callbackUrl")?.toString();
  await signIn("github", { redirectTo: callbackUrl || "/dashboard" });
}
