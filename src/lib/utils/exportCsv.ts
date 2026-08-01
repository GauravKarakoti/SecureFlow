export function downloadCSV(data: any[], filename: string) {
  if (!data || !data.length) return;

  // Extract headers
  const headers = Object.keys(data[0]);

  // Map rows
  const csvRows = data.map(row => {
    return headers.map(fieldName => {
      let val = row[fieldName];
      
      // Handle objects/arrays (e.g., metadata)
      if (typeof val === 'object' && val !== null) {
        val = JSON.stringify(val);
      }
      
      // Handle nulls
      if (val === null || val === undefined) {
        val = "";
      }

      // Convert to string and escape quotes
      let stringVal = String(val);
      if (stringVal.includes(',') || stringVal.includes('"') || stringVal.includes('\n')) {
        stringVal = `"${stringVal.replace(/"/g, '""')}"`;
      }
      return stringVal;
    }).join(',');
  });

  // Combine headers and rows
  const csvString = [headers.join(','), ...csvRows].join('\n');

  // Trigger download
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
