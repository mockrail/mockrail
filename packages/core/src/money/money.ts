import type { CurrencyCode } from './currency.js';

export interface Money {
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

export function money(amountMinor: bigint | number, currency: CurrencyCode): Money {
  const minor = typeof amountMinor === 'bigint' ? amountMinor : BigInt(amountMinor);
  return { amountMinor: minor, currency };
}

export function zero(currency: CurrencyCode): Money {
  return { amountMinor: 0n, currency };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor === b.amountMinor) return 0;
  return a.amountMinor < b.amountMinor ? -1 : 1;
}

export function isPositive(value: Money): boolean {
  return value.amountMinor > 0n;
}

export function minMoney(a: Money, b: Money): Money {
  return compareMoney(a, b) <= 0 ? a : b;
}
