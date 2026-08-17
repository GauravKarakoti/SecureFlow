import { toCsv } from './csv';

/**
 * Serialise `data` and hand it to the browser as a file download.
 *
 * Serialisation lives in `./csv` so this helper and the server-side
 * `/api/admin/export` route produce byte-identical output and share a single
 * formula-injection defence.
 */
export function downloadCSV(data: Array<Record<string, unknown>>, filename: string) {
  if (!data || !data.length) return;

  const csvString = toCsv(data);
  if (!csvString) return;

  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);

  try {
    link.click();
  } finally {
    // The anchor and the object URL are both released even if `click()` throws.
    // Without the revoke, every export pinned its blob in memory for the lifetime
    // of the tab.
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}
