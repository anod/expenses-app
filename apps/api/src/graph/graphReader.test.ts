import { describe, expect, it } from 'vitest';
import { encodeWorksheetName } from './graphReader.js';

describe('encodeWorksheetName', () => {
  it('passes through ASCII names', () => {
    expect(encodeWorksheetName('Sheet1')).toBe('Sheet1');
  });

  it('doubles single quotes for OData (quotes are not percent-encoded)', () => {
    // ' -> '' ; encodeURIComponent leaves apostrophes alone (RFC 3986 unreserved)
    expect(encodeWorksheetName("Bob's Sheet")).toBe("Bob''s%20Sheet");
  });

  it('encodes unicode worksheet names', () => {
    expect(encodeWorksheetName('Лист 1')).toBe('%D0%9B%D0%B8%D1%81%D1%82%201');
  });

  it('handles names ending with a single quote', () => {
    expect(encodeWorksheetName("A'")).toBe("A''");
  });
});
