import { describe, expect, it } from 'vitest';
import { csvRecords, parseCsv } from './csv';

describe('parseCsv', () => {
  it('splits plain rows on commas and line feeds', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('accepts CRLF line endings and ignores one trailing newline', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps commas, doubled quotes and line breaks inside quoted fields', () => {
    expect(parseCsv('name,bio\r\n"Doe, Jane","She said ""hi""\r\nand left\nagain"\r\n')).toEqual([
      ['name', 'bio'],
      ['Doe, Jane', 'She said "hi"\r\nand left\nagain'],
    ]);
  });

  it('strips a byte order mark at the start', () => {
    expect(parseCsv('\uFEFFa,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps empty fields, including a trailing one and an empty quoted one', () => {
    expect(parseCsv('a,,c,\n"",x,,')).toEqual([
      ['a', '', 'c', ''],
      ['', 'x', '', ''],
    ]);
  });

  it('returns no rows for an empty text', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\uFEFF')).toEqual([]);
  });

  it('throws on a quoted field that never closes', () => {
    expect(() => parseCsv('a,"b\n1,2')).toThrow('unterminated quoted field');
  });
});

describe('csvRecords', () => {
  it('keys each row by the trimmed header, with missing fields as empty strings', () => {
    expect(
      csvRecords([
        [' name ', 'linkedin'],
        ['Jane', 'linkedin.com/in/jane'],
        ['John'],
      ]),
    ).toEqual({
      header: ['name', 'linkedin'],
      records: [
        { name: 'Jane', linkedin: 'linkedin.com/in/jane' },
        { name: 'John', linkedin: '' },
      ],
    });
  });

  it('skips blank lines', () => {
    expect(csvRecords(parseCsv('a,b\n\n1,2\n\n')).records).toEqual([{ a: '1', b: '2' }]);
  });

  it('gives no header and no records for no rows', () => {
    expect(csvRecords([])).toEqual({ header: [], records: [] });
  });
});
