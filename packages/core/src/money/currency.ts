export type CurrencyCode = 'NGN' | 'USD' | 'GHS' | 'KES' | 'ZAR' | 'MWK' | 'RWF' | 'TZS' | 'UGX' | 'XAF' | 'XOF' | 'ZMW' | 'GBP' | 'EUR' | 'CAD';

export const SUPPORTED_CURRENCIES: readonly CurrencyCode[] = ['NGN', 'USD', 'GHS', 'KES', 'ZAR', 'MWK', 'RWF', 'TZS', 'UGX', 'XAF', 'XOF', 'ZMW', 'GBP', 'EUR', 'CAD'];

/** ISO 4217 minor-unit digits. Adapters decide how amounts appear on the wire. */
export const CURRENCY_EXPONENT: Readonly<Record<CurrencyCode, number>> = {
  NGN: 2,
  USD: 2,
  GHS: 2,
  KES: 2,
  ZAR: 2,
  MWK: 2,
  RWF: 0,
  TZS: 2,
  UGX: 0,
  XAF: 0,
  XOF: 0,
  ZMW: 2,
  GBP: 2,
  EUR: 2,
  CAD: 2,
};

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}
