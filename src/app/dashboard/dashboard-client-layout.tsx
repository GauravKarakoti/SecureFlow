"use client";

import { useState } from "react";
import { DashboardSidebar, DashboardHeader, MobileDrawer } from "@/components/dashboard-nav";
import { useSession } from "next-auth/react";
import { VoiceAlertProvider } from "@/components/audio/voice-alert-provider";
import { CommandPalette } from "@/components/command-palette";

export function DashboardClientLayout({
  children,
  voiceAlertsEnabled,
}: {
  children: React.ReactNode;
  voiceAlertsEnabled: boolean;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { data: session } = useSession();

  return (
    <VoiceAlertProvider voiceAlertsEnabled={voiceAlertsEnabled}>
      <div className="flex min-h-screen bg-background text-foreground">
        {/* Desktop Sidebar */}
        <DashboardSidebar />

        {/* Mobile Slide-out Drawer */}
        <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />

        {/* Global Command Palette (Ctrl/Cmd + K) */}
        <CommandPalette />

        {/* Main Content */}
        <div className="flex-1 flex flex-col min-w-0">
          <DashboardHeader user={session?.user} onMenuClick={() => setDrawerOpen(true)} />
          <main className="flex-1 p-4 sm:p-6 lg:p-8 overflow-y-auto">{children}</main>
        </div>
      </div>
    </VoiceAlertProvider>
  );
}
