// Parses "address,amount" rows from pasted text, an uploaded file's
// content, or a fetched Google Sheets CSV export — all three reduce to
// plain CSV text by the time they reach parseAddressAmountRows.

import { isPlausibleAddress } from "./gno-address.js";

// Splits a line into up to two fields on the first comma, or on
// whitespace if there's no comma (covers a tab/space-separated paste).
function splitRow(line) {
  const commaIdx = line.indexOf(",");
  if (commaIdx !== -1) {
    return [line.slice(0, commaIdx).trim(), line.slice(commaIdx + 1).trim()];
  }
  const parts = line.trim().split(/\s+/);
  return [parts[0], parts.slice(1).join(" ")];
}

// Recognized column-header names — only used to decide whether to skip a
// header row. Deliberately narrow: a first row that merely fails address
// validation is NOT assumed to be a header (that would silently swallow
// a genuine typo'd first data row) — it's just treated as an invalid row
// like any other, visible in the caller's preview table.
const HEADER_KEYWORDS = /^(address|wallet|recipient|to|account)$/i;

// Returns { rows, headerSkipped }. Each row is
// { lineNumber, address, amount, valid, error }. `amount` is null when
// the row only has an address — callers substitute a shared default
// amount for those (supports "same amount to everyone" without requiring
// a redundant amount column on every row).
export function parseAddressAmountRows(text) {
  const lines = String(text).split(/\r?\n/);
  const rows = [];
  let headerSkipped = false;
  let sawFirstRow = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;

    const [addressField, amountField] = splitRow(raw);

    if (!sawFirstRow) {
      sawFirstRow = true;
      if (HEADER_KEYWORDS.test(addressField)) {
        headerSkipped = true;
        continue;
      }
    }

    const lineNumber = i + 1;
    const address = addressField;
    const amount = amountField ? amountField : null;

    if (!isPlausibleAddress(address)) {
      rows.push({ lineNumber, address, amount, valid: false, error: `"${address}" doesn't look like a valid gno.land address.` });
      continue;
    }
    if (amount != null && !/^\d+(\.\d+)?$/.test(amount)) {
      rows.push({ lineNumber, address, amount, valid: false, error: `"${amount}" isn't a valid non-negative amount.` });
      continue;
    }

    rows.push({ lineNumber, address, amount, valid: true, error: null });
  }

  return { rows, headerSkipped };
}

// Converts a normal Google Sheets share URL into the CSV export URL
// verified (via a real HTTP request against Google's own sample sheet,
// not assumed) to be cross-origin fetchable for any sheet shared "Anyone
// with the link can view". Handles both the common share/edit URL shape
// and an already-published ("File > Publish to web") URL shape. Throws a
// clear error for anything that isn't a Sheets URL at all.
export function sheetsUrlToCsvExportUrl(url) {
  const str = String(url).trim();
  const gidMatch = str.match(/[?&#]gid=(\d+)/);
  const gid = gidMatch ? gidMatch[1] : "0";

  // Published form: .../spreadsheets/d/e/<pubId>/... — check this first,
  // since its id segment would otherwise also match the normal-share
  // pattern below (with "e" mistaken for the id).
  const pubMatch = str.match(/\/spreadsheets\/d\/e\/([a-zA-Z0-9-_]+)/);
  if (pubMatch) {
    return `https://docs.google.com/spreadsheets/d/e/${pubMatch[1]}/pub?output=csv&gid=${gid}`;
  }

  // Normal share/edit form: .../spreadsheets/d/<id>/edit#gid=<gid>
  const idMatch = str.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (idMatch) {
    return `https://docs.google.com/spreadsheets/d/${idMatch[1]}/export?format=csv&gid=${gid}`;
  }

  throw new Error("Doesn't look like a Google Sheets URL.");
}

// Serializes rows of plain strings into CSV text — quotes a field only
// when it contains a comma, quote, or newline (the RFC 4180 minimum),
// doubling any embedded quotes. `headers` is one row, `rows` is an array
// of same-length arrays.
export function toCsv(headers, rows) {
  const field = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers, ...rows].map((row) => row.map(field).join(","));
  return lines.join("\r\n");
}

// Triggers a browser download of CSV text as a named file — the same
// Blob-URL-click-revoke pattern already used inline in a few other pages
// here, pulled out so a new page can just call this instead of
// re-implementing it again.
export function downloadCsv(filename, csvText) {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
