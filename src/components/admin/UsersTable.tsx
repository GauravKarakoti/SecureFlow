"use client";

import React, { useMemo, useState, useTransition, useOptimistic } from "react";
import { useRouter } from "next/navigation";
import { updateUserRole, deleteUser, type AdminUserRow, type RoleName } from "@/lib/actions/admin";
import { useToast } from "@/hooks/use-toast";
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Trash2,
  Loader2,
  ShieldCheck,
  AlertCircle,
} from "lucide-react";

const ROLES: RoleName[] = ["USER", "ADMIN"];
const ITEMS_PER_PAGE = 10;

function roleBadgeClass(roles: string[]): string {
  if (roles.includes("ADMIN"))
    return "bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/30";
  return "bg-muted text-muted-foreground border border-border";
}

function primaryRole(roles: string[]): string {
  if (roles.includes("ADMIN")) return "ADMIN";
  return "USER";
}

type OptimisticUserAction =
  | { type: "UPDATE_ROLE"; userId: string; newRole: RoleName }
  | { type: "DELETE_USER"; userId: string };

export default function UsersTable({
  users,
  currentUserId,
}: {
  users: AdminUserRow[];
  currentUserId?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("ALL");
  const [page, setPage] = useState(1);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const [optimisticUsers, setOptimisticUsers] = useOptimistic<
    AdminUserRow[],
    OptimisticUserAction
  >(users, (currentUsers, action) => {
    switch (action.type) {
      case "UPDATE_ROLE":
        return currentUsers.map((u) =>
          u.id === action.userId ? { ...u, roles: [action.newRole] } : u
        );
      case "DELETE_USER":
        return currentUsers.filter((u) => u.id !== action.userId);
      default:
        return currentUsers;
    }
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return optimisticUsers.filter((u) => {
      const matchesSearch =
        !q ||
        u.name?.toLowerCase().includes(q) ||
        u.email?.toLowerCase().includes(q) ||
        u.codename?.toLowerCase().includes(q);
      const matchesRole = roleFilter === "ALL" || u.roles.includes(roleFilter);
      return matchesSearch && matchesRole;
    });
  }, [optimisticUsers, search, roleFilter]);

  const totalPages = Math.ceil(filtered.length / ITEMS_PER_PAGE) || 1;
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * ITEMS_PER_PAGE;
  const current = filtered.slice(start, start + ITEMS_PER_PAGE);

  const handleRoleChange = (userId: string, newRole: RoleName) => {
    setError(null);
    setPendingId(userId);
    startTransition(async () => {
      setOptimisticUsers({ type: "UPDATE_ROLE", userId, newRole });
      try {
        await updateUserRole(userId, newRole);
        router.refresh();
      } catch (e: any) {
        const msg = e?.message || "Failed to update role.";
        setError(msg);
        toast({
          variant: "destructive",
          title: "Role Update Failed",
          description: msg,
        });
      } finally {
        setPendingId(null);
      }
    });
  };

  const handleDelete = (userId: string, label: string) => {
    if (
      !window.confirm(
        `Delete user "${label}"?\n\nThis permanently removes their account, repositories, pull requests, and scan history. This action cannot be undone.`
      )
    )
      return;
    setError(null);
    setPendingId(userId);
    startTransition(async () => {
      setOptimisticUsers({ type: "DELETE_USER", userId });
      try {
        await deleteUser(userId);
        router.refresh();
      } catch (e: any) {
        const msg = e?.message || "Failed to delete user.";
        setError(msg);
        toast({
          variant: "destructive",
          title: "User Deletion Failed",
          description: msg,
        });
      } finally {
        setPendingId(null);
      }
    });
  };

  return (
    <div className="w-full bg-card border border-border rounded-xl overflow-hidden">
      {/* Toolbar */}
      <div className="p-4 border-b border-border flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by name, email, or codename..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="bg-background border border-border text-foreground text-sm rounded-lg pl-9 pr-4 py-2 w-full focus:outline-none focus:ring-2 focus:ring-red-500"
          />
        </div>
        <select
          value={roleFilter}
          onChange={(e) => {
            setRoleFilter(e.target.value);
            setPage(1);
          }}
          className="bg-background border border-border text-foreground text-sm rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-red-500"
        >
          <option value="ALL">All Roles</option>
          <option value="ADMIN">Admins</option>
          <option value="USER">Users</option>
        </select>
      </div>

      {/* Error banner */}
      {error && (
        <div className="m-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-200"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm text-muted-foreground min-w-[820px]">
          <thead className="bg-muted text-muted-foreground text-xs uppercase border-b border-border">
            <tr>
              <th className="px-6 py-4">User</th>
              <th className="px-6 py-4">Roles</th>
              <th className="px-6 py-4">Repositories</th>
              <th className="px-6 py-4">Joined</th>
              <th className="px-6 py-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {current.length > 0 ? (
              current.map((u) => {
                const isSelf = u.id === currentUserId;
                const isLastAdmin =
                  u.roles.includes("ADMIN") &&
                  users.filter((x) => x.roles.includes("ADMIN")).length <= 1;
                const busy = isPending && pendingId === u.id;

                return (
                  <tr
                    key={u.id}
                    className="border-b border-border/50 hover:bg-muted/50 transition-colors"
                  >
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        {u.image ? (
                          <img
                            src={u.image}
                            alt={u.name || u.codename || "user"}
                            className="w-8 h-8 rounded-full object-cover border border-border"
                          />
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-xs font-bold text-muted-foreground">
                            {(u.name || u.codename || "?").charAt(0).toUpperCase()}
                          </div>
                        )}
                        <div className="flex flex-col">
                          <span className="text-foreground font-medium">{u.name || "Unnamed"}</span>
                          <span className="text-muted-foreground text-xs font-mono">
                            {u.email || "—"}
                          </span>
                          <span className="text-muted-foreground/70 text-[10px] font-mono uppercase tracking-wider">
                            {u.codename || "no-codename"}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider font-mono ${roleBadgeClass(
                          u.roles
                        )}`}
                      >
                        {primaryRole(u.roles)}
                      </span>
                    </td>
                    <td className="px-6 py-4 font-mono text-foreground/80">{u.repoCount}</td>
                    <td className="px-6 py-4 text-muted-foreground font-mono text-xs" suppressHydrationWarning>
                      {new Date(u.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-2">
                        <select
                          value={primaryRole(u.roles)}
                          disabled={busy || isSelf}
                          onChange={(e) =>
                            handleRoleChange(u.id, e.target.value as RoleName)
                          }
                          title={
                            isSelf
                              ? "You cannot change your own role"
                              : "Change role"
                          }
                          className="bg-background border border-border text-foreground text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                        {busy ? (
                          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                        ) : (
                          <button
                            onClick={() =>
                              handleDelete(u.id, u.name || u.email || u.codename || u.id)
                            }
                            disabled={isSelf || isLastAdmin}
                            title={
                              isSelf
                                ? "You cannot delete your own account"
                                : isLastAdmin
                                ? "Cannot delete the last admin"
                                : "Delete user"
                            }
                            className="p-1.5 rounded-lg text-muted-foreground hover:text-red-600 dark:hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={5} className="px-6 py-12 text-center text-muted-foreground">
                  <ShieldCheck className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  No users match your filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="p-4 border-t border-border flex flex-col sm:flex-row gap-2 sm:justify-between sm:items-center text-sm">
        <span className="text-muted-foreground">
          {filtered.length === 0
            ? "Showing 0 results"
            : `Showing ${start + 1} to ${Math.min(
                start + ITEMS_PER_PAGE,
                filtered.length
              )} of ${filtered.length} users`}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={safePage === 1}
            className="px-3 py-1 bg-secondary rounded hover:bg-secondary/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
          >
            <ChevronLeft className="w-4 h-4" /> Previous
          </button>
          <span className="text-muted-foreground font-mono text-xs px-2">
            {safePage} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={safePage === totalPages}
            className="px-3 py-1 bg-secondary rounded hover:bg-secondary/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
          >
            Next <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}