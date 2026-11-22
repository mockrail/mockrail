import type { RecurringInterval } from '../catalog/products.js';

/**
 * Provider policy for failed renewals, passed in by the adapter when the subscription is created.
 * `retryDelaysMs[i]` is the wait after failure number i+1; once retries run out the subscription
 * is canceled, or kept as unpaid.
 */
export interface BillingPolicy {
  readonly retryDelaysMs: readonly number[];
  readonly exhaustedAction: 'cancel' | 'unpaid';
}

export const DEFAULT_BILLING_POLICY: BillingPolicy = {
  retryDelaysMs: [86_400_000, 3 * 86_400_000, 5 * 86_400_000],
  exhaustedAction: 'cancel',
};

/** Delay before the next retry after `failures` consecutive failed attempts, or null when exhausted. */
export function nextRetryDelay(policy: BillingPolicy, failures: number): number | null {
  const delay = policy.retryDelaysMs[failures - 1];
  return delay === undefined ? null : delay;
}

/** Adds a billing interval in UTC, clamping month-end dates (Jan 31 + 1 month = Feb 28/29). */
export function addInterval(from: Date, interval: RecurringInterval, count: number): Date {
  const date = new Date(from.getTime());
  switch (interval) {
    case 'day':
      date.setUTCDate(date.getUTCDate() + count);
      return date;
    case 'week':
      date.setUTCDate(date.getUTCDate() + 7 * count);
      return date;
    case 'month':
    case 'year': {
      const months = interval === 'year' ? 12 * count : count;
      const day = date.getUTCDate();
      date.setUTCDate(1);
      date.setUTCMonth(date.getUTCMonth() + months);
      const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      date.setUTCDate(Math.min(day, lastDay));
      return date;
    }
  }
}
