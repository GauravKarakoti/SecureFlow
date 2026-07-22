"use client";

import React, { useState } from "react";

export default function AuditLogTable({ logs }: { logs: any[] }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const itemsPerPage = 10;

  // Ensure logs is an array to prevent errors if undefined/null is passed
  const safeLogs = Array.isArray(logs) ? logs : [];

  const filteredLogs = safeLogs.filter((log) => {
    const searchLower = search.toLowerCase();
    const actionMatch = log.action?.toLowerCase().includes(searchLower);
    // Use resource instead of details based on the table headers
    const resourceMatch = log.resource?.toLowerCase().includes(searchLower);
    return actionMatch || resourceMatch;
  });

  const totalItems = filteredLogs.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage) || 1;
  const startIndex = (page - 1) * itemsPerPage;
  const currentLogs = filteredLogs.slice(startIndex, startIndex + itemsPerPage);

  const handlePrev = () => setPage((p) => Math.max(1, p - 1));
  const handleNext = () => setPage((p) => Math.min(totalPages, p + 1));

  // Reset page when search changes
  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value);
    setPage(1);
  };

  return (
    <div className="w-full glass-card rounded-xl border border-white/10 overflow-hidden">
      <div className="p-4 border-b border-white/5">
        <input
          type="text"
          placeholder="Filter logs by action or resource..."
          value={search}
          onChange={handleSearch}
          className="bg-background border border-border text-foreground text-sm rounded-sm px-4 py-2 w-full max-w-sm focus:outline-none focus:ring-2 focus:ring-primary placeholder:text-muted-foreground"
        />
      </div>
      <table className="w-full text-left text-sm text-muted-foreground">
        <thead className="bg-black/20 text-muted-foreground text-xs uppercase tracking-wider border-b border-white/5">
          <tr>
            <th className="px-6 py-4">Action</th>
            <th className="px-6 py-4">Resource</th>
            <th className="px-6 py-4">Timestamp</th>
          </tr>
        </thead>
        <tbody>
          {currentLogs.length > 0 ? (
            currentLogs.map((log) => (
              <tr key={log.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td className="px-6 py-4 text-foreground">{log.action}</td>
                <td className="px-6 py-4">{log.resource}</td>
                <td className="px-6 py-4" suppressHydrationWarning>
                  {new Date(log.timestamp).toLocaleString()}
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={3} className="px-6 py-4 text-center text-muted-foreground">
                No logs found.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="p-4 border-t border-white/5 flex justify-between items-center text-sm">
        <span>Showing {totalItems === 0 ? 0 : startIndex + 1} to {Math.min(startIndex + itemsPerPage, totalItems)} of {totalItems} results</span>
        <div className="space-x-2">
          <button
            onClick={handlePrev}
            disabled={page === 1}
            className="px-3 py-1 bg-white/5 text-foreground rounded-sm hover:bg-primary/10 hover:text-primary transition-colors disabled:opacity-50"
          >
            Previous
          </button>
          <button
            onClick={handleNext}
            disabled={page === totalPages}
            className="px-3 py-1 bg-white/5 text-foreground rounded-sm hover:bg-primary/10 hover:text-primary transition-colors disabled:opacity-50"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
