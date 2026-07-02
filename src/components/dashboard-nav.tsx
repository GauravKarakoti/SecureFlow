'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { ThemeToggle } from '@/components/theme-toggle';

export function DashboardNav() {
  const pathname = usePathname();

  const routes = [
    { href: '/dashboard', label: 'Overview' },
    { href: '/dashboard/audit', label: 'Security Audit' },
    { href: '/dashboard/findings', label: 'Findings' },
    { href: '/dashboard/policies', label: 'Policies' },
  ];

  return (
    <nav className="flex items-center justify-between px-6 py-4 border-b border-border bg-card">
      <div className="flex items-center space-x-6">
        <Link href="/dashboard" className="font-bold text-xl tracking-tight text-foreground">
          🛡️ SecureFlow
        </Link>
        <div className="flex items-center space-x-4">
          {routes.map((route) => (
            <Link
              key={route.href}
              href={route.href}
              className={cn(
                'text-sm font-medium transition-colors hover:text-primary',
                pathname === route.href ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              {route.label}
            </Link>
          ))}
        </div>
      </div>
      
      {/* Interactive Global Dark Mode Action Toggle Container */}
      <div className="flex items-center space-x-4">
        <ThemeToggle />
      </div>
    </nav>
  );
}