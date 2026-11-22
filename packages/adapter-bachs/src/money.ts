import { formatDecimal, money, type Money } from '@mockrail/core';

/** Bachs sends money as a decimal string in the major unit with two decimal places, e.g. "29.00". */
export function formatAmount(value: Money): string {
  return formatDecimal(value.amountMinor, value.currency);
}

export function formatAmountOrNull(value: Money | null | undefined): string | null {
  return value ? formatAmount(value) : null;
}

/** Free checkouts show "0" for the amount (discrepancy #7). */
export function formatCheckoutAmount(value: Money): string {
  return value.amountMinor === 0n ? '0' : formatAmount(value);
}

export { money };
