"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  Search,
  LayoutDashboard,
  ShieldAlert,
  BarChart3,
  Lock,
  Cpu,
  History,
  Activity,
  Settings,
  Sun,
  Moon,
  Shield,
  ArrowRight,
  Command as CommandIcon,
} from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";

export interface CommandItem {
  id: string;
  name: string;
  category: "Navigation" | "Actions" | "Admin";
  icon: React.ComponentType<{ className?: string }>;
  keywords?: string[];
  shortcut?: string;
  perform: () => void;
  adminOnly?: boolean;
}

/**
 * Fuzzy score calculator.
 * Returns true if the query matches the target string or keywords,
 * supporting substring and sequential character matching.
 */
export function fuzzyMatch(pattern: string, text: string, keywords: string[] = []): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return true;

  const corpus = [text, ...keywords].join(" ").toLowerCase();
  if (corpus.includes(p)) return true;

  // Sequential character fuzzy matching
  let patternIdx = 0;
  for (let i = 0; i < corpus.length && patternIdx < p.length; i++) {
    if (corpus[i] === p[patternIdx]) {
      patternIdx++;
    }
  }
  return patternIdx === p.length;
}

function CommandPaletteContent({ setOpen }: { setOpen: (nextOpen: boolean) => void }) {
  const [query, setQuery] = React.useState("");
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const router = useRouter();
  const { data: session } = useSession();
  const { theme, toggleTheme } = useTheme();

  const roles = (session?.user as { roles?: string[] })?.roles || [];
  const isAdmin = Array.isArray(roles) && roles.includes("ADMIN");

  const navigateTo = React.useCallback(
    (path: string) => {
      setOpen(false);
      router.push(path);
    },
    [router, setOpen],
  );

  const items: CommandItem[] = React.useMemo(() => {
    const list: CommandItem[] = [
      {
        id: "nav-dashboard",
        name: "Go to Mission Control",
        category: "Navigation",
        icon: LayoutDashboard,
        keywords: ["home", "dashboard", "overview", "main"],
        perform: () => navigateTo("/dashboard"),
      },
      {
        id: "nav-findings",
        name: "Go to Breach Attempts (Findings)",
        category: "Navigation",
        icon: ShieldAlert,
        keywords: ["findings", "vulnerabilities", "breaches", "issues", "security"],
        perform: () => navigateTo("/dashboard/findings"),
      },
      {
        id: "nav-analytics",
        name: "Go to Analytics",
        category: "Navigation",
        icon: BarChart3,
        keywords: ["analytics", "metrics", "stats", "reports", "trends"],
        perform: () => navigateTo("/dashboard/analytics"),
      },
      {
        id: "nav-policies",
        name: "Go to Defense Strategy (Policies)",
        category: "Navigation",
        icon: Lock,
        keywords: ["policies", "defense", "strategy", "rules", "test policy"],
        perform: () => navigateTo("/dashboard/policies"),
      },
      {
        id: "nav-ai-health",
        name: "Go to AI Model Health",
        category: "Navigation",
        icon: Cpu,
        keywords: ["ai", "model", "health", "latency", "groq", "telemetry"],
        perform: () => navigateTo("/dashboard/ai-health"),
      },
      {
        id: "nav-audit",
        name: "Go to Vault Logs (Audit)",
        category: "Navigation",
        icon: History,
        keywords: ["audit", "logs", "vault", "history", "records"],
        perform: () => navigateTo("/dashboard/audit"),
      },
      {
        id: "nav-status",
        name: "Go to System Status",
        category: "Navigation",
        icon: Activity,
        keywords: ["status", "system", "health", "uptime"],
        perform: () => navigateTo("/dashboard/status"),
      },
      {
        id: "nav-settings",
        name: "Go to Settings",
        category: "Navigation",
        icon: Settings,
        keywords: ["settings", "preferences", "webhooks", "slack", "teams", "voice alerts"],
        perform: () => navigateTo("/dashboard/settings"),
      },
      {
        id: "action-toggle-theme",
        name: `Toggle Theme (current: ${theme || "dark"})`,
        category: "Actions",
        icon: theme === "dark" ? Sun : Moon,
        keywords: ["theme", "dark mode", "light mode", "color", "toggle"],
        perform: () => {
          toggleTheme();
          setOpen(false);
        },
      },
    ];

    if (isAdmin) {
      list.push({
        id: "admin-portal",
        name: "Go to Admin Portal",
        category: "Admin",
        icon: Shield,
        keywords: ["admin", "portal", "users", "queue", "system logs"],
        perform: () => navigateTo("/admin"),
        adminOnly: true,
      });
      list.push({
        id: "admin-users",
        name: "Admin: User Management",
        category: "Admin",
        icon: Shield,
        keywords: ["admin", "users", "roles", "permissions"],
        perform: () => navigateTo("/admin/users"),
        adminOnly: true,
      });
      list.push({
        id: "admin-queue",
        name: "Admin: Queue Monitor",
        category: "Admin",
        icon: Activity,
        keywords: ["admin", "queue", "jobs", "dlq", "worker"],
        perform: () => navigateTo("/admin/queue"),
        adminOnly: true,
      });
    }

    return list;
  }, [isAdmin, navigateTo, theme, toggleTheme, setOpen]);

  const filteredItems = React.useMemo(() => {
    return items.filter((item) => fuzzyMatch(query, item.name, item.keywords));
  }, [items, query]);

  // Handle keyboard navigation within the palette
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (filteredItems.length ? (prev + 1) % filteredItems.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        filteredItems.length ? (prev - 1 + filteredItems.length) % filteredItems.length : 0,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filteredItems[selectedIndex]) {
        filteredItems[selectedIndex].perform();
      }
    }
  };

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/4 -translate-x-1/2 z-50 w-full max-w-xl",
          "bg-black/90 border border-white/10 rounded-xl shadow-2xl overflow-hidden",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95",
          "focus:outline-none backdrop-blur-md",
        )}
        aria-label="Command Palette"
        role="dialog"
        onKeyDown={handleKeyDown}
      >
        <DialogPrimitive.Title className="sr-only">Command Palette</DialogPrimitive.Title>
        <DialogPrimitive.Description className="sr-only">
          Search navigation destinations and actions. Use arrow keys to navigate and Enter to
          select.
        </DialogPrimitive.Description>

        {/* Search Header */}
        <div className="flex items-center px-4 py-3.5 border-b border-white/10 bg-white/[0.02]">
          <Search className="w-5 h-5 text-muted-foreground mr-3 shrink-0" aria-hidden="true" />
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Type a command or search sections..."
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            autoFocus
            aria-label="Search commands"
            aria-autocomplete="list"
            aria-controls="command-palette-results"
            role="combobox"
            aria-expanded={filteredItems.length > 0}
          />
          <div className="flex items-center gap-1.5 ml-2">
            <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground bg-white/5 border border-white/10 rounded">
              ESC
            </kbd>
          </div>
        </div>

        {/* Results List */}
        <div
          id="command-palette-results"
          role="listbox"
          aria-label="Suggestions"
          className="max-h-80 overflow-y-auto p-2 space-y-1"
        >
          {filteredItems.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No matching commands found.
            </div>
          ) : (
            filteredItems.map((item, index) => {
              const Icon = item.icon;
              const isSelected = index === selectedIndex;
              return (
                <div
                  key={item.id}
                  id={`command-item-${item.id}`}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => item.perform()}
                  onMouseEnter={() => setSelectedIndex(index)}
                  className={cn(
                    "flex items-center justify-between px-3 py-2.5 rounded-lg text-sm cursor-pointer transition-colors select-none",
                    isSelected
                      ? "bg-primary/20 text-white font-medium border border-primary/30"
                      : "text-muted-foreground hover:bg-white/5 hover:text-foreground border border-transparent",
                  )}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={cn(
                        "w-7 h-7 rounded-md flex items-center justify-center shrink-0 transition-colors",
                        isSelected ? "bg-primary text-black" : "bg-white/5 text-muted-foreground",
                      )}
                    >
                      <Icon className="w-4 h-4" />
                    </div>
                    <span className="truncate">{item.name}</span>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] uppercase font-mono tracking-wider px-2 py-0.5 rounded bg-white/5 text-muted-foreground border border-white/5">
                      {item.category}
                    </span>
                    {isSelected && <ArrowRight className="w-3.5 h-3.5 text-primary" />}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer Shortcuts Info */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-white/10 bg-black/40 text-[11px] text-muted-foreground font-mono">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 bg-white/5 rounded border border-white/10">↑</kbd>
              <kbd className="px-1 py-0.5 bg-white/5 rounded border border-white/10">↓</kbd>
              <span>Navigate</span>
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 bg-white/5 rounded border border-white/10">↵</kbd>
              <span>Select</span>
            </span>
          </div>
          <div className="flex items-center gap-1">
            <CommandIcon className="w-3 h-3" />
            <span>SecureFlow Command Palette</span>
          </div>
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function CommandPalette({
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
} = {}) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
  const isOpen = controlledOpen !== undefined ? controlledOpen : uncontrolledOpen;
  const setOpen = React.useCallback(
    (nextOpen: boolean) => {
      if (controlledOnOpenChange) {
        controlledOnOpenChange(nextOpen);
      } else {
        setUncontrolledOpen(nextOpen);
      }
    },
    [controlledOnOpenChange],
  );

  // Global keyboard shortcut: Ctrl+K or Cmd+K
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen(!isOpen);
      } else if (isOpen && e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, setOpen]);

  return (
    <DialogPrimitive.Root open={isOpen} onOpenChange={setOpen}>
      <CommandPaletteContent key={isOpen ? "open" : "closed"} setOpen={setOpen} />
    </DialogPrimitive.Root>
  );
}
