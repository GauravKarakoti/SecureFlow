import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { CodenameForm } from "./codename-form";
import { VenetianMask, Shield, Sparkles } from "lucide-react";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "The Naming Ceremony · Resistance Onboarding",
  description: "Select your city codename to enter the SecureFlow Vault.",
};

export default async function CodenameSetupPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/setup/codename");
  }

  // If user already has an active codename, no need to redo the ceremony
  if (session.user.codename) {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col justify-center items-center p-4 relative overflow-hidden">
      {/* Tactical Background Grid & Gradients */}
      <div
        className="absolute inset-0 opacity-[0.04] [background-image:linear-gradient(hsl(var(--foreground)/0.45)_1px,transparent_1px),linear-gradient(90deg,hsl(var(--foreground)/0.45)_1px,transparent_1px)] [background-size:24px_24px] pointer-events-none"
        aria-hidden="true"
      />
      <div
        className="absolute -top-40 -left-40 w-96 h-96 bg-primary/10 rounded-full blur-3xl pointer-events-none"
        aria-hidden="true"
      />
      <div
        className="absolute -bottom-40 -right-40 w-96 h-96 bg-red-900/10 rounded-full blur-3xl pointer-events-none"
        aria-hidden="true"
      />

      <div className="w-full max-w-lg relative z-10">
        {/* Header Branding */}
        <div className="text-center mb-8 space-y-2">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 border border-primary/30 text-primary mb-3 shadow-lg shadow-primary/10">
            <VenetianMask className="w-7 h-7" />
          </div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/30 bg-primary/5 text-primary text-[10px] font-mono font-bold tracking-widest uppercase mb-1">
            <Sparkles className="w-3 h-3" /> Operation Vault Shield // Induction
          </div>
          <h1 className="text-2xl sm:text-3xl font-black tracking-tight font-headline">
            The Naming Ceremony
          </h1>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto leading-relaxed">
            Welcome to the Resistance. To safeguard operations and protect your fellow crew members, real names are strictly prohibited.
          </p>
        </div>

        {/* Form Card */}
        <div className="glass-card rounded-xl border border-foreground/10 p-6 sm:p-8 shadow-2xl backdrop-blur-2xl bg-card/80 relative">
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-transparent via-primary to-transparent" />
          <CodenameForm initialName={session.user.name} />
        </div>

        {/* Footer info */}
        <div className="text-center mt-6 text-[11px] font-mono text-muted-foreground/60 flex items-center justify-center gap-2">
          <Shield className="w-3.5 h-3.5" /> SECUREFLOW VAULT PROTOCOL // ENCRYPTED INDUCTION
        </div>
      </div>
    </div>
  );
}
