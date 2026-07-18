import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Terminal } from "lucide-react";
import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ArmorIQService } from "@/lib/armor/iq";
import { PolicyCard } from "./policy-card"; // <-- Import the new Client Component

// --- Server Actions ---
async function togglePolicy(formData: FormData) {
  "use server";
  const session = await auth();
  if (!session?.user?.id) return;

  const templateId = formData.get("templateId") as string;
  const currentState = formData.get("currentState") === "true";

  await prisma.userPolicyToggle.upsert({
    where: {
      userId_policyTemplateId: {
        userId: session.user.id,
        policyTemplateId: templateId,
      }
    },
    update: { isActive: !currentState },
    create: {
      userId: session.user.id,
      policyTemplateId: templateId,
      isActive: !currentState,
    }
  });

  revalidatePath("/dashboard/policies");
}

// --- Page Component ---
export default async function PoliciesPage() {
  const session = await auth();
  
  if (!session?.user?.id || !session?.user?.email) {
    redirect("/api/auth/signin");
  }
  
  const userId = session.user.id;
  const userEmail = session.user.email;

  const templates = await prisma.policyTemplate.findMany({
    orderBy: { createdAt: 'desc' }
  });

  const userToggles = await prisma.userPolicyToggle.findMany({
    where: { userId }
  });

  const toggleMap = new Map(userToggles.map((t: any) => [t.policyTemplateId, t.isActive]));

  const policiesToRender = templates.map((template: any) => {
    const isActive = toggleMap.has(template.id) 
      ? toggleMap.get(template.id) 
      : template.isDefault;
      
    return { ...template, isActive };
  });

  // ArmorIQ cloud client is optional: when ARMORIQ_API_KEY is unset, getClient()
  // returns null and we still render the (locally-compiled) programmatic policy.
  const armoriqClient = ArmorIQService.getClient();
  const userScope = armoriqClient?.forUser(userEmail);
  void userScope; // reserved for upcoming per-user intent-token enforcement
  const armoriqConfigured = ArmorIQService.isConfigured();
  const activePolicies = policiesToRender.filter((p: any) => p.isActive);
  const compiledPolicy = ArmorIQService.compileToArmorIQPolicy(activePolicies);

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="font-headline text-3xl font-bold tracking-tight mb-2">The Rules</h1>
          <p className="text-muted-foreground">Toggle automated guardrails used to protect your main branch.</p>
        </div>
      </div>

      <Card className="glass-card bg-primary/5 border-primary/20">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Terminal className="w-5 h-5 text-primary" />
            <CardTitle className="text-lg">Programmatic Rule Set</CardTitle>
          </div>
          <CardDescription>
            Your active rules below are compiled dynamically into this execution guardrail for the agent scope: <strong className="text-white">{userEmail}</strong>.
            {!armoriqConfigured && (
              <span className="mt-1 block text-xs text-amber-500/80">
                ArmorIQ cloud enforcement is inactive — set <code>ARMORIQ_API_KEY</code> (from{" "}
                <a href="https://dev.armoriq.ai" target="_blank" rel="noopener noreferrer" className="underline">dev.armoriq.ai</a>) to bind this policy to live intent tokens.
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="text-xs p-4 bg-black/50 rounded-lg border border-white/10 text-muted-foreground overflow-x-auto">
            {JSON.stringify(compiledPolicy, null, 2)}
          </pre>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {policiesToRender.length === 0 && (
          <div className="col-span-full text-center text-muted-foreground p-8 border border-dashed border-white/10 rounded-xl">
            No rule templates available. (Administrators need to seed the database).
          </div>
        )}
        
        {policiesToRender.map((policy: any) => {
          const rulesMeta = (policy.rules as any) || {};
          const conditions = Array.isArray(rulesMeta) ? rulesMeta : rulesMeta.conditions || [];
          
          return (
            <PolicyCard 
              key={policy.id}
              id={policy.id}
              title={policy.name}
              description={policy.description}
              isActive={policy.isActive}
              severity={policy.severity}
              action={policy.action}
              rules={conditions}
              toggleAction={togglePolicy} // <-- Pass the Server Action here
            />
          );
        })}
      </div>
    </div>
  );
}
