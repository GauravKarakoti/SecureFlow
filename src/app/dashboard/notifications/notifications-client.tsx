"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bell,
  Check,
  CheckCheck,
  Trash2,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  UserCheck,
  AtSign,
  Clock,
  ShieldAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  type NotificationDto,
  type NotificationType,
} from "@/lib/actions/notifications";
import { cn } from "@/lib/utils";

function getNotificationIcon(type: NotificationType) {
  switch (type) {
    case "FINDING_ASSIGNED":
      return <UserCheck className="w-5 h-5 text-blue-400" />;
    case "MENTION":
      return <AtSign className="w-5 h-5 text-purple-400" />;
    case "DISMISSAL_EXPIRING":
      return <Clock className="w-5 h-5 text-amber-400" />;
    default:
      return <ShieldAlert className="w-5 h-5 text-primary" />;
  }
}

function formatDate(dateInput: Date | string): string {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function NotificationsClient({
  initialNotifications,
  initialTotal,
  initialUnreadCount,
  currentPage,
  pageCount,
  unreadOnly,
}: {
  initialNotifications: NotificationDto[];
  initialTotal: number;
  initialUnreadCount: number;
  currentPage: number;
  pageCount: number;
  unreadOnly: boolean;
}) {
  const router = useRouter();
  const [notifications, setNotifications] = useState(initialNotifications);
  const [unreadCount, setUnreadCount] = useState(initialUnreadCount);
  const [isPending, startTransition] = useTransition();

  const handleMarkAsRead = (id: string) => {
    startTransition(async () => {
      await markNotificationAsRead(id);
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, readAt: new Date() } : n)));
      setUnreadCount((c) => Math.max(0, c - 1));
      router.refresh();
    });
  };

  const handleMarkAllAsRead = () => {
    startTransition(async () => {
      await markAllNotificationsAsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, readAt: new Date() })));
      setUnreadCount(0);
      router.refresh();
    });
  };

  const handleDelete = (id: string) => {
    startTransition(async () => {
      await deleteNotification(id);
      const target = notifications.find((n) => n.id === id);
      if (target && !target.readAt) {
        setUnreadCount((c) => Math.max(0, c - 1));
      }
      setNotifications((prev) => prev.filter((n) => n.id !== id));
      router.refresh();
    });
  };

  const handleFilterChange = (filterUnread: boolean) => {
    const params = new URLSearchParams();
    if (filterUnread) params.set("unread", "true");
    params.set("page", "1");
    router.push(`/dashboard/notifications?${params.toString()}`);
  };

  const handlePageChange = (newPage: number) => {
    const params = new URLSearchParams();
    if (unreadOnly) params.set("unread", "true");
    params.set("page", String(newPage));
    router.push(`/dashboard/notifications?${params.toString()}`);
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-2 border-b border-white/5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white font-headline flex items-center gap-2">
            <Bell className="w-6 h-6 text-primary" />
            Notification Center
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Stay updated on finding assignments, reviewer mentions, and expiring dismissals.
          </p>
        </div>

        {unreadCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleMarkAllAsRead}
            disabled={isPending}
            className="self-start sm:self-auto gap-2 text-xs border-white/10 hover:bg-white/5"
            data-testid="mark-all-read-btn"
          >
            <CheckCheck className="w-4 h-4 text-emerald-400" />
            Mark all as read ({unreadCount})
          </Button>
        )}
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => handleFilterChange(false)}
          className={cn(
            "px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors",
            !unreadOnly
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-white hover:bg-white/5",
          )}
          data-testid="filter-all"
        >
          All Notifications ({initialTotal})
        </button>
        <button
          onClick={() => handleFilterChange(true)}
          className={cn(
            "px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors flex items-center gap-1.5",
            unreadOnly
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-white hover:bg-white/5",
          )}
          data-testid="filter-unread"
        >
          Unread
          {unreadCount > 0 && (
            <span className="px-1.5 py-0.2 text-[10px] rounded-full bg-black/30 font-mono">
              {unreadCount}
            </span>
          )}
        </button>
      </div>

      {/* Notifications List */}
      {notifications.length === 0 ? (
        <div className="glass-card border border-white/10 rounded-xl p-12 text-center text-muted-foreground">
          <Bell className="w-12 h-12 mx-auto mb-3 opacity-20 text-white" />
          <h3 className="text-sm font-semibold text-white mb-1">No notifications found</h3>
          <p className="text-xs">
            {unreadOnly
              ? "You're all caught up! No unread notifications."
              : "You do not have any notifications yet."}
          </p>
        </div>
      ) : (
        <div className="glass-card border border-white/10 rounded-xl divide-y divide-white/5 overflow-hidden">
          {notifications.map((notif) => {
            const isUnread = !notif.readAt;
            return (
              <div
                key={notif.id}
                className={cn(
                  "p-4 sm:p-5 flex items-start gap-4 transition-colors hover:bg-white/[0.02]",
                  isUnread && "bg-primary/[0.03]",
                )}
                data-testid={`notification-row-${notif.id}`}
              >
                <div className="p-2.5 rounded-lg bg-white/5 border border-white/5 shrink-0 mt-0.5">
                  {getNotificationIcon(notif.type)}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">{notif.title}</span>
                      {isUnread && <span className="w-2 h-2 rounded-full bg-primary shrink-0" />}
                    </div>
                    <span className="text-xs font-mono text-muted-foreground">
                      {formatDate(notif.createdAt)}
                    </span>
                  </div>

                  <p className="text-xs sm:text-sm text-zinc-300 leading-relaxed mb-3">
                    {notif.message}
                  </p>

                  <div className="flex items-center gap-3">
                    {notif.link && (
                      <Link
                        href={notif.link}
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
                      >
                        View finding
                        <ExternalLink className="w-3.5 h-3.5" />
                      </Link>
                    )}

                    {isUnread && (
                      <button
                        onClick={() => handleMarkAsRead(notif.id)}
                        disabled={isPending}
                        className="text-xs text-muted-foreground hover:text-white flex items-center gap-1 transition-colors disabled:opacity-50"
                        title="Mark as read"
                      >
                        <Check className="w-3.5 h-3.5" />
                        Mark as read
                      </button>
                    )}

                    <button
                      onClick={() => handleDelete(notif.id)}
                      disabled={isPending}
                      className="text-xs text-muted-foreground hover:text-red-400 flex items-center gap-1 transition-colors ml-auto disabled:opacity-50"
                      title="Delete notification"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {pageCount > 1 && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-xs font-mono text-muted-foreground">
            Page {currentPage} of {pageCount}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage <= 1 || isPending}
              onClick={() => handlePageChange(currentPage - 1)}
              className="gap-1 border-white/10 text-xs"
            >
              <ChevronLeft className="w-4 h-4" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage >= pageCount || isPending}
              onClick={() => handlePageChange(currentPage + 1)}
              className="gap-1 border-white/10 text-xs"
            >
              Next
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
