import React from "react";

interface MetricsCardProps {
  title: string;
  value: number | string;
  icon?: React.ReactNode;
}

export default function MetricsCard({ title, value, icon }: MetricsCardProps) {
  return (
    <div className="glass-card group relative overflow-hidden rounded-xl border border-white/10 p-6 transition-all duration-500 hover:-translate-y-1.5 hover:border-primary/50 hover:shadow-[0_0_30px_rgba(229,9,20,0.15)]">
      {/* Glow Effect Background */}
      <div className="absolute -right-10 -top-10 w-24 h-24 bg-primary/10 rounded-full blur-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-700" />
      
      {/* Top glowing accent line */}
      <div className="absolute top-0 left-0 w-0 h-[2px] bg-gradient-to-r from-primary to-red-400 group-hover:w-full transition-all duration-500" />

      <div className="flex items-center justify-between mb-5 relative z-10">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground group-hover:text-primary transition-colors duration-300">
          {title}
        </h3>
        {icon && (
          <div className="rounded-lg bg-white/5 border border-white/10 p-2.5 transition-all duration-300 group-hover:scale-110 group-hover:bg-primary/20 group-hover:border-primary/30 group-hover:text-primary">
            {icon}
          </div>
        )}
      </div>
      
      <div className="relative z-10">
        <p className="font-headline text-3xl font-black tracking-tight text-foreground transition-all duration-300">
          {value}
        </p>
      </div>
    </div>
  );
}

