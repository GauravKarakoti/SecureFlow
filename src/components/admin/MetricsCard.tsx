import React from "react";

interface MetricsCardProps {
  title: string;
  value: number | string;
}

export default function MetricsCard({ title, value }: MetricsCardProps) {
  return (
    <div className="p-6 bg-zinc-900 border border-zinc-800 rounded-xl shadow-sm">
      <h3 className="text-sm font-medium text-zinc-400">{title}</h3>
      <p className="mt-2 text-3xl font-bold text-white">{value}</p>
    </div>
  );
}
