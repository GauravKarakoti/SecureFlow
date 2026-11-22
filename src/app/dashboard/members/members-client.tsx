"use client";

import React, { useMemo, useState, useTransition, useOptimistic } from "react";
import { useRouter } from "next/navigation";
import { updateMemberRole, type InstallationMemberRow } from "@/lib/actions/members";
import { type RoleName } from "@/lib/admin/role-guard";
import { useToast } from "@/hooks/use-toast";
import { TimeAgo } from "@/components/time-ago";
import {
  Search,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  UserCheck,
  Eye,
  Shield,
  Loader2,
  FolderGit2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const ROLE_OPTIONS: RoleName[] = ["ADMIN", "TRIAGER", "VIEWER"];
const ITEMS_PER_PAGE = 10;

function roleBadgeClass(role: string): string {
  switch (role) {
    case "ADMIN":
      return "bg-red-500/10 text-red-500 border border-red-500/30";
    case "TRIAGER":
      return "bg-amber-500/10 text-amber-500 border border-amber-500/30";
    case "VIEWER":
      return "bg-blue-500/10 text-blue-500 border border-blue-500/30";
    default:
      return "bg-emerald-500/10 text-emerald-500 border border-emerald-500/30";
  }
}

function RoleIcon({ role }: { role: string }) {
  switch (role) {
    case "ADMIN":
      return <ShieldCheck className="w-3.5 h-3.5 text-red-400" />;
    case "TRIAGER":
      return <UserCheck className="w-3.5 h-3.5 text-amber-400" />;
    case "VIEWER":
      return <Eye className="w-3.5 h-3.5 text-blue-400" />;
    default:
      return <Shield className="w-3.5 h-3.5 text-emerald-400" />;
  }
}

interface MembersClientProps {
  members: InstallationMemberRow[];
  canManage: boolean;
  currentUserId: string;
}

export default function MembersClient({
  members,
  canManage,
  currentUserId,
}: MembersClientProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("ALL");
  const [page, setPage] = useState(1);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const [optimisticMembers, setOptimisticMembers] = useOptimistic<
    InstallationMemberRow[],
    { userId: string; newRole: RoleName }
  >(members, (currentMembers, update) =>
    currentMembers.map((m) =>
      m.id === update.userId
        ? { ...m, role: update.newRole as any, roles: [update.newRole] }
        : m
    )
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return optimisticMembers.filter((m) => {
      const matchesSearch =
        !q ||
        m.name?.toLowerCase().includes(q) ||
        m.email?.toLowerCase().includes(q) ||
        m.codename?.toLowerCase().includes(q);
      const matchesRole = roleFilter === "ALL" || m.role === roleFilter;
      return matchesSearch && matchesRole;
    });
  }, [optimisticMembers, search, roleFilter]);

  const totalPages = Math.ceil(filtered.length / ITEMS_PER_PAGE) || 1;
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * ITEMS_PER_PAGE;
  const current = filtered.slice(start, start + ITEMS_PER_PAGE);

  const handleRoleChange = (targetUserId: string, newRole: RoleName) => {
    if (!canManage) return;

    setPendingId(targetUserId);
    startTransition(async () => {
      setOptimisticMembers({ userId: targetUserId, newRole });
      try {
        const result = await updateMemberRole(targetUserId, newRole);
        if (result?.success) {
          toast({
            title: "Role updated",
            description: `Member role successfully changed to ${newRole}.`,
          });
          router.refresh();
        } else {
          toast({
            variant: "destructive",
            title: "Role update failed",
            description: "Unable to update member role.",
          });
        }
      } catch (err: any) {
        toast({
          variant: "destructive",
          title: "Role update failed",
          description: err?.message || "An unexpected error occurred.",
        });
      } finally {
        setPendingId(null);
      }
    });
  };

  return (
    <div className="space-y-4">
      {/* Search and Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search by name, email, or codename…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="pl-9 h-10 min-h-[44px]"
            data-testid="members-search-input"
          />
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="member-role-filter" className="text-xs font-mono text-muted-foreground">
            Role:
          </label>
          <select
            id="member-role-filter"
            value={roleFilter}
            onChange={(e) => {
              setRoleFilter(e.target.value);
              setPage(1);
            }}
            className="h-10 min-h-[44px] px-3 py-1 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            data-testid="members-role-filter"
          >
            <option value="ALL">All Roles</option>
            <option value="ADMIN">Admin</option>
            <option value="TRIAGER">Triager</option>
            <option value="VIEWER">Viewer</option>
            <option value="USER">User (Legacy)</option>
          </select>
        </div>
      </div>

      {/* Members Desktop Table */}
      <div className="hidden md:block rounded-xl border border-foreground/10 bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-muted/50 text-muted-foreground text-xs uppercase font-mono tracking-wider border-b border-border">
              <tr>
                <th className="px-4 py-3">Member</th>
                <th className="px-4 py-3">Current Role</th>
                <th className="px-4 py-3">Repositories</th>
                <th className="px-4 py-3">Joined</th>
                <th className="px-4 py-3 text-right">Assign Role</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {current.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    No members match the search or filter criteria.
                  </td>
                </tr>
              ) : (
                current.map((member) => {
                  const isSelf = member.id === currentUserId;
                  const isUpdating = isPending && pendingId === member.id;
                  const disableRoleSelect =
                    !canManage || isUpdating || (isSelf && member.role === "ADMIN");

                  return (
                    <tr
                      key={member.id}
                      className="hover:bg-muted/30 transition-colors"
                      data-testid={`member-row-${member.id}`}
                    >
                      <td className="px-4 py-3">
                        <div className="flex flex-col">
                          <span className="font-medium text-foreground">
                            {member.name || "Anonymous Member"}
                            {isSelf && (
                              <span className="ml-1.5 text-[10px] font-mono text-primary font-normal">
                                (You)
                              </span>
                            )}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {member.email || "No email"}
                          </span>
                          {member.codename && (
                            <span className="text-[10px] font-mono text-muted-foreground/70">
                              @{member.codename}
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <Badge
                            variant="outline"
                            className={`flex items-center gap-1 font-mono text-xs font-semibold ${roleBadgeClass(
                              member.role
                            )}`}
                          >
                            <RoleIcon role={member.role} />
                            {member.role}
                          </Badge>
                        </div>
                      </td>

                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <FolderGit2 className="w-3.5 h-3.5" />
                          <span>{member.repoCount}</span>
                        </div>
                      </td>

                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        <TimeAgo date={member.createdAt} />
                      </td>

                      <td className="px-4 py-3 text-right">
                        {canManage ? (
                          <div className="inline-flex items-center gap-2 justify-end">
                            {isUpdating && <Loader2 className="w-4 h-4 animate-spin text-primary" />}
                            <select
                              aria-label={`Role for ${member.name || member.email || member.id}`}
                              value={member.role}
                              disabled={disableRoleSelect}
                              onChange={(e) =>
                                handleRoleChange(member.id, e.target.value as RoleName)
                              }
                              className="h-9 min-h-[44px] px-2.5 py-1 text-xs font-mono rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
                              data-testid={`select-role-${member.id}`}
                            >
                              {ROLE_OPTIONS.map((r) => (
                                <option key={r} value={r}>
                                  {r}
                                </option>
                              ))}
                              {member.role === "USER" && <option value="USER">USER</option>}
                            </select>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground italic">Read-only</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Members Mobile Card View */}
      <div className="md:hidden space-y-3">
        {current.length === 0 ? (
          <div className="p-6 text-center text-muted-foreground rounded-xl border border-foreground/10 bg-card">
            No members match the search or filter criteria.
          </div>
        ) : (
          current.map((member) => {
            const isSelf = member.id === currentUserId;
            const isUpdating = isPending && pendingId === member.id;
            const disableRoleSelect =
              !canManage || isUpdating || (isSelf && member.role === "ADMIN");

            return (
              <div
                key={member.id}
                className="p-4 rounded-xl border border-foreground/10 bg-card space-y-3"
                data-testid={`member-card-${member.id}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium text-foreground">
                      {member.name || "Anonymous Member"}
                      {isSelf && (
                        <span className="ml-1 text-[10px] font-mono text-primary font-normal">
                          (You)
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">{member.email}</div>
                    {member.codename && (
                      <div className="text-[10px] font-mono text-muted-foreground/70">
                        @{member.codename}
                      </div>
                    )}
                  </div>
                  <Badge
                    variant="outline"
                    className={`flex items-center gap-1 font-mono text-xs font-semibold ${roleBadgeClass(
                      member.role
                    )}`}
                  >
                    <RoleIcon role={member.role} />
                    {member.role}
                  </Badge>
                </div>

                <div className="flex items-center justify-between text-xs text-muted-foreground pt-2 border-t border-border">
                  <div className="flex items-center gap-1">
                    <FolderGit2 className="w-3.5 h-3.5" />
                    <span>{member.repoCount} repos</span>
                  </div>
                  <div>
                    Joined <TimeAgo date={member.createdAt} />
                  </div>
                </div>

                {canManage && (
                  <div className="pt-2 flex items-center justify-between gap-2">
                    <label
                      htmlFor={`mobile-select-${member.id}`}
                      className="text-xs text-muted-foreground font-mono"
                    >
                      Assign Role:
                    </label>
                    <div className="flex items-center gap-2">
                      {isUpdating && <Loader2 className="w-4 h-4 animate-spin text-primary" />}
                      <select
                        id={`mobile-select-${member.id}`}
                        aria-label={`Role for ${member.name || member.email || member.id}`}
                        value={member.role}
                        disabled={disableRoleSelect}
                        onChange={(e) =>
                          handleRoleChange(member.id, e.target.value as RoleName)
                        }
                        className="h-10 min-h-[44px] px-2.5 py-1 text-xs font-mono rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                      >
                        {ROLE_OPTIONS.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                        {member.role === "USER" && <option value="USER">USER</option>}
                      </select>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <span className="text-xs text-muted-foreground">
            Showing {start + 1} to {Math.min(start + ITEMS_PER_PAGE, filtered.length)} of{" "}
            {filtered.length} members
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(p - 1, 1))}
              disabled={safePage <= 1}
              className="min-h-[44px]"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="text-xs font-mono px-2">
              {safePage} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(p + 1, totalPages))}
              disabled={safePage >= totalPages}
              className="min-h-[44px]"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
