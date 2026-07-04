"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";
import {
  LayoutDashboard,
  ShieldAlert,
  History,
  Lock,
  LogOut,
  Menu,
  X,
} from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";

const NAV_ITEMS = [
  { name: "Overview", href: "/dashboard", icon: LayoutDashboard },
  { name: "Findings", href: "/dashboard/findings", icon: ShieldAlert },
  { name: "Policies", href: "/dashboard/policies", icon: Lock },
  { name: "Audit Logs", href: "/dashboard/audit", icon: History },
];

// ─── Sidebar Content (shared between desktop sidebar & mobile drawer) ─────────
function SidebarContent({ onNavClick }: { onNavClick?: () => void }) {
  const pathname = usePathname();

  return (
    <>
      {/* Logo */}
      <div className="flex items-center gap-2 px-6 pt-6 pb-4">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center glow-primary">
          <Image
            src="/logo.jpeg"
            alt="SecureFlow Logo"
            width={28}
            height={28}
            className="object-contain"
          />
        </div>
        <span className="font-headline font-bold text-lg tracking-tight">
          SecureFlow
        </span>
      </div>

      {/* Nav Items */}
      <nav className="flex flex-col gap-1 px-3">
        <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest px-3 mb-2">
          Main Menu
        </p>
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavClick}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-white/5 hover:text-white"
              )}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {item.name}
            </Link>
          );
        })}
      </nav>
    </>
  );
}

// ─── Desktop Sidebar ──────────────────────────────────────────────────────────
export function DashboardSidebar() {
  return (
    <aside className="hidden lg:flex w-64 border-r border-white/5 bg-sidebar min-h-screen flex-col gap-8">
      <SidebarContent />
    </aside>
  );
}

// ─── Mobile Drawer ────────────────────────────────────────────────────────────
export function MobileDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  // Lock body scroll when open
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-300 lg:hidden",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        )}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer Panel */}
      <div
        className={cn(
          "fixed top-0 left-0 z-50 h-full w-72 bg-sidebar border-r border-white/5 flex flex-col gap-4 transition-transform duration-300 ease-in-out lg:hidden",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* Close button */}
        <div className="flex justify-end px-4 pt-4">
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full text-muted-foreground hover:text-white hover:bg-white/5 transition-colors"
            aria-label="Close menu"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <SidebarContent onNavClick={onClose} />
      </div>
    </>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────────
export function DashboardHeader({
  user,
  onMenuClick,
}: {
  user?: { name?: string | null; email?: string | null; image?: string | null };
  onMenuClick?: () => void;
}) {
  return (
    <header className="h-16 border-b border-white/5 px-4 sm:px-8 flex items-center justify-between glass-card sticky top-0 z-40">
      <div className="flex items-center gap-3">
        {/* Hamburger — only visible on mobile */}
        <button
          onClick={onMenuClick}
          className="lg:hidden w-8 h-8 flex items-center justify-center rounded-full text-muted-foreground hover:text-white hover:bg-white/5 transition-colors"
          aria-label="Open menu"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="text-sm text-muted-foreground">
          <span className="text-white font-medium">User</span> /{" "}
          {user?.name || "User"}
        </div>
      </div>

      <div className="flex items-center gap-3 sm:gap-4">
        <ThemeToggle />

        {user?.image ? (
          <Image
            src={user.image}
            alt={user.name || "Profile"}
            width={32}
            height={32}
            className="rounded-full border border-primary/30"
          />
        ) : (
          <div className="w-8 h-8 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center text-[10px] font-bold text-white shrink-0">
            {user?.name ? user.name.slice(0, 2).toUpperCase() : "NA"}
          </div>
        )}

        {/* Logout Button */}
        <button
          onClick={() => signOut({ callbackUrl: "/" })}
          className="w-8 h-8 flex items-center justify-center rounded-full text-muted-foreground hover:text-white hover:bg-white/5 transition-colors"
          title="Log out"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}