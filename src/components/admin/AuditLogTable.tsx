"use client";

import React, { useState } from "react";

export default function AuditLogTable() {
  const [filter, setFilter] = useState("");

  return (
    <div className="w-full bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
      <div className="p-4 border-b border-zinc-800">
        <input 
          type="text" 
          placeholder="Filter logs..." 
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
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
          <tr className="border-b border-zinc-800/50 hover:bg-zinc-800/50 transition-colors">
            <td className="px-6 py-4">USER_LOGIN</td>
            <td className="px-6 py-4">Authentication Service</td>
            <td className="px-6 py-4">Just now</td>
          </tr>
        </tbody>
      </table>
      <div className="p-4 border-t border-zinc-800 flex justify-between items-center text-sm">
        <span>Showing 1 of 1 results</span>
        <div className="space-x-2">
          <button className="px-3 py-1 bg-zinc-800 rounded hover:bg-zinc-700 transition-colors disabled:opacity-50" disabled>Previous</button>
          <button className="px-3 py-1 bg-zinc-800 rounded hover:bg-zinc-700 transition-colors disabled:opacity-50" disabled>Next</button>
        </div>
      </div>
    </div>
  );
}
