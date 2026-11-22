import { CURRENCY_EXPONENT, formatDecimal, isCurrencyCode, parseDecimal, type CurrencyCode, type Money } from '@mockrail/core';
import { SANDBOX_USD_RATES } from './constants.js';

/**
 * Bachs money is a decimal string in the major unit with two decimal places ("29.00"), even for
 * currencies whose ISO minor unit is zero (API standards).
 */
export function formatAmount(value: Money): string {
  const exponent = CURRENCY_EXPONENT[value.currency];
  if (exponent === 2) return formatDecimal(value.amountMinor, value.currency);
  const major = Number(value.amountMinor) / 10 ** exponent;
  return major.toFixed(2);
}

export function formatAmountOrNull(value: Money | null | undefined): string | null {
  return value ? formatAmount(value) : null;
}

/** Parses a Bachs amount into core minor units; null when invalid for the currency. */
export function parseAmount(value: unknown, currency: CurrencyCode): bigint | null {
  const exponent = CURRENCY_EXPONENT[currency];
  if (exponent === 2) return parseDecimal(value, currency);
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  if (match[2] && Number(match[2]) !== 0) return null;
  return BigInt(match[1] as string);
}

export function toCurrency(value: string | undefined | null): CurrencyCode | null {
  const upper = value?.toUpperCase();
  return isCurrencyCode(upper) ? upper : null;
}

/** Converts using the sandbox's fixed rates. */
export function convert(amount: Money, to: CurrencyCode): Money {
  if (amount.currency === to) return amount;
  const fromRate = SANDBOX_USD_RATES[amount.currency] ?? 1;
  const toRate = SANDBOX_USD_RATES[to] ?? 1;
  const major = Number(amount.amountMinor) / 10 ** CURRENCY_EXPONENT[amount.currency];
  const converted = (major / fromRate) * toRate;
  return { amountMinor: BigInt(Math.round(converted * 10 ** CURRENCY_EXPONENT[to])), currency: to };
}

export function exchangeRate(from: CurrencyCode, to: CurrencyCode): string {
  const rate = (SANDBOX_USD_RATES[to] ?? 1) / (SANDBOX_USD_RATES[from] ?? 1);
  return rate >= 1 ? rate.toFixed(2) : rate.toFixed(6);
}

/** ISO timestamp with microseconds and +00:00, the form the docs use on event envelopes. */
export function isoMicro(iso: string): string {
  return iso.replace(/\.(\d{3})Z$/, '.$1000+00:00').replace(/Z$/, '.000000+00:00');
}
