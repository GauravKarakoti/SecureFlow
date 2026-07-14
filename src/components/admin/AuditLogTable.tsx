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
    <div className="w-full bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
      <div className="p-4 border-b border-zinc-800">
        <input 
          type="text" 
          placeholder="Filter logs by action or resource..." 
          value={search}
          onChange={handleSearch}
          className="bg-black border border-zinc-700 text-white text-sm rounded-lg px-4 py-2 w-full max-w-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <table className="w-full text-left text-sm text-zinc-400">
        <thead className="bg-zinc-950 text-zinc-500 text-xs uppercase border-b border-zinc-800">
          <tr>
            <th className="px-6 py-4">Action</th>
            <th className="px-6 py-4">Resource</th>
            <th className="px-6 py-4">Timestamp</th>
          </tr>
        </thead>
        <tbody>
          {currentLogs.length > 0 ? (
            currentLogs.map((log) => (
              <tr key={log.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/50 transition-colors">
                <td className="px-6 py-4">{log.action}</td>
                <td className="px-6 py-4">{log.resource}</td>
                <td className="px-6 py-4">
                  {new Date(log.timestamp).toLocaleString()}
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={3} className="px-6 py-4 text-center text-zinc-500">
                No logs found.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="p-4 border-t border-zinc-800 flex justify-between items-center text-sm">
        <span>Showing {totalItems === 0 ? 0 : startIndex + 1} to {Math.min(startIndex + itemsPerPage, totalItems)} of {totalItems} results</span>
        <div className="space-x-2">
          <button 
            onClick={handlePrev}
            disabled={page === 1}
            className="px-3 py-1 bg-zinc-800 rounded hover:bg-zinc-700 transition-colors disabled:opacity-50"
          >
            Previous
          </button>
          <button 
            onClick={handleNext}
            disabled={page === totalPages}
            className="px-3 py-1 bg-zinc-800 rounded hover:bg-zinc-700 transition-colors disabled:opacity-50"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
