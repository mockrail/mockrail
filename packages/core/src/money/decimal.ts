import { CURRENCY_EXPONENT, type CurrencyCode } from './currency.js';

/**
 * Parses a major-unit decimal ("29.00", "1500", 12.5) into minor units.
 * Returns null when the value is not a valid amount for the currency.
 */
export function parseDecimal(value: unknown, currency: CurrencyCode): bigint | null {
  const exponent = CURRENCY_EXPONENT[currency];
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    text = value.toFixed(exponent);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    return null;
  }
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const [, sign, whole = '0', fraction = ''] = match;
  if (fraction.length > exponent) return null;
  const minor = BigInt(whole + fraction.padEnd(exponent, '0'));
  return sign ? -minor : minor;
}

/** Formats minor units as a major-unit decimal string with the currency's precision ("29.00"). */
export function formatDecimal(amountMinor: bigint, currency: CurrencyCode): string {
  const exponent = CURRENCY_EXPONENT[currency];
  const negative = amountMinor < 0n;
  const digits = (negative ? -amountMinor : amountMinor).toString().padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  return `${negative ? '-' : ''}${whole}${exponent > 0 ? `.${fraction}` : ''}`;
}
