"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Users,
  ScrollText,
  ShieldAlert,
  ArrowLeft,
  Activity,
} from "lucide-react";

const ADMIN_NAV = [
  { name: "Dashboard", href: "/admin", icon: LayoutDashboard, exact: true },
  { name: "Queue Monitor", href: "/admin/queue", icon: Activity, exact: false },
  { name: "Users", href: "/admin/users", icon: Users, exact: false },
  { name: "Audit Logs", href: "/admin/logs", icon: ScrollText, exact: false },
];

function isActive(pathname: string | null, href: string, exact: boolean) {
  if (!pathname) return false;
  return exact ? pathname === href : pathname.startsWith(href);
}

export function AdminSidebarNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1">
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-md bg-red-500/10 border border-red-500/30 flex items-center justify-center">
            <ShieldAlert className="w-4 h-4 text-red-400" />
          </div>
          <div className="flex flex-col">
            <span className="font-bold text-sm tracking-tight">Admin Panel</span>
            <span className="text-[10px] text-red-400 uppercase tracking-widest font-mono">
              Restricted Access
            </span>
          </div>
        </div>
      </div>

      <div className="my-2 border-t border-zinc-800" />

      <p className="text-[10px] font-bold text-zinc-600 uppercase tracking-widest px-3 mb-1 font-mono">
        Management
      </p>
      {ADMIN_NAV.map((item) => {
        const Icon = item.icon;
        const active = isActive(pathname, item.href, item.exact);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all border-l-2",
              active
                ? "bg-red-500/10 text-red-400 border-red-500"
                : "text-zinc-400 hover:text-white hover:bg-white/5 border-transparent"
            )}
          >
            <Icon className="w-4 h-4 shrink-0" />
            {item.name}
          </Link>
        );
      })}

      <div className="my-2 border-t border-zinc-800" />

      <Link
        href="/dashboard"
        className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-zinc-400 hover:text-white hover:bg-white/5 transition-all border-l-2 border-transparent"
      >
        <ArrowLeft className="w-4 h-4 shrink-0" />
        Back to Dashboard
      </Link>
    </nav>
  );
}

export function AdminMobileNav() {
  const pathname = usePathname();

  return (
    <div className="flex items-center gap-1 overflow-x-auto w-full no-scrollbar">
      <div className="flex items-center gap-2 pr-3 mr-1 border-r border-zinc-800 shrink-0">
        <ShieldAlert className="w-4 h-4 text-red-400" />
        <span className="font-bold text-sm">Admin</span>
      </div>
      {ADMIN_NAV.map((item) => {
        const Icon = item.icon;
        const active = isActive(pathname, item.href, item.exact);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap shrink-0",
              active
                ? "bg-red-500/10 text-red-400"
                : "text-zinc-400 hover:text-white hover:bg-white/5"
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {item.name}
          </Link>
        );
      })}
    </div>
  );
}
