import { auth } from "@/auth";
import { getUsers, getUserManagementMetrics } from "@/lib/actions/admin";
import UsersTable from "@/components/admin/UsersTable";
import MetricsCard from "@/components/admin/MetricsCard";
import { Users } from "lucide-react";

export const metadata = {
  title: "User Management · SecureFlow Admin",
};

export default async function AdminUsersPage() {
  // The layout already gates on ADMIN, but we still need the current user id
  // to disable self-demotion / self-deletion in the UI.
  const session = await auth();
  const currentUserId = session?.user?.id;

  const [users, metrics] = await Promise.all([
    getUsers(),
    getUserManagementMetrics(),
  ]);

  return (
    <div className="space-y-8">
      <header className="flex items-start gap-4">
        <div className="w-11 h-11 rounded-xl bg-red-500/10 border border-red-500/30 flex items-center justify-center shrink-0">
          <Users className="w-5 h-5 text-red-400" />
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">
            User Management
          </h1>
          <p className="text-zinc-400 mt-2">
            Manage user roles, access levels, and account status across SecureFlow.
          </p>
        </div>
      </header>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <MetricsCard title="Total Users" value={metrics.total} />
        <MetricsCard title="Administrators" value={metrics.admins} />
        <MetricsCard title="New (24h)" value={metrics.last24h} />
      </div>

      <UsersTable users={users} currentUserId={currentUserId} />
    </div>
  );
}
