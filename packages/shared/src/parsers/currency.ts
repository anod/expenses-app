import type { WorkbookCurrency } from '../contracts/types.js';

const ISO_BY_SYMBOL: Record<string, { code: string; symbol: string }> = {
  '₪': { code: 'ILS', symbol: '₪' },
  '$': { code: 'USD', symbol: '$' },
  '€': { code: 'EUR', symbol: '€' },
  '£': { code: 'GBP', symbol: '£' },
  '₽': { code: 'RUB', symbol: '₽' },
  '¥': { code: 'JPY', symbol: '¥' },
};

const ISO_BY_CODE: Record<string, string> = {
  ILS: '₪', USD: '$', EUR: '€', GBP: '£', RUB: '₽', JPY: '¥',
};

/**
 * Parse an Excel numberFormat string like
 *   "[$₪-he-IL] #,##0;[Red][$₪-he-IL] -#,##0"
 * into a WorkbookCurrency. Returns nulls if no currency segment is present.
 */
export function parseCurrencyFormat(format: string | null | undefined): WorkbookCurrency {
  const empty: WorkbookCurrency = { code: null, symbol: null, locale: null, rawFormat: format ?? null };
  if (!format) return empty;

  // The currency segment looks like "[$<symbol-or-code>-<locale>]" or "[$<symbol-or-code>]"
  const m = format.match(/\[\$([^\]\-]+)(?:-([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*))?\]/);
  if (!m) return empty;

  const token = (m[1] ?? '').trim();
  const locale = (m[2] ?? null) as string | null;

  let code: string | null = null;
  let symbol: string | null = null;

  if (ISO_BY_SYMBOL[token]) {
    code = ISO_BY_SYMBOL[token]!.code;
    symbol = ISO_BY_SYMBOL[token]!.symbol;
  } else if (/^[A-Za-z]{3}$/.test(token)) {
    code = token.toUpperCase();
    symbol = ISO_BY_CODE[code] ?? null;
  } else {
    symbol = token || null;
  }

  return { code, symbol, locale, rawFormat: format };
}
