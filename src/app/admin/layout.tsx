import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import Link from "next/link";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await auth();

  if (!session?.user || !session.user.roles?.includes("ADMIN")) {
    redirect("/");
  }

  return (
    <div className="flex min-h-screen bg-zinc-950 text-white">
      <aside className="w-64 border-r border-zinc-800 p-6 flex flex-col gap-4 bg-black">
        <h2 className="text-xl font-bold tracking-tighter">Admin Panel</h2>
        <nav className="flex flex-col gap-2 mt-8">
          <Link href="/admin" className="text-zinc-400 hover:text-white transition-colors">Dashboard</Link>
          <Link href="/admin/users" className="text-zinc-400 hover:text-white transition-colors">Users</Link>
          <Link href="/admin/logs" className="text-zinc-400 hover:text-white transition-colors">Audit Logs</Link>
        </nav>
      </aside>
      <main className="flex-1 p-8 overflow-y-auto">
        {children}
      </main>
    </div>
  );
}
