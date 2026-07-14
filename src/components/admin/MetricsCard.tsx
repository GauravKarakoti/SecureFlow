import React from "react";

interface MetricsCardProps {
  title: string;
  value: number | string;
  icon?: React.ReactNode;
}

export default function MetricsCard({ title, value, icon }: MetricsCardProps) {
  return (
    <div className="glass-card group overflow-hidden rounded-xl border border-white/10 p-6 transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-[0_0_35px_hsl(var(--primary)/0.15)]">
      <div className="flex items-center justify-between mb-5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
        {icon && (
          <div className="rounded-xl bg-primary/10 p-3 shadow-lg shadow-primary/10 transition-all duration-300 group-hover:scale-110 group-hover:bg-primary/20">
            {icon}
          </div>
        )}
      </div>
      <p className="font-headline text-3xl font-bold tracking-tight text-foreground">{value}</p>
    </div>
  );
}
