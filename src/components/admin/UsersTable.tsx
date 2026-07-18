"use client";

import React, { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateUserRole, deleteUser, type AdminUserRow, type RoleName } from "@/lib/actions/admin";
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
    return "bg-red-500/10 text-red-400 border border-red-500/30";
  return "bg-zinc-500/10 text-zinc-400 border border-zinc-500/30";
}

function primaryRole(roles: string[]): string {
  if (roles.includes("ADMIN")) return "ADMIN";
  return "USER";
}

export default function UsersTable({
  users,
  currentUserId,
}: {
  users: AdminUserRow[];
  currentUserId?: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("ALL");
  const [page, setPage] = useState(1);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      const matchesSearch =
        !q ||
        u.name?.toLowerCase().includes(q) ||
        u.email?.toLowerCase().includes(q) ||
        u.codename?.toLowerCase().includes(q);
      const matchesRole = roleFilter === "ALL" || u.roles.includes(roleFilter);
      return matchesSearch && matchesRole;
    });
  }, [users, search, roleFilter]);

  const totalPages = Math.ceil(filtered.length / ITEMS_PER_PAGE) || 1;
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * ITEMS_PER_PAGE;
  const current = filtered.slice(start, start + ITEMS_PER_PAGE);

  const handleRoleChange = (userId: string, newRole: RoleName) => {
    setError(null);
    setPendingId(userId);
    startTransition(async () => {
      try {
        await updateUserRole(userId, newRole);
        router.refresh();
      } catch (e: any) {
        setError(e?.message || "Failed to update role.");
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
      try {
        await deleteUser(userId);
        router.refresh();
      } catch (e: any) {
        setError(e?.message || "Failed to delete user.");
      } finally {
        setPendingId(null);
      }
    });
  };

  return (
    <div className="w-full bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
      {/* Toolbar */}
      <div className="p-4 border-b border-zinc-800 flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            placeholder="Search by name, email, or codename..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="bg-black border border-zinc-700 text-white text-sm rounded-lg pl-9 pr-4 py-2 w-full focus:outline-none focus:ring-2 focus:ring-red-500"
          />
        </div>
        <select
          value={roleFilter}
          onChange={(e) => {
            setRoleFilter(e.target.value);
            setPage(1);
          }}
          className="bg-black border border-zinc-700 text-white text-sm rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-red-500"
        >
          <option value="ALL">All Roles</option>
          <option value="ADMIN">Admins</option>
          <option value="USER">Users</option>
        </select>
      </div>

      {/* Error banner */}
      {error && (
        <div className="m-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-red-400 hover:text-red-200"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm text-zinc-400 min-w-[820px]">
          <thead className="bg-zinc-950 text-zinc-500 text-xs uppercase border-b border-zinc-800">
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
                    className="border-b border-zinc-800/50 hover:bg-zinc-800/50 transition-colors"
                  >
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        {u.image ? (
                          <img
                            src={u.image}
                            alt={u.name || u.codename || "user"}
                            className="w-8 h-8 rounded-full object-cover border border-zinc-700"
                          />
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-bold text-zinc-400">
                            {(u.name || u.codename || "?").charAt(0).toUpperCase()}
                          </div>
                        )}
                        <div className="flex flex-col">
                          <span className="text-white font-medium">{u.name || "Unnamed"}</span>
                          <span className="text-zinc-500 text-xs font-mono">
                            {u.email || "—"}
                          </span>
                          <span className="text-zinc-600 text-[10px] font-mono uppercase tracking-wider">
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
                    <td className="px-6 py-4 font-mono text-zinc-300">{u.repoCount}</td>
                    <td className="px-6 py-4 text-zinc-500 font-mono text-xs" suppressHydrationWarning>
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
                          className="bg-black border border-zinc-700 text-white text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                        {busy ? (
                          <Loader2 className="w-4 h-4 animate-spin text-zinc-400" />
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
                            className="p-1.5 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-zinc-400"
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
                <td colSpan={5} className="px-6 py-12 text-center text-zinc-500">
                  <ShieldCheck className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  No users match your filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="p-4 border-t border-zinc-800 flex flex-col sm:flex-row gap-2 sm:justify-between sm:items-center text-sm">
        <span className="text-zinc-500">
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
            className="px-3 py-1 bg-zinc-800 rounded hover:bg-zinc-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
          >
            <ChevronLeft className="w-4 h-4" /> Previous
          </button>
          <span className="text-zinc-500 font-mono text-xs px-2">
            {safePage} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={safePage === totalPages}
            className="px-3 py-1 bg-zinc-800 rounded hover:bg-zinc-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
          >
            Next <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
