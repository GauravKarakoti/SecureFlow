"use client";

import Link from "next/link";
import { getVersionInfo } from "@/lib/version";

export function DashboardFooter() {
  const { version, commit } = getVersionInfo();
  const shortCommit = commit && commit !== "development" && commit !== "unknown" ? commit.slice(0, 7) : null;

  return (
    <footer
      data-testid="dashboard-footer"
      className="border-t border-white/5 py-3 px-4 sm:px-8 text-xs text-muted-foreground flex flex-col sm:flex-row items-center justify-between gap-2 bg-background/50 backdrop-blur-sm"
    >
      <div className="flex items-center gap-2">
        <span className="font-medium text-foreground">SecureFlow Mission Control</span>
        <span className="text-zinc-600">·</span>
        <span className="font-mono text-zinc-400" data-testid="dashboard-version">
          v{version}
        </span>
        {shortCommit && (
          <span className="font-mono text-zinc-500 text-[11px]" title={`Commit SHA: ${commit}`}>
            ({shortCommit})
          </span>
        )}
      </div>

      <div className="flex items-center gap-4 text-xs text-zinc-500">
        <Link
          href="https://github.com/GauravKarakoti/SecureFlow/blob/main/CHANGELOG.md"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground transition-colors"
        >
          Changelog
        </Link>
        <span>·</span>
        <Link
          href="/api/version"
          target="_blank"
          className="hover:text-foreground transition-colors font-mono"
        >
          /api/version
        </Link>
      </div>
    </footer>
  );
}
