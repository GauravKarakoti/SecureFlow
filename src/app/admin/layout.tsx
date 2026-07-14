import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { AdminSidebarNav, AdminMobileNav } from "@/components/admin/AdminNav";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await auth();

  // Hard gate: only ADMINs may render anything under /admin.
  if (!session?.user || !session.user.roles?.includes("ADMIN")) {
    redirect("/");
  }

  return (
    <div className="flex min-h-screen bg-zinc-950 text-white">
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
