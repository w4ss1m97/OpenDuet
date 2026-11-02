/** A cell that a spreadsheet would run as a formula gets a leading apostrophe. */
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: string | number): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** CSV with CRLF lines: every string is quoted (quotes doubled) and defused against formulas; numbers stay bare. */
export function toCsv(header: string[], rows: Array<Array<string | number>>): string {
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
