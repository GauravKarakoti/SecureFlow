"use client";

import { useState, useEffect, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bell,
  Check,
  CheckCheck,
  ShieldAlert,
  AtSign,
  Clock,
  ArrowRight,
  UserCheck,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  getLatestNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  type NotificationDto,
  type NotificationType,
} from "@/lib/actions/notifications";
import { cn } from "@/lib/utils";

function getNotificationIcon(type: NotificationType) {
  switch (type) {
    case "FINDING_ASSIGNED":
      return <UserCheck className="w-4 h-4 text-blue-400 shrink-0" />;
    case "MENTION":
      return <AtSign className="w-4 h-4 text-purple-400 shrink-0" />;
    case "DISMISSAL_EXPIRING":
      return <Clock className="w-4 h-4 text-amber-400 shrink-0" />;
    default:
      return <ShieldAlert className="w-4 h-4 text-primary shrink-0" />;
  }
}

function formatRelativeTime(dateInput: Date | string): string {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const now = new Date();
  const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}

export function NotificationsDropdown() {
  const router = useRouter();
  const [notifications, setNotifications] = useState<NotificationDto[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const loadNotifications = async () => {
    try {
      const data = await getLatestNotifications(5);
      setNotifications(data.notifications);
      setUnreadCount(data.unreadCount);
    } catch {
      // Quiet fail if session or network error
    }
  };

  useEffect(() => {
    loadNotifications();
    // Poll every 30 seconds for background refresh
    const interval = setInterval(loadNotifications, 30_000);
    return () => clearInterval(interval);
  }, []);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (open) {
      loadNotifications();
    }
  };

  const handleItemClick = (notif: NotificationDto) => {
    startTransition(async () => {
      if (!notif.readAt) {
        await markNotificationAsRead(notif.id);
        setNotifications((prev) =>
          prev.map((n) => (n.id === notif.id ? { ...n, readAt: new Date() } : n)),
        );
        setUnreadCount((c) => Math.max(0, c - 1));
      }
      setIsOpen(false);
      if (notif.link) {
        router.push(notif.link);
      }
    });
  };

  const handleMarkAllRead = (e: React.MouseEvent) => {
    e.stopPropagation();
    startTransition(async () => {
      await markAllNotificationsAsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, readAt: new Date() })));
      setUnreadCount(0);
    });
  };

  return (
    <DropdownMenu open={isOpen} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          className="relative w-11 h-11 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full text-muted-foreground hover:text-white hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title="Notifications"
          aria-label={unreadCount > 0 ? `${unreadCount} unread notifications` : "Notifications"}
          data-testid="notifications-bell"
        >
          <Bell className="w-4 h-4" />
          {unreadCount > 0 && (
            <span
              data-testid="unread-badge"
              className="absolute top-2 right-2 flex items-center justify-center px-1 min-w-[16px] h-4 text-[10px] font-bold text-white bg-primary rounded-full ring-2 ring-background animate-in zoom-in-75 duration-200"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        className="w-80 sm:w-96 p-0 bg-sidebar/95 backdrop-blur-md border border-white/10 shadow-2xl rounded-xl z-50 text-foreground"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
          <div className="flex items-center gap-2">
            <span className="font-headline font-semibold text-sm tracking-wide text-white">
              Notifications
            </span>
            {unreadCount > 0 && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-primary/20 text-primary border border-primary/30">
                {unreadCount} unread
              </span>
            )}
          </div>
          {unreadCount > 0 && (
            <button
              onClick={handleMarkAllRead}
              disabled={isPending}
              className="text-xs text-muted-foreground hover:text-white flex items-center gap-1 transition-colors disabled:opacity-50"
              data-testid="mark-all-read-dropdown"
            >
              <CheckCheck className="w-3.5 h-3.5" />
              Mark all as read
            </button>
          )}
        </div>

        <div className="max-h-80 overflow-y-auto divide-y divide-white/5">
          {notifications.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              <Bell className="w-8 h-8 mx-auto mb-2 opacity-30" />
              No notifications yet.
            </div>
          ) : (
            notifications.map((notif) => {
              const isUnread = !notif.readAt;
              return (
                <div
                  key={notif.id}
                  onClick={() => handleItemClick(notif)}
                  className={cn(
                    "flex items-start gap-3 p-3.5 transition-colors cursor-pointer text-left hover:bg-white/5",
                    isUnread && "bg-primary/5",
                  )}
                  data-testid={`notification-item-${notif.id}`}
                >
                  <div className="mt-0.5">{getNotificationIcon(notif.type)}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1 mb-0.5">
                      <p
                        className={cn(
                          "text-xs font-medium truncate",
                          isUnread ? "text-white font-semibold" : "text-zinc-300",
                        )}
                      >
                        {notif.title}
                      </p>
                      <span className="text-[10px] font-mono text-muted-foreground shrink-0">
                        {formatRelativeTime(notif.createdAt)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                      {notif.message}
                    </p>
                  </div>
                  {isUnread && <span className="w-2 h-2 rounded-full bg-primary shrink-0 mt-1.5" />}
                </div>
              );
            })
          )}
        </div>

        <DropdownMenuSeparator className="bg-white/5 m-0" />

        <div className="p-2 bg-white/[0.02]">
          <Link
            href="/dashboard/notifications"
            onClick={() => setIsOpen(false)}
            className="flex items-center justify-center gap-1.5 w-full py-2 text-xs font-semibold text-primary hover:text-primary/80 transition-colors"
          >
            <span>View all notifications</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
