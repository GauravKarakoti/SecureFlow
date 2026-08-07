"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { cn } from "@/lib/utils";
import { useEffect } from "react";
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
import { CyberTextReveal } from "@/components/cyber-text-reveal";
import { CyberAvatarReveal } from "@/components/cyber-avatar-reveal";

// Themed Navigation Items
const NAV_ITEMS = [
  { name: "Mission Control", href: "/dashboard", icon: LayoutDashboard },
  { name: "Breach Attempts", href: "/dashboard/findings", icon: ShieldAlert },
  { name: "Defense Strategy", href: "/dashboard/policies", icon: Lock },
  { name: "Vault Logs", href: "/dashboard/audit", icon: History },
];

// ─── SidebarContent ───────────────────────────────────────────────────────────
function SidebarContent({ onNavClick }: { onNavClick?: () => void }) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const roles = (session?.user as any)?.roles || [];
  const isAdmin = roles.includes("ADMIN");

  return (
    <>
      <div className="flex items-center gap-2 px-6 pt-6 pb-4">
        <div className="w-8 h-8 rounded-sm flex items-center justify-center bg-primary glow-primary">
          <Image
            src="/logo.png"
            alt="SecureFlow Logo"
            width={64}
            height={64}
            className="object-contain"
          />
        </div>
        <span className="font-headline font-bold text-lg tracking-widest uppercase">
          SecureFlow
        </span>
      </div>

      <nav className="flex flex-col gap-1 px-3">
        <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest px-3 mb-2 font-mono">
          System Access
        </p>
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href || "#"}
              onClick={onNavClick}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-sm text-sm font-bold uppercase tracking-wide transition-all",
                isActive
                  ? "bg-primary/10 text-primary border-l-2 border-primary"
                  : "text-muted-foreground hover:bg-white/5 hover:text-white border-l-2 border-transparent"
              )}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {item.name}
            </Link>
          );
        })}
        {isAdmin && (
          <>
            <div className="my-4 border-t border-zinc-800/50"></div>
            <Link
              href="/admin"
              onClick={onNavClick}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-sm text-sm font-bold uppercase tracking-wide transition-all mt-4",
                pathname?.startsWith("/admin")
                  ? "bg-red-500/10 text-red-500 border-l-2 border-red-500"
                  : "text-muted-foreground hover:bg-white/5 hover:text-white border-l-2 border-transparent"
              )}
            >
              <ShieldAlert className="w-4 h-4 shrink-0" />
              Admin Portal
            </Link>
          </>
        )}
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
  user?: {
    name?: string | null;
    email?: string | null;
    image?: string | null;
    codename?: string | null;
  };
  onMenuClick?: () => void;
}) {
  return (
    <header className="h-16 border-b border-white/5 px-4 sm:px-8 flex items-center justify-between glass-card sticky top-0 z-40">

      {/* ── Left: breadcrumb + username ───────────────────────── */}
      <div className="flex items-center gap-3">
        {/* Hamburger — mobile only */}
        <button
          onClick={onMenuClick}
          className="lg:hidden w-8 h-8 flex items-center justify-center rounded-full text-muted-foreground hover:text-white hover:bg-white/5 transition-colors"
          aria-label="Open menu"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="text-sm text-muted-foreground flex items-center gap-1">
          <span className="text-white font-medium">User</span>
          <span>/</span>
          {/* Username — scrambles into real name on hover (see CyberTextReveal) */}
          <CyberTextReveal codename={user?.codename} realName={user?.name} />
        </div>
      </div>

      {/* ── Right: theme toggle + avatar + logout ─────────────── */}
      <div className="flex items-center gap-3 sm:gap-4">
        {/* ThemeToggle is the leftmost item of this action cluster */}
        <ThemeToggle />

        {/* Avatar — glitch-dissolves between VenetianMask and GitHub avatar (see CyberAvatarReveal) */}
        <CyberAvatarReveal image={user?.image} name={user?.name} />

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
