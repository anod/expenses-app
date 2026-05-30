import { describe, expect, it } from 'vitest';
import { errorMessage, SERVER_UNREACHABLE_MESSAGE } from './api-error';

describe('errorMessage', () => {
  it('uses a specific message for unreachable server responses', () => {
    expect(errorMessage({ status: 0, statusText: 'Unknown Error' })).toBe(SERVER_UNREACHABLE_MESSAGE);
  });

  it('extracts API messages instead of rendering object values', () => {
    expect(errorMessage({ error: { message: 'Workbook is not configured' } })).toBe(
      'Workbook is not configured',
    );
    expect(errorMessage({ error: { error: { message: 'Nested API error' } } })).toBe(
      'Nested API error',
    );
  });
});
