export type CurrencyCode = 'NGN' | 'USD' | 'GHS' | 'KES' | 'ZAR';

export const SUPPORTED_CURRENCIES: readonly CurrencyCode[] = ['NGN', 'USD', 'GHS', 'KES', 'ZAR'];

/** Number of minor-unit digits per currency (kobo, cents, pesewas...). */
export const CURRENCY_EXPONENT: Readonly<Record<CurrencyCode, number>> = {
  NGN: 2,
  USD: 2,
  GHS: 2,
  KES: 2,
  ZAR: 2,
};

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}
