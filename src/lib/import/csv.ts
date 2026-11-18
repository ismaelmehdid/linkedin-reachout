/**
 * An RFC 4180 CSV parser: fields split on commas, records on CRLF or LF (a lone CR too), quoted fields
 * that hold commas, line breaks and doubled quotes. A byte order mark at the start and one trailing
 * line break are ignored. Pure: it runs in the browser and in the tests.
 *
 * It is lenient where the RFC is strict: a quote inside an unquoted field, or text after a closing
 * quote, is kept as written. Only a quoted field that never closes is an error.
 */
export function parseCsv(text: string): string[][] {
  const input = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < input.length) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i += 1;
    } else if (ch === ',') {
      endField();
      i += 1;
    } else if (ch === '\r' || ch === '\n') {
      endRow();
      i += ch === '\r' && input[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i += 1;
    }
  }

  if (quoted) throw new Error('unterminated quoted field');
  // The last record has no line break after it, unless the text ended with one.
  const endedWithLineBreak = input.endsWith('\n') || input.endsWith('\r');
  if (input.length > 0 && !endedWithLineBreak) endRow();
  return rows;
}

/**
 * Turns parsed rows into objects keyed by the first row (the header, trimmed). A row shorter than the
 * header gets empty strings; a blank line (one empty field) is skipped.
 */
export function csvRecords(rows: string[][]): { header: string[]; records: Record<string, string>[] } {
  if (rows.length === 0) return { header: [], records: [] };
  const header = rows[0].map((name) => name.trim());
  const records: Record<string, string>[] = [];
  for (const row of rows.slice(1)) {
    if (row.length === 1 && row[0] === '') continue;
    const record: Record<string, string> = {};
    header.forEach((name, index) => {
      record[name] = row[index] ?? '';
    });
    records.push(record);
  }
  return { header, records };
}
