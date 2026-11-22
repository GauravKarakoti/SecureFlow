"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { User, UserPlus, Loader2, Check } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  assignFinding,
  getAssignableUsers,
  type AssignableUser,
} from "@/lib/actions/assignee";

interface FindingAssigneeSelectProps {
  repositoryId: string;
  fingerprint: string;
  currentAssignee?: {
    id: string;
    name: string | null;
    email: string | null;
    codename: string | null;
    image: string | null;
  } | null;
  variant?: "table" | "detail";
}

const UNASSIGNED_VALUE = "__unassigned__";

export default function FindingAssigneeSelect({
  repositoryId,
  fingerprint,
  currentAssignee,
  variant = "table",
}: FindingAssigneeSelectProps) {
  let router: any = null;
  try {
    router = useRouter();
  } catch {
    router = { refresh: () => {} };
  }
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [assignee, setAssignee] = useState(currentAssignee ?? null);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);

  useEffect(() => {
    setAssignee(currentAssignee ?? null);
  }, [currentAssignee]);

  const loadUsers = async () => {
    if (users.length > 0 || loadingUsers) return;
    setLoadingUsers(true);
    try {
      const list = await getAssignableUsers(repositoryId);
      setUsers(list);
    } catch (err) {
      console.error("Failed to load assignable users:", err);
    } finally {
      setLoadingUsers(false);
    }
  };

  const handleAssign = (newAssigneeId: string) => {
    const targetId = newAssigneeId === UNASSIGNED_VALUE ? null : newAssigneeId;
    const selectedUser = targetId ? users.find((u) => u.id === targetId) : null;

    startTransition(async () => {
      setAssignee(selectedUser ? { ...selectedUser } : null);

      try {
        const result = await assignFinding({
          repositoryId,
          fingerprint,
          assigneeId: targetId,
        });

        if (result.ok) {
          toast({
            title: targetId ? "Finding assigned" : "Finding unassigned",
            description: targetId
              ? `Assigned to ${selectedUser?.name || selectedUser?.codename || selectedUser?.email || "team member"}.`
              : "Finding is now unassigned.",
          });
          router.refresh();
        } else {
          setAssignee(currentAssignee ?? null);
          toast({
            variant: "destructive",
            title: "Assignment failed",
            description: result.error || "Could not update assignment.",
          });
        }
      } catch (err: any) {
        setAssignee(currentAssignee ?? null);
        toast({
          variant: "destructive",
          title: "Assignment failed",
          description: err?.message || "An unexpected error occurred.",
        });
      }
    });
  };

  const displayName =
    assignee?.name || assignee?.codename || assignee?.email || "Unassigned";

  return (
    <div
      className="inline-flex items-center gap-1.5"
      onClick={(e) => e.stopPropagation()}
      data-testid="finding-assignee-select"
    >
      <Select
        value={assignee?.id ?? UNASSIGNED_VALUE}
        onValueChange={handleAssign}
        onOpenChange={(open) => {
          if (open) loadUsers();
        }}
        disabled={isPending}
      >
        <SelectTrigger
          className={`min-h-[36px] h-8 text-xs font-mono gap-1.5 border-white/10 hover:border-white/20 bg-background/50 focus:ring-1 focus:ring-primary ${
            variant === "detail" ? "w-full sm:w-[220px]" : "w-auto max-w-[170px]"
          }`}
          aria-label={`Assignee: ${displayName}`}
          data-testid="assignee-select-trigger"
        >
          {isPending ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-primary shrink-0" />
          ) : assignee?.image ? (
            <img
              src={assignee.image}
              alt={displayName}
              className="w-4 h-4 rounded-full object-cover shrink-0"
            />
          ) : assignee ? (
            <div className="w-4 h-4 rounded-full bg-primary/20 text-primary flex items-center justify-center text-[10px] font-bold shrink-0">
              {displayName.charAt(0).toUpperCase()}
            </div>
          ) : (
            <UserPlus className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          )}
          <span className="truncate text-[11px] text-muted-foreground font-medium">
            {displayName}
          </span>
        </SelectTrigger>
        <SelectContent align="start" className="min-w-[200px]">
          <SelectItem value={UNASSIGNED_VALUE} className="text-xs font-mono">
            <span className="flex items-center gap-2 text-muted-foreground">
              <UserPlus className="w-3.5 h-3.5" />
              Unassigned
            </span>
          </SelectItem>

          {users.map((u) => (
            <SelectItem key={u.id} value={u.id} className="text-xs font-mono">
              <div className="flex items-center gap-2">
                {u.image ? (
                  <img
                    src={u.image}
                    alt={u.name || "User"}
                    className="w-4 h-4 rounded-full object-cover"
                  />
                ) : (
                  <div className="w-4 h-4 rounded-full bg-primary/20 text-primary flex items-center justify-center text-[9px] font-bold">
                    {(u.name || u.codename || u.email || "U").charAt(0).toUpperCase()}
                  </div>
                )}
                <span className="truncate max-w-[140px]">
                  {u.name || u.codename || u.email}
                </span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
