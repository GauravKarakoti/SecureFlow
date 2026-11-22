import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { Users, ShieldCheck, UserCheck, Eye } from "lucide-react";
import { getInstallationMembers } from "@/lib/actions/members";
import { can } from "@/lib/auth/permissions";
import MembersClient from "./members-client";

export const metadata = {
  title: "Team Members | SecureFlow",
  description: "Manage roles and access permissions for members across your installation.",
};

export default async function MembersPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/api/auth/signin");
    return null;
  }

  const members = await getInstallationMembers();
  const canManage = can(session.user, null, "members:manage");
  const currentUserId = session.user.id;

  const totalMembers = members.length;
  const adminCount = members.filter((m) => m.role === "ADMIN").length;
  const triagerCount = members.filter((m) => m.role === "TRIAGER").length;
  const viewerCount = members.filter((m) => m.role === "VIEWER").length;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
        <div>
          <h1 className="font-headline text-3xl font-bold tracking-tight mb-2">Team Members</h1>
          <p className="text-muted-foreground text-sm">
            Manage organization members and assign installation-wide roles (Viewer, Triager, Admin).
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-foreground/[0.03] rounded-xl border border-foreground/10 p-4 flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
            <Users className="w-5 h-5" />
          </div>
          <div>
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
              Total Members
            </div>
            <div className="text-xl font-bold">{totalMembers}</div>
          </div>
        </div>

        <div className="bg-foreground/[0.03] rounded-xl border border-foreground/10 p-4 flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-red-500/10 flex items-center justify-center text-red-400">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
              Admins
            </div>
            <div className="text-xl font-bold">{adminCount}</div>
          </div>
        </div>

        <div className="bg-foreground/[0.03] rounded-xl border border-foreground/10 p-4 flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-400">
            <UserCheck className="w-5 h-5" />
          </div>
          <div>
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
              Triagers
            </div>
            <div className="text-xl font-bold">{triagerCount}</div>
          </div>
        </div>

        <div className="bg-foreground/[0.03] rounded-xl border border-foreground/10 p-4 flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-400">
            <Eye className="w-5 h-5" />
          </div>
          <div>
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
              Viewers
            </div>
            <div className="text-xl font-bold">{viewerCount}</div>
          </div>
        </div>
      </div>

      <MembersClient
        members={members}
        canManage={canManage}
        currentUserId={currentUserId}
      />
    </div>
  );
}
