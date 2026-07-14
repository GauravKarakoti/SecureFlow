import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import Link from "next/link";
import Image from "next/image";
import { LayoutDashboard, Users, History, ShieldAlert } from "lucide-react";
import { AdminNavLink } from "@/components/admin/AdminNavLink";
import { ThemeToggle } from "@/components/theme-toggle";

const ADMIN_NAV_ITEMS = [
  { name: "Dashboard", href: "/admin", icon: LayoutDashboard },
  { name: "Users", href: "/admin/users", icon: Users },
  { name: "Audit Logs", href: "/admin/logs", icon: History },
];
import { AdminSidebarNav, AdminMobileNav } from "@/components/admin/AdminNav";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await auth();

  // Hard gate: only ADMINs may render anything under /admin.
  if (!session?.user || !session.user.roles?.includes("ADMIN")) {
    redirect("/");
  }

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Sidebar */}
      <aside className="hidden lg:flex w-64 border-r border-white/5 bg-sidebar min-h-screen flex-col gap-8">
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
          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest px-3 mb-2 font-mono flex items-center gap-2">
            <ShieldAlert className="w-3 h-3 text-primary" />
            Admin Panel
          </p>
          {ADMIN_NAV_ITEMS.map((item) => (
            <AdminNavLink
              key={item.href}
              href={item.href}
              icon={<item.icon className="w-4 h-4 shrink-0" />}
            >
              {item.name}
            </AdminNavLink>
          ))}

          <div className="my-4 border-t border-white/5" />

          <Link
            href="/dashboard"
            className="flex items-center gap-3 px-3 py-2.5 rounded-sm text-sm font-bold uppercase tracking-wide transition-all text-muted-foreground hover:bg-white/5 hover:text-white border-l-2 border-transparent"
          >
            Back to Dashboard
          </Link>
        </nav>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 border-b border-white/5 px-4 sm:px-8 flex items-center justify-between glass-card sticky top-0 z-40">
          <div className="text-sm text-muted-foreground flex items-center gap-1">
            <ShieldAlert className="w-4 h-4 text-primary mr-1" />
            <span className="text-white font-medium">Admin</span>
          </div>
          <ThemeToggle />
        </header>
        <main className="flex-1 p-4 sm:p-6 lg:p-8 overflow-y-auto">
          {children}
        </main>
      </div>

      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-64 border-r border-zinc-800 px-4 py-6 flex-col gap-6 bg-black sticky top-0 h-screen">
        <AdminSidebarNav />
      </aside>

      {/* Mobile top bar */}
      <div className="lg:hidden fixed top-0 inset-x-0 z-40 h-14 bg-black border-b border-zinc-800 flex items-center px-4">
        <AdminMobileNav />
      </div>

      <main className="flex-1 p-4 sm:p-6 lg:p-8 overflow-y-auto pt-20 lg:pt-8">
        {children}
      </main>
    </div>
  );
}