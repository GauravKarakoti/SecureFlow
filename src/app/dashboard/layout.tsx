import { DashboardSidebar, DashboardHeader } from "@/components/dashboard-nav";
import { auth } from "@/auth";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Fetch the session on the server
  const session = await auth();

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <DashboardSidebar />
      <div className="flex-1 flex flex-col min-w-0">
        {/* Pass the user data down to the client component */}
        <DashboardHeader user={session?.user} />
        <main className="flex-1 p-8 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}