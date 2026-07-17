import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { ShieldAlert } from "lucide-react";
import { AdminSidebarNav, AdminMobileNav } from "@/components/admin/AdminNav";
import { ThemeToggle } from "@/components/theme-toggle";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await auth();

  // Hard gate: only ADMINs may render anything under /admin.
  if (!session?.user || !session.user.roles?.includes("ADMIN")) {
    redirect("/");
  }

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-64 border-r border-white/5 bg-sidebar min-h-screen flex-col gap-6 p-4 sticky top-0 h-screen shrink-0">
        <AdminSidebarNav />
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile Header */}
        <div className="lg:hidden fixed top-0 inset-x-0 z-40 h-14 bg-sidebar border-b border-white/5 flex items-center justify-between px-4">
          <AdminMobileNav />
          <ThemeToggle />
        </div>

        {/* Desktop Header */}
        <header className="hidden lg:flex h-16 border-b border-white/5 px-8 items-center justify-between glass-card sticky top-0 z-40 shrink-0">
          <div className="text-sm text-muted-foreground flex items-center gap-1">
            <ShieldAlert className="w-4 h-4 text-primary mr-1 animate-pulse" />
            <span className="text-white font-semibold uppercase tracking-wider text-xs font-mono">SecureFlow System Control</span>
          </div>
          <ThemeToggle />
        </header>

        {/* Children content area */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 overflow-y-auto pt-20 lg:pt-8">
          {children}
        </main>
      </div>
    </div>
  );
}
